/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Onion routing, phase 4: the window side.
 *
 * A Tor space and a Tor window are the same container predicate with
 * different lifetimes, so the only per-lifetime code here is allocating and
 * destroying the window's container. Everything else - the markings, the card
 * - reads the same registry the proxy filter reads.
 *
 * The two states are marked differently on purpose: a purple frame down the
 * tab strip for a space, an amber ring around the content for a window. They
 * must be distinguishable without remembering which one you opened. */

const { ZenTorProxy } = ChromeUtils.importESModule(
  "resource:///modules/zen/tor/ZenTorProxy.sys.mjs"
);
const { ContextualIdentityService } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs"
);

/* SOCKS5 greeting: version 5, one method offered, "no authentication". A
   server that speaks SOCKS answers with its own version byte; anything else
   listening on the port does not, which is the whole point of sending it. */
const SOCKS5_GREETING = "\x05\x01\x00";
const PROBE_TIMEOUT_S = 4;
const PROBE_INTERVAL_MS = 30000;

/* A real CustomizableUI widget, not a node we place ourselves: it has to drag
   between the toolbar, the rail and the overflow menu like a pinned extension,
   and persist where it was dropped. */
const WIDGET_ID = "zen-tor-status-button";

window.gZenTor = {
  _windowContextId: null,
  /* Last marking and last card payload pushed, so a repeated event is a no-op. */
  _lastMarking: null,
  _lastCard: null,
  /* Browsers with a top-level document load in flight in a routed container.
     This, and nothing else, is what "connecting" means here - there is no Tor
     control port to ask for real bootstrap progress. */
  _inflight: new Set(),
  /* null until the first probe answers: unknown, not unreachable. */
  _reach: null,
  _probing: false,
  _probeStamp: 0,

  /* Claimed at script-evaluation time, not on init: the tabbrowser asks for a
     container id while the window is still being built, long before any
     DOMContentLoaded handler would have run. */
  claim() {
    ZenTorProxy.init();
    const id = ZenTorProxy.takePendingWindowContext();
    if (id) {
      this._windowContextId = id;
      window.addEventListener("unload", () => this._teardown(), { once: true });
    }
  },

  get isTorWindow() {
    return this._windowContextId !== null;
  },

  get windowContextId() {
    return this._windowContextId;
  },

  init() {
    if (this._inited) {
      return;
    }
    this._inited = true;
    for (const event of ["TabSelect", "TabAttrModified", "TabOpen"]) {
      window.addEventListener(event, () => this._update());
    }
    Services.prefs.addObserver("zen.tor.", this);
    this._registerWidget();
    this._watchLoads();
    /* Nothing else wakes an idle window, and reachability can change under it
       - tor stopping, the port moving - so the status would go stale. */
    const beat = setInterval(() => this._update(), PROBE_INTERVAL_MS);
    window.addEventListener("unload", () => clearInterval(beat), { once: true });
    this._update();
  },

  observe(subject, topic, data) {
    // A different proxy is a different question; the old answer is not it.
    if (data !== "zen.tor.space-containers") {
      this._reach = null;
      this._probeStamp = 0;
    }
    this._update();
  },

  // ---- lifetimes ---------------------------------------------------------

  /* A Tor window: a container made now and destroyed with the window. The
     window claims it synchronously as it starts, so its very first tab is
     already in the container the filter routes. */
  openTorWindow() {
    const identity = ContextualIdentityService.create(
      ZenTorProxy.WINDOW_CONTAINER_PREFIX + Date.now(),
      "fingerprint",
      "purple"
    );
    ZenTorProxy.addWindowContext(identity.userContextId);
    ZenTorProxy.pendingWindowContext = identity.userContextId;
    const win = window.OpenBrowserWindow();
    if (!win) {
      // Nothing will claim it; do not leave a routed container behind.
      ZenTorProxy.pendingWindowContext = null;
      ZenTorProxy.removeWindowContext(identity.userContextId);
      ContextualIdentityService.remove(identity.userContextId);
    }
    return win;
  },

  _teardown() {
    const id = this._windowContextId;
    if (id === null) {
      return;
    }
    this._windowContextId = null;
    // Unregister first: whatever survives the window must not still be routed
    // to a container that no longer exists.
    ZenTorProxy.removeWindowContext(id);
    try {
      ContextualIdentityService.remove(id);
    } catch (ex) {
      console.error("[zen-tor] could not remove ephemeral container", ex);
    }
  },

  /* A Tor space: the space's own container, marked permanently. A space with
     no container of its own gets one, because container 0 is shared with
     every direct tab in the browser and cannot be routed on its own. */
  toggleSpaceRouting() {
    const manager = window.gZenWorkspaces;
    const space = manager?.getActiveWorkspaceFromCache?.();
    if (!space) {
      return null;
    }
    let id = space.containerTabId;
    if (ZenTorProxy.isTorContext(id)) {
      ZenTorProxy.setSpaceRouted(id, false);
      this._update();
      return false;
    }
    if (!(id > 0)) {
      id = ContextualIdentityService.create(
        space.name ? "Tor \u00b7 " + space.name : "Tor space",
        "fingerprint",
        "purple"
      ).userContextId;
      space.containerTabId = id;
      manager.saveWorkspace(space);
    }
    ZenTorProxy.setSpaceRouted(id, true);
    this._update();
    return true;
  },

  // ---- markings ----------------------------------------------------------

  /* Which of the two states this window is showing right now, if either. */
  get state() {
    if (this.isTorWindow) {
      return "window";
    }
    const id = parseInt(
      gBrowser?.selectedTab?.getAttribute("usercontextid") || "0",
      10
    );
    return ZenTorProxy.isTorContext(id) ? "space" : null;
  },

  /* What the onion shows. Derived, never stored: the same registry the frame
     and the card read, plus the two things only this window knows - whether a
     routed load is in flight, and whether the proxy answered the last probe. */
  get status() {
    if (!this.state) {
      return "off";
    }
    if (!ZenTorProxy.enabled || this._reach === false) {
      return "unreachable";
    }
    // Unknown reachability is a route still being established, not a state of
    // its own: the probe below is out and the icon says so.
    return this._inflight.size || this._reach === null ? "connecting" : "connected";
  },

  // ---- the widget --------------------------------------------------------

  /* Registered once for the application; CustomizableUI builds an instance in
     every window, now and later, and remembers wherever the user drags it. */
  _registerWidget() {
    if (CustomizableUI.getWidget(WIDGET_ID)?.provider === CustomizableUI.PROVIDER_API) {
      return;
    }
    try {
      CustomizableUI.createWidget({
        id: WIDGET_ID,
        type: "custom",
        l10nId: WIDGET_ID,
        defaultArea: CustomizableUI.AREA_NAVBAR,
        onBuild(doc) {
          const button = doc.createXULElement("toolbarbutton");
          button.id = WIDGET_ID;
          button.className = "toolbarbutton-1 chromeclass-toolbar-additional";
          doc.l10n.setAttributes(button, WIDGET_ID);
          button.setAttribute("removable", "true");
          button.addEventListener("command", () =>
            doc.defaultView.gZenTor?.onWidgetCommand()
          );
          return button;
        },
      });
    } catch (ex) {
      console.error("[zen-tor] could not register the status widget", ex);
    }
  },

  onWidgetCommand() {
    window.gZenTorPanel?.toggle();
  },

  // true, false, or null for not asked yet.
  get reachable() {
    return this._reach;
  },

  // Unlike _maybeProbe, asks even when this window is not routed.
  probeNow() {
    if (!this._probing && Date.now() - this._probeStamp >= PROBE_INTERVAL_MS) {
      this._probe();
    }
  },

  _describe(state, status) {
    const where = `${ZenTorProxy.host}:${ZenTorProxy.port}`;
    const lead = state === "window" ? "Tor window" : state === "space" ? "Tor space" : "Tor";
    return {
      off: "Not routed through Tor",
      connecting: `${lead} · reaching ${where}`,
      connected: `${lead} · routed via ${where}`,
      unreachable: ZenTorProxy.enabled
        ? `${lead} · nothing answering on ${where}`
        : `${lead} · routing is switched off`,
    }[status];
  },

  // ---- connecting --------------------------------------------------------

  _watchLoads() {
    const listener = {
      onStateChange: (browser, progress, request, flags) =>
        this._onLoadState(browser, progress, flags),
      // Covers same-document and anchor navigation too, which STATE_START
      // never fires for - the onion badge needs the host on every one of them.
      onLocationChange: (browser, progress) => {
        if (progress?.isTopLevel && browser === gBrowser.selectedBrowser) {
          this._update();
        }
      },
    };
    gBrowser.addTabsProgressListener(listener);
    window.addEventListener("TabClose", event => {
      if (this._inflight.delete(event.target.linkedBrowser)) {
        this._update();
      }
    });
    window.addEventListener(
      "unload",
      () => gBrowser.removeTabsProgressListener(listener),
      { once: true }
    );
  },

  _onLoadState(browser, progress, flags) {
    const listener = Ci.nsIWebProgressListener;
    if (!(flags & listener.STATE_IS_NETWORK) || !progress?.isTopLevel) {
      return;
    }
    const tab = gBrowser.getTabForBrowser(browser);
    /* In a Tor window every tab is routed whether or not it carries the
       attribute, which is what `state` already reports for the window. */
    const id =
      this._windowContextId ??
      parseInt(tab?.getAttribute("usercontextid") || "0", 10);
    const before = this._inflight.size;
    if (flags & listener.STATE_START) {
      if (ZenTorProxy.isTorContext(id)) {
        this._inflight.add(browser);
      }
    } else if (flags & listener.STATE_STOP) {
      this._inflight.delete(browser);
    }
    if (this._inflight.size !== before) {
      this._update();
    }
  },

  // ---- reachability ------------------------------------------------------

  _maybeProbe() {
    if (this._probing || !this.state || !ZenTorProxy.enabled) {
      return;
    }
    ZenTorProxy.ensureDaemon();
    if (Date.now() - this._probeStamp < PROBE_INTERVAL_MS) {
      return;
    }
    this._probe();
  },

  /* Asked of the proxy rather than assumed from the pref: open the SOCKS port
     and speak to it. Nothing here goes through the filter - a raw transport
     with no proxyInfo - so the probe cannot be routed through what it tests. */
  _probe() {
    this._probing = true;
    this._probeStamp = Date.now();
    let transport = null;
    let settled = false;
    const finish = reachable => {
      if (settled || window.closed) {
        return;
      }
      settled = true;
      this._probing = false;
      this._probeStamp = Date.now();
      try {
        transport?.close(Cr.NS_OK);
      } catch {}
      if (this._reach !== reachable) {
        this._reach = reachable;
        this._update();
      }
    };
    try {
      const service = Cc[
        "@mozilla.org/network/socket-transport-service;1"
      ].getService(Ci.nsISocketTransportService);
      transport = service.createTransport(
        [],
        ZenTorProxy.host,
        ZenTorProxy.port,
        null,
        null
      );
      transport.setTimeout(Ci.nsISocketTransport.TIMEOUT_CONNECT, PROBE_TIMEOUT_S);
      transport.setTimeout(
        Ci.nsISocketTransport.TIMEOUT_READ_WRITE,
        PROBE_TIMEOUT_S
      );
      const target = Services.tm.mainThread;
      const output = transport
        .openOutputStream(Ci.nsITransport.OPEN_UNBUFFERED, 0, 0)
        .QueryInterface(Ci.nsIAsyncOutputStream);
      const input = transport
        .openInputStream(0, 0, 0)
        .QueryInterface(Ci.nsIAsyncInputStream);
      output.asyncWait(
        {
          onOutputStreamReady(stream) {
            // A refused connection surfaces here, as a throw from the write.
            try {
              stream.write(SOCKS5_GREETING, SOCKS5_GREETING.length);
            } catch {
              finish(false);
              return;
            }
            input.asyncWait(
              {
                onInputStreamReady(ready) {
                  let reply = "";
                  try {
                    const scriptable = Cc[
                      "@mozilla.org/scriptableinputstream;1"
                    ].createInstance(Ci.nsIScriptableInputStream);
                    scriptable.init(ready);
                    reply = scriptable.read(2);
                  } catch {
                    finish(false);
                    return;
                  }
                  finish(reply.charCodeAt(0) === 5);
                },
              },
              0,
              0,
              target
            );
          },
        },
        0,
        0,
        target
      );
    } catch (ex) {
      console.error("[zen-tor] could not probe the proxy", ex);
      finish(false);
      return;
    }
    setTimeout(() => finish(false), PROBE_TIMEOUT_S * 1000 + 500);
  },

  /* Colours for the tab focus effect, read by ZenTabFocus before its own
     per-tab and per-site colours: a routed tab must not be paintable as an
     ordinary one. */
  focusColor(tab, which) {
    const id = parseInt(tab?.getAttribute("usercontextid") || "0", 10);
    if (!ZenTorProxy.isTorContext(id)) {
      return null;
    }
    const window_ = id === this._windowContextId;
    return window_
      ? which === "a" ? "#e8a33d" : "#ffd89b"
      : which === "a" ? "#7d4698" : "#b98fd0";
  },

  // ---- the identity-box badge --------------------------------------------

  /* Host-only, independent of routing: a clearnet site stays unbadged even in
     a Tor space or window, because "routed" is the panel's story, not this
     one's. */
  get _onionHost() {
    try {
      const host = gBrowser.selectedBrowser.currentURI?.host;
      return /\.onion$/i.test(host || "") ? host : null;
    } catch {
      return null;
    }
  },

  /* Inserted once per window next to the identity icon, the same way
     ZenSiteDataPanel adds its own button - no XHTML patch needed. */
  _identityBadge() {
    let badge = document.getElementById("zen-tor-identity-onion");
    if (!badge) {
      const anchor = document.getElementById("identity-icon-box");
      if (!anchor) {
        return null;
      }
      badge = document.createXULElement("image");
      badge.id = "zen-tor-identity-onion";
      document.l10n.setAttributes(badge, "zen-tor-identity-onion");
      anchor.after(badge);
    }
    return badge;
  },

  /* One overlay, parented to the window root rather than to any Zen element,
     so a sidebar or toolbar rearrangement cannot hide the marking. */
  _marker() {
    let marker = document.getElementById("zen-tor-marker");
    if (!marker) {
      const ns = "http://www.w3.org/1999/xhtml";
      marker = document.createElementNS(ns, "div");
      marker.id = "zen-tor-marker";
      const frame = document.createElementNS(ns, "div");
      frame.className = "zen-tor-frame";
      const pill = document.createElementNS(ns, "div");
      pill.className = "zen-tor-pill";
      marker.append(frame, pill);
      document.documentElement.append(marker);
    }
    return marker;
  },

  /* Driven by TabAttrModified among others, which fires several times a second
     on a loading tab, so every side effect here is gated on the marking having
     actually changed - the layer re-measure below forces layout. */
  _update() {
    const state = this.state;
    this._maybeProbe();
    const status = this.status;
    const marking = `${state}/${status}`;
    if (marking !== this._lastMarking) {
      this._lastMarking = marking;
      const root = document.documentElement;
      const name =
        state === "window" ? "Tor window" : state === "space" ? "Tor space" : "";
      this._marker().querySelector(".zen-tor-pill").textContent = name
        ? name + (status === "unreachable" ? this._offReason() : "")
        : "";
      if (state) {
        root.setAttribute("zen-tor", state);
      } else {
        root.removeAttribute("zen-tor");
      }
      root.setAttribute("zen-tor-status", status);
      root.toggleAttribute("zen-tor-unreachable", status === "unreachable");
      // The shape carries the state and the tooltip says it in words; the
      // widget's own colours come from the two root attributes above.
      document
        .getElementById(WIDGET_ID)
        ?.setAttribute("tooltiptext", this._describe(state, status));
      window.gZenTabFocus?._trackSelected?.();
    }
    this._identityBadge()?.toggleAttribute("hidden", !this._onionHost);
    this._card(state, status);
    window.gZenTorPanel?.refresh();
  },

  /* Two ways to be unreachable, and they need different answers from the
     user: turn the setting on, or start the proxy. */
  _offReason() {
    return ZenTorProxy.enabled ? " · unreachable" : " · off";
  },

  /* The status card says in words which of the two states this is, so the
     colour is never the only carrier.
     Pushed only when the payload actually changes: setWindowCard rebuilds the
     card element, replaying its entry animation, so an identical re-push reads
     as the card reloading. TabAttrModified alone fires several times a second
     on a loading tab. */
  _card(state, status) {
    const cards = window.gZenPageCards;
    if (!cards?.setWindowCard) {
      return;
    }
    if (!state) {
      if (this._lastCard !== null) {
        this._lastCard = null;
        cards.clearWindowCard("zen-tor");
      }
      return;
    }
    const where = `${ZenTorProxy.host}:${ZenTorProxy.port}`;
    const route = {
      connected: {
        label: "Routed",
        detail: `Via ${where}, never direct.`,
        status: "on",
      },
      connecting: {
        label: "Connecting",
        detail: `Reaching ${where}.`,
        status: "on",
      },
      unreachable: ZenTorProxy.enabled
        ? {
            label: "Proxy unreachable",
            detail: `Nothing is answering SOCKS on ${where}.`,
            status: "off",
          }
        : {
            label: "Not routed",
            detail: "Nothing loads here until zen.tor.enabled is on.",
            status: "off",
          },
    }[status];
    const card = {
      id: "zen-tor",
      // One quiet row until asked: the marking already says this is Tor.
      collapsed: true,
      title: state === "window" ? "Tor window" : "Tor space",
      subtitle:
        state === "window"
          ? "Nothing here is kept when the window closes."
          : "This space remembers you across restarts.",
      accent: state === "window" ? "#e8a33d" : "#7d4698",
      items: [
        { key: "route", icon: "●", ...route },
        {
          key: "limits",
          icon: "⚠",
          label: "Not anonymity",
          detail: "Hides your IP, not this browser's fingerprint.",
        },
      ],
    };
    const key = JSON.stringify(card);
    if (key === this._lastCard) {
      return;
    }
    this._lastCard = key;
    cards.setWindowCard(card);
  },
};

gZenTor.claim();
window.addEventListener("MozAfterPaint", () => gZenTor.init(), { once: true });
