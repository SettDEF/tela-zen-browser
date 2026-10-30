/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Onion routing, phase 5: the panel behind the onion, modelled on Tor
 * Browser's circuit panel. Over SOCKS alone the path is unknowable, so the
 * circuit section is absent - not greyed, not filled with plausible relays. */

const { ZenTorProxy } = ChromeUtils.importESModule(
  "resource:///modules/zen/tor/ZenTorProxy.sys.mjs"
);
const { ZenTorControl } = ChromeUtils.importESModule(
  "resource:///modules/zen/tor/ZenTorControl.sys.mjs"
);
const { ZenTorDaemon } = ChromeUtils.importESModule(
  "resource:///modules/zen/tor/ZenTorDaemon.sys.mjs"
);
const { ContextualIdentityService } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs"
);

const HTML = "http://www.w3.org/1999/xhtml";
const PANEL_ID = "zen-tor-panel";
const WIDGET_ID = "zen-tor-status-button";
const PREF_BRIDGES_ENABLED = "zen.tor.bridges.enabled";

/* One [value id, tip id] pair per ZenTorDaemon.lastError code. Both are
   static FTL strings - the code alone says enough, and the detail string on
   lastError is for the console, never bound into the panel. */
const DAEMON_FAILURE = {
  "no-binary": [
    "zen-tor-panel-value-instance-failed-no-binary",
    "zen-tor-panel-tip-instance-failed-no-binary",
  ],
  "data-dir": [
    "zen-tor-panel-value-instance-failed-data-dir",
    "zen-tor-panel-tip-instance-failed-data-dir",
  ],
  spawn: [
    "zen-tor-panel-value-instance-failed-spawn",
    "zen-tor-panel-tip-instance-failed-spawn",
  ],
  "no-control-port": [
    "zen-tor-panel-value-instance-failed-no-control-port",
    "zen-tor-panel-tip-instance-failed-no-control-port",
  ],
  "bad-bridge-line": [
    "zen-tor-panel-value-instance-failed-bridges",
    "zen-tor-panel-tip-instance-failed-bridges",
  ],
  "no-transport": [
    "zen-tor-panel-value-instance-failed-bridges",
    "zen-tor-panel-tip-instance-failed-bridges",
  ],
};

window.gZenTorPanel = {
  // Bumped per render, so a late control-port answer is dropped, not drawn.
  _generation: 0,
  // Percent while tor is still bootstrapping, null once it is done.
  _bootstrap: null,

  get panel() {
    return document.getElementById(PANEL_ID);
  },

  // Asks the widget rather than re-deriving the rule: the layout preset owns
  // which states hide it, and there is no way in without the button.
  get _hidden() {
    return !!document.getElementById(WIDGET_ID)?.hasAttribute("zen-preset-hidden");
  },

  toggle() {
    const panel = this.panel;
    if (!panel || this._hidden) {
      return;
    }
    if (panel.state === "open" || panel.state === "showing") {
      panel.hidePopup();
      return;
    }
    this._bind(panel);
    this._render(true);
    const anchor =
      document.getElementById(WIDGET_ID) ||
      document.getElementById("nav-bar") ||
      document.documentElement;
    panel.openPopup(anchor, "bottomright topright", 0, 4, false, false);
  },

  // The probe and the load state both land after the panel is already up.
  refresh() {
    if (this.panel?.state !== "open") {
      return;
    }
    if (this._hidden) {
      this.panel.hidePopup();
      return;
    }
    this._render();
  },

  _bind(panel) {
    if (panel._zenTorBound) {
      return;
    }
    panel._zenTorBound = true;
    const on = (id, handler) =>
      document.getElementById(id)?.addEventListener("command", handler);
    on("zen-tor-panel-new-circuit", () => this._newCircuit());
    on("zen-tor-panel-toggle-space", () => {
      window.gZenTor?.toggleSpaceRouting();
      this._render(true);
    });
    on("zen-tor-panel-tor-window", () => {
      panel.hidePopup();
      window.gZenTor?.openTorWindow();
    });
    panel.addEventListener("popuphidden", () =>
      document.getElementById("zen-tor-panel-route")?.removeAttribute("data-flow")
    );
    on("zen-tor-panel-settings", () => {
      panel.hidePopup();
      window.openTrustedLinkIn("about:preferences#zen-tab-management", "tab");
    });
  },

  // ---- what this window actually knows ------------------------------------

  get _uri() {
    try {
      return gBrowser.selectedBrowser.currentURI;
    } catch {
      return null;
    }
  },

  /* chrome://browser has a "host" of "browser"; only web schemes name a site. */
  get _host() {
    const uri = this._uri;
    try {
      return /^(https?|ftp|wss?)$/.test(uri?.scheme) ? uri.host : "";
    } catch {
      return "";
    }
  },

  get _isOnion() {
    return /\.onion$/i.test(this._host);
  },

  // A Tor window routes every tab it holds, attribute or not.
  get _contextId() {
    if (window.gZenTor?.isTorWindow) {
      return window.gZenTor.windowContextId;
    }
    return parseInt(
      gBrowser?.selectedTab?.getAttribute("usercontextid") || "0",
      10
    );
  },

  _containerName(id) {
    try {
      const identity = ContextualIdentityService.getPublicIdentityFromId(id);
      return identity
        ? ContextualIdentityService.getUserContextLabel(id) || identity.name
        : null;
    } catch {
      return null;
    }
  },

  // ---- rendering -----------------------------------------------------------

  _render(force) {
    const generation = ++this._generation;
    const tor = window.gZenTor;
    const state = tor?.state ?? null;
    tor?.probeNow();
    const status = tor?.status ?? "off";
    const host = this._host;

    const site = document.getElementById("zen-tor-panel-site");
    if (host) {
      site.removeAttribute("data-l10n-id");
      site.removeAttribute("data-l10n-args");
      site.textContent = host;
    } else {
      document.l10n.setAttributes(site, "zen-tor-panel-no-site");
    }
    document
      .getElementById("zen-tor-panel-onion")
      .setAttribute("data-state", state ? status : "off");

    this._renderFacts(state, status);
    this._renderActions();
    this._renderCircuit(generation, state, host, force);
  },

  _fact(labelId, value, tone, tipId) {
    const row = document.createElementNS(HTML, "div");
    row.className = "zen-tor-panel-fact";
    row.setAttribute("data-tone", tone);
    if (tipId) {
      document.l10n.setAttributes(row, tipId);
    }
    const dot = document.createElementNS(HTML, "span");
    dot.className = "zen-tor-panel-dot";
    const label = document.createElementNS(HTML, "span");
    label.className = "zen-tor-panel-fact-label";
    document.l10n.setAttributes(label, labelId);
    const text = document.createElementNS(HTML, "span");
    text.className = "zen-tor-panel-fact-value";
    if (value.id) {
      document.l10n.setAttributes(text, value.id, value.args);
    } else {
      text.textContent = value.text;
    }
    row.append(dot, label, text);
    return row;
  },

  /* Descriptors first, then one rebuild - and only when they actually differ.
     document.l10n.setAttributes lands a frame later, so a list rebuilt on every
     _render (TabAttrModified fires several times a second on a loading tab)
     blinks empty each time. */
  _renderFacts(state, status) {
    const rows = [];

    const connection = !state
      ? ["zen-tor-panel-value-direct", "none", "zen-tor-panel-tip-direct"]
      : status === "unreachable"
        ? ["zen-tor-panel-value-down", "bad", `zen-tor-panel-tip-${state}`]
        : status === "connecting"
          ? ["zen-tor-panel-value-connecting", "warn", `zen-tor-panel-tip-${state}`]
          : [`zen-tor-panel-value-${state}`, "ok", `zen-tor-panel-tip-${state}`];
    // A tor still building its first circuits must not read as "routed".
    rows.push(
      this._bootstrap === null || this._bootstrap === undefined
        ? {
            id: "zen-tor-panel-fact-connection",
            label: "zen-tor-panel-label-connection",
            value: { id: connection[0] },
            tone: connection[1],
            tip: connection[2],
          }
        : {
            id: "zen-tor-panel-fact-connection",
            label: "zen-tor-panel-label-connection",
            value: {
              id: "zen-tor-panel-value-bootstrapping",
              args: { percent: String(this._bootstrap) },
            },
            tone: "warn",
            tip: connection[2],
          }
    );

    const args = { endpoint: `${ZenTorProxy.host}:${ZenTorProxy.port}` };
    const reach = window.gZenTor?.reachable ?? null;
    const tip = ZenTorDaemon.running
      ? "zen-tor-panel-tip-proxy-own"
      : "zen-tor-panel-tip-proxy";
    const proxy = !ZenTorProxy.enabled
      ? ["zen-tor-panel-value-proxy-disabled", "warn", "zen-tor-panel-tip-proxy-disabled"]
      : reach === true
        ? ["zen-tor-panel-value-proxy-ok", "ok", tip]
        : reach === false
          ? ["zen-tor-panel-value-proxy-bad", "bad", tip]
          : ["zen-tor-panel-value-proxy-unchecked", "none", tip];
    rows.push({
      label: "zen-tor-panel-label-proxy",
      value: { id: proxy[0], args },
      tone: proxy[1],
      tip: proxy[2],
    });

    rows.push(this._instanceFact());
    const bridgesFact = this._bridgesFact();
    if (bridgesFact) {
      rows.push(bridgesFact);
    }

    if (this._isOnion) {
      rows.push({
        label: "zen-tor-panel-label-site",
        value: { id: "zen-tor-panel-value-onion" },
        tone: "ok",
        tip: "zen-tor-panel-tip-onion",
      });
    }

    const id = this._contextId;
    // The ephemeral container is named after the clock so a crashed session's
    // leftovers can be swept; that name is for us, not for the panel.
    const ephemeral = id > 0 && id === window.gZenTor?.windowContextId;
    const name = ephemeral || !(id > 0) ? null : this._containerName(id);
    const fallback = ephemeral
      ? ["zen-tor-panel-value-container-window", "zen-tor-panel-tip-container-window"]
      : ["zen-tor-panel-value-container-default", "zen-tor-panel-tip-container-default"];
    rows.push({
      label: "zen-tor-panel-label-container",
      value: name ? { text: name } : { id: fallback[0] },
      tone: "none",
      tip: name ? null : fallback[1],
    });

    rows.push({
      label: "zen-tor-panel-label-hardening",
      value: {
        id: ZenTorProxy.harden
          ? "zen-tor-panel-value-on"
          : "zen-tor-panel-value-off",
      },
      tone: ZenTorProxy.harden ? "ok" : "warn",
      tip: ZenTorProxy.harden
        ? "zen-tor-panel-tip-hardening-on"
        : "zen-tor-panel-tip-hardening-off",
    });

    if (!ZenTorControl.enabled) {
      rows.push({
        label: "zen-tor-panel-label-control",
        value: { id: "zen-tor-panel-value-off" },
        tone: "none",
        tip: "zen-tor-panel-tip-control-off",
      });
    }

    const key = JSON.stringify(rows);
    if (key === this._factsKey) {
      return;
    }
    this._factsKey = key;
    const facts = document.getElementById("zen-tor-panel-facts");
    facts.textContent = "";
    for (const row of rows) {
      const node = this._fact(row.label, row.value, row.tone, row.tip);
      if (row.id) {
        node.id = row.id;
      }
      facts.append(node);
    }
  },

  /* Which tor is actually carrying traffic: this browser's own, an external
     one at the configured proxy address, or ours having failed to come up -
     silently falling back to the latter is exactly what this row exists to
     stop being invisible. */
  _instanceFact() {
    if (ZenTorDaemon.running) {
      return {
        label: "zen-tor-panel-label-instance",
        value: { id: "zen-tor-panel-value-instance-own" },
        tone: "ok",
        tip: "zen-tor-panel-tip-instance-own",
      };
    }
    const error = ZenTorDaemon.lastError;
    if (ZenTorDaemon.enabled && error) {
      const [value, tip] = DAEMON_FAILURE[error.code] || [
        "zen-tor-panel-value-instance-failed",
        "zen-tor-panel-tip-instance-failed",
      ];
      return {
        label: "zen-tor-panel-label-instance",
        value: { id: value },
        tone: "bad",
        tip,
      };
    }
    return {
      label: "zen-tor-panel-label-instance",
      value: { id: "zen-tor-panel-value-instance-external" },
      tone: "none",
      tip: "zen-tor-panel-tip-instance-external",
    };
  },

  // Absent unless bridges are actually turned on - a row for a feature
  // nobody configured is noise, not a fact.
  _bridgesFact() {
    if (!Services.prefs.getBoolPref(PREF_BRIDGES_ENABLED, false)) {
      return null;
    }
    const status = ZenTorDaemon.bridgeStatus;
    if (status) {
      return {
        label: "zen-tor-panel-label-bridges",
        value: {
          id: "zen-tor-panel-value-bridges-active",
          args: { transports: [...status.transports].join(", ") || "vanilla" },
        },
        tone: "ok",
        tip: "zen-tor-panel-tip-bridges-active",
      };
    }
    const error = ZenTorDaemon.lastError;
    if (error?.code === "bad-bridge-line") {
      return {
        label: "zen-tor-panel-label-bridges",
        value: { id: "zen-tor-panel-value-bridges-invalid", args: { line: error.line || 0 } },
        tone: "bad",
        tip: "zen-tor-panel-tip-bridges-invalid",
      };
    }
    if (error?.code === "no-transport") {
      return {
        label: "zen-tor-panel-label-bridges",
        value: {
          id: "zen-tor-panel-value-bridges-missing-transport",
          args: { transport: error.transport || "" },
        },
        tone: "bad",
        tip: "zen-tor-panel-tip-bridges-missing-transport",
      };
    }
    return {
      label: "zen-tor-panel-label-bridges",
      value: { id: "zen-tor-panel-value-bridges-pending" },
      tone: "warn",
      tip: "zen-tor-panel-tip-bridges-pending",
    };
  },

  _renderActions() {
    const space = window.gZenWorkspaces?.getActiveWorkspaceFromCache?.();
    const routed = space ? ZenTorProxy.isTorContext(space.containerTabId) : false;
    const toggle = document.getElementById("zen-tor-panel-toggle-space");
    toggle.hidden = !space;
    toggle.classList.toggle("zen-tor-panel-primary", !routed);
    toggle.classList.toggle("zen-interactive-button", routed);
    document.l10n.setAttributes(
      toggle,
      routed ? "zen-tor-panel-toggle-off" : "zen-tor-panel-toggle-on"
    );
  },

  /* The only path that can produce a chain. Re-queried only when the tab or
     its routing changed: _render also runs on every tab attribute change. */
  async _renderCircuit(generation, state, host, force) {
    const key = `${state}|${host}`;
    if (!force && key === this._circuitKey) {
      return;
    }
    this._circuitKey = key;

    const section = document.getElementById("zen-tor-panel-circuit");
    const absent = document.getElementById("zen-tor-panel-nocircuit");
    const route = document.getElementById("zen-tor-panel-route");
    const note = document.getElementById("zen-tor-panel-chain-note");
    const button = document.getElementById("zen-tor-panel-new-circuit");
    const loading = document.getElementById("zen-tor-panel-loading");
    document.getElementById("zen-tor-panel-torrc").textContent =
      ZenTorControl.torrcHint;

    section.hidden = true;
    absent.hidden = true;
    button.hidden = true;
    this._showBootstrap(null);
    this._clearRoute(route);
    note.hidden = true;
    loading.hidden = true;
    // No routing means no circuit; no site means no circuit to name. The
    // container facts above are still true in both cases.
    if (!state || !host) {
      return;
    }

    loading.hidden = false;
    const result = await ZenTorControl.describe(host);
    if (generation !== this._generation) {
      return;
    }
    loading.hidden = true;
    if (!result.available) {
      /* The torrc lines answer "no control port". "You switched this off" is
         already a fact row, and a heading with nothing under it explains
         nothing, so that case drops the section entirely. */
      const off = result.reason === "disabled";
      absent.hidden = off;
      document.getElementById("zen-tor-panel-hint").hidden = off;
      document.getElementById("zen-tor-panel-torrc").hidden = off;
      return;
    }
    this._showBootstrap(result.bootstrap);
    section.hidden = false;
    button.hidden = false;
    if (!result.circuit) {
      document.l10n.setAttributes(note, "zen-tor-panel-circuit-none");
      note.hidden = false;
      return;
    }
    this._drawRoute(route, result.circuit, host);
  },

  /* Only ever from a real status/bootstrap-phase reading. Recorded rather than
     written into the row, so the memoised fact list rebuilds when it changes
     and drops it again when the next read has none. */
  _showBootstrap(percent) {
    const value =
      Number.isFinite(percent) && percent < 100 ? percent : null;
    if (value === this._bootstrap) {
      return;
    }
    this._bootstrap = value;
    this._renderFacts(window.gZenTor?.state ?? null, window.gZenTor?.status ?? "off");
  },

  _clearRoute(route) {
    for (const node of [...route.querySelectorAll(".zen-tor-panel-route-node")]) {
      node.remove();
    }
    route.removeAttribute("data-flow");
  },

  _node(role, name, nameId, sub, tip) {
    const node = document.createElementNS(HTML, "div");
    node.className = "zen-tor-panel-route-node";
    node.setAttribute("data-role", role);
    if (tip) {
      node.setAttribute("title", tip);
    }
    const dot = document.createElementNS(HTML, "span");
    dot.className = "zen-tor-panel-route-dot";
    const label = document.createElementNS(HTML, "span");
    label.className = "zen-tor-panel-route-name";
    if (nameId) {
      document.l10n.setAttributes(label, nameId);
    } else {
      label.textContent = name;
    }
    node.append(dot, label);
    if (sub?.length) {
      const line = document.createElementNS(HTML, "span");
      line.className = "zen-tor-panel-route-sub";
      for (const part of sub) {
        const span = document.createElementNS(HTML, "span");
        if (part.id) {
          document.l10n.setAttributes(span, part.id);
        } else {
          span.textContent = part.text;
        }
        line.append(span);
      }
      node.append(line);
    }
    return node;
  },

  /* The last hop is called an exit only when Tor's own consensus flags say it
     is one; an onion circuit ends at a rendezvous point instead. */
  _roleId(hop, index, count, purpose) {
    if (index === 0) {
      return "zen-tor-panel-circuit-guard";
    }
    if (index < count - 1) {
      return "zen-tor-panel-circuit-relay";
    }
    if (purpose?.startsWith("HS_")) {
      return "zen-tor-panel-circuit-rendezvous";
    }
    return hop.flags?.includes("Exit")
      ? "zen-tor-panel-circuit-exit"
      : "zen-tor-panel-circuit-relay";
  },

  _country(code) {
    try {
      return new Intl.DisplayNames(undefined, { type: "region" }).of(
        code.toUpperCase()
      );
    } catch {
      return code.toUpperCase();
    }
  },

  /* Drawn only from hops the control port gave us, so there is no placeholder
     node and no fixed three-slot shape to fill: an onion circuit simply ends
     somewhere else. */
  _drawRoute(route, circuit, host) {
    const nodes = [this._node("you", null, "zen-tor-panel-circuit-browser")];
    circuit.path.forEach((hop, index) => {
      const sub = [
        { id: this._roleId(hop, index, circuit.path.length, circuit.purpose) },
      ];
      if (hop.country) {
        sub.push({ text: hop.country.toUpperCase() });
      }
      nodes.push(
        this._node(
          index === 0 ? "guard" : "relay",
          hop.nickname,
          hop.nickname ? null : "zen-tor-panel-circuit-unnamed",
          sub,
          [hop.nickname, hop.address, hop.country && this._country(hop.country)]
            .filter(Boolean)
            .join(" · ")
        )
      );
    });
    nodes.push(
      this._node(
        this._isOnion ? "onion" : "site",
        host,
        host ? null : "zen-tor-panel-no-site",
        this._isOnion ? [{ id: "zen-tor-panel-circuit-site-onion" }] : null
      )
    );
    route.style.setProperty("--zen-tor-route-count", nodes.length);
    route.append(...nodes);
    route.setAttribute("data-flow", "on");
  },

  async _newCircuit() {
    const button = document.getElementById("zen-tor-panel-new-circuit");
    const loading = document.getElementById("zen-tor-panel-loading");
    button.disabled = true;
    const result = await ZenTorControl.newCircuit(this._host);
    button.disabled = false;
    if (result.ok) {
      gBrowser.reloadTab(gBrowser.selectedTab);
    }
    this._render(true);
  },
};
