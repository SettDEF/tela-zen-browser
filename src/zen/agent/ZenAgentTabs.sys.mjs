/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ContextualIdentityService } from "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs";
import { ZenAgentIdentity } from "resource:///modules/zen/agent/ZenAgentIdentity.sys.mjs";

const TAB_ATTR = "zen-agent";
// kept in the saved session with the tab: what a restart restores, it can still recognise
const SESSION_KEY = "zenAgentTab";
const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SessionStore: "resource:///modules/sessionstore/SessionStore.sys.mjs",
});
const CONTAINER_PREFIX = "Agent ";
const PREF_ISOLATE = "zen.agent.isolate-tabs";

export const ZenAgentTabs = {
  mode: "off",
  _shutdownHooked: false,
  _nextId: 1,
  _byId: new Map(),
  _ids: new WeakMap(),
  /* One container per client, not one for all of them: two assistants
     sharing a cookie jar is not isolation, and the user seeing two
     colours would reasonably assume otherwise. */
  _containers: new Map(),

  get isolate() {
    return Services.prefs.getBoolPref(PREF_ISOLATE, true);
  },

  idFor(tab) {
    let id = this._ids.get(tab);
    if (id == null) {
      id = this._nextId++;
      this._ids.set(tab, id);
    }
    // a tab whose close never finished lost its entry: listing it makes it reachable again
    if (tab.isConnected && this._byId.get(id) !== tab) {
      this._byId.set(id, tab);
    }
    return id;
  },

  byId(id) {
    const tab = this._byId.get(Number(id));
    if (tab && !tab.isConnected) {
      this._byId.delete(Number(id));
      return null;
    }
    return tab || null;
  },

  isAgentTab(tab) {
    return !!tab?.hasAttribute?.(TAB_ATTR);
  },

  list() {
    const out = [];
    for (const [, tab] of this._byId) {
      if (tab?.isConnected && this.isAgentTab(tab)) {
        out.push(tab);
      }
    }
    return out;
  },

  /* Silent tabs get their own container so the agent does not inherit the
     user's logged-in cookies by default. Attended mode deliberately does not
     use this: there the agent drives the user's own tab, so it is their
     session by construction, and visibly so. */
  _container(client) {
    if (!this.isolate) {
      return 0;
    }
    const key = client || "";
    if (this._containers.has(key)) {
      return this._containers.get(key);
    }
    const identity = ContextualIdentityService.create(
      CONTAINER_PREFIX + (key || "unidentified") + " " + Date.now(),
      "fingerprint",
      ZenAgentIdentity.containerColourFor(key)
    );
    this._containers.set(key, identity.userContextId);
    return identity.userContextId;
  },

  create(url, identity) {
    const win = Services.wm.getMostRecentBrowserWindow();
    if (!win?.gBrowser) {
      return { ok: false, reason: "no-window" };
    }
    let tab;
    try {
      tab = win.gBrowser.addTab(url || "about:blank", {
        inBackground: true,
        skipAnimation: true,
        userContextId: this._container(identity?.name),
        triggeringPrincipal:
          Services.scriptSecurityManager.getSystemPrincipal(),
      });
    } catch (ex) {
      return { ok: false, reason: "tab-failed", detail: String(ex) };
    }
    /* The mark is what makes a silent tab findable. Without it the tab is a
       backdoor; with it the user can see one exists and switch to it. */
    tab.setAttribute(TAB_ATTR, "true");
    try {
      lazy.SessionStore.setCustomTabValue(tab, SESSION_KEY, identity?.name || "agent");
    } catch {}
    /* The tab wears its owner's colour, and its name in words - a per-agent
       hue that only exists as a hue tells a colourblind reader nothing. */
    if (identity?.accent) {
      tab.style.setProperty("--zen-agent-accent", identity.accent);
    }
    if (identity?.name) {
      tab.setAttribute("zen-agent-client", identity.name);
    }
    try {
      win.gZenAgentUI?.markTab?.(tab, identity);
    } catch {}
    /* Closing the tab drops the agent's handle to it rather than leaving the
       id pointing at a detached node - once it is really gone: TabClose fires
       at the START of a close, and a close that throws halfway leaves the tab
       on screen. Dropping the id then made it unclosable by anyone. */
    tab.addEventListener("TabClose", () => tab.ownerGlobal.setTimeout(() => {
      if (!tab.isConnected) {
        this.forget(tab);
      }
    }, 0), { once: true });
    this._hookShutdown();
    return { ok: true, tabId: this.idFor(tab), url: url || "about:blank" };
  },

  forget(tab) {
    const id = this._ids.get(tab);
    if (id != null) {
      this._byId.delete(id);
    }
  },

  /* Agent tabs are deliberately NOT restored on the next launch: a tab an
     agent opened last week reappearing at startup is a surprise, and the
     closed-tabs list already gives a way back within the session. Closing
     them at shutdown is what makes that true without an engine patch, and it
     disposes the container so its cookies do not outlive the session. */
  _hookShutdown() {
    if (this._shutdownHooked) {
      return;
    }
    this._shutdownHooked = true;
    Services.obs.addObserver(this, "quit-application-granted");
  },

  observe(subject, topic) {
    if (topic === "quit-application-granted") {
      this.closeAll();
    }
  },

  close(tab) {
    const gBrowser = tab.ownerGlobal.gBrowser;
    try {
      gBrowser.removeTab(tab, { animate: false, skipPermitUnload: true });
    } catch (e) {
      console.error("ZenAgentTabs: closing an agent tab threw", e);
    }
    // Still there: a close that began and threw halfway leaves the tab `closing`.
    // removeTab without animation on a closing tab finishes it (_endRemoveTab).
    if (tab.isConnected) {
      try {
        gBrowser.removeTab(tab, { animate: false, skipPermitUnload: true });
      } catch (e) {
        console.error("ZenAgentTabs: finishing a stuck agent-tab close threw", e);
      }
    }
    if (!tab.isConnected) {
      this.forget(tab);
    }
  },

  /* Called by the kill switch. Agent tabs are released rather than closed: the
     user may be reading one, and yanking it out from under them is its own
     kind of surprise. The mark stays so it is still identifiable. */
  releaseAll() {
    for (const tab of this.list()) {
      try {
        tab.linkedBrowser?.stop();
      } catch {}
    }
    this._byId.clear();
    this.mode = "off";
  },

  closeAll() {
    for (const tab of this.list()) {
      this.close(tab);
    }
    this._byId.clear();
    this._disposeContainer();
  },

  _disposeContainer() {
    for (const id of this._containers.values()) {
      try {
        ContextualIdentityService.remove(id);
      } catch {}
    }
    this._containers.clear();
  },

  /* Agent tabs a restart brought back (the browser was killed, or the session was saved
     before the quit closed them) return as ordinary tabs: no mark, on nobody's list,
     closable by no one. They carry SESSION_KEY in the session, so they are closed here. */
  sweepRestoredTabs() {
    const sweep = () => {
      for (const win of Services.wm.getEnumerator("navigator:browser")) {
        for (const tab of win.gBrowser?.tabs || []) {
          let v = "";
          try {
            v = lazy.SessionStore.getCustomTabValue(tab, SESSION_KEY);
          } catch {}
          if (v && !this.list().includes(tab)) {
            this.close(tab);
          }
        }
      }
    };
    sweep();
    // windows still being restored at this point are swept once they are
    if (!this._restoreHooked) {
      this._restoreHooked = true;
      Services.obs.addObserver(sweep, "sessionstore-windows-restored");
    }
  },

  /* A crash leaves the ephemeral container behind with its cookies. Sweep them
     at startup the way ZenTorProxy sweeps stale Tor window containers. */
  sweepStaleContainers() {
    let identities = [];
    try {
      identities = ContextualIdentityService.getPublicIdentities();
    } catch {
      return;
    }
    for (const identity of identities) {
      if (
        typeof identity?.name === "string" &&
        identity.name.startsWith(CONTAINER_PREFIX) &&
        ![...this._containers.values()].includes(identity.userContextId)
      ) {
        try {
          ContextualIdentityService.remove(identity.userContextId);
        } catch {}
      }
    }
  },
};
