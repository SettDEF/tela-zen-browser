/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Unloading a tab drops its content process: audio stops, timers stop, memory
   comes back, and the tab stays in the list to be reopened. Built on
   gBrowser.explicitUnloadTabs, the same call spaces and split view use. */

const PREF = "zen.tabs.unload.";
const IDLE_TICK_MS = 60 * 1000;

window.gZenTabUnload = {
  _timer: null,

  get autoEnabled() {
    return Services.prefs.getBoolPref(PREF + "auto", false);
  },

  get autoMinutes() {
    return Services.prefs.getIntPref(PREF + "after-minutes", 30);
  },

  get keepAudible() {
    return Services.prefs.getBoolPref(PREF + "keep-audible", true);
  },

  init() {
    if (this._inited) {
      return;
    }
    this._inited = true;
    this._buildMenu();
    gBrowser.tabContainer.addEventListener("TabSelect", this);
    Services.prefs.addObserver(PREF + "auto", this);
    this._syncTimer();
  },

  handleEvent(event) {
    if (event.type === "TabSelect" && event.target) {
      // Stamp on leaving, so "idle for N minutes" measures time unused.
      const previous = event.detail?.previousTab;
      if (previous) {
        previous._zenLastUsed = Date.now();
      }
      event.target._zenLastUsed = Date.now();
    }
  },

  observe() {
    this._syncTimer();
  },

  _syncTimer() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (this.autoEnabled) {
      this._timer = setInterval(() => this._sweep(), IDLE_TICK_MS);
    }
  },

  // --- what may be unloaded -------------------------------------------

  /* A tab that is selected, already unloaded, or holding something the user
     would lose is not a candidate. Audio is spared by default: a tab going
     quiet on its own would read as a bug. */
  canUnload(tab, { manual = false } = {}) {
    if (!tab || tab.closing || !tab.linkedPanel) {
      return false;
    }
    if (tab.selected && !manual) {
      return false;
    }
    if (tab.hasAttribute("pending")) {
      return false;
    }
    if (!manual && this.keepAudible && (tab.soundPlaying || tab.hasAttribute("soundplaying"))) {
      return false;
    }
    return true;
  },

  async unload(tabs) {
    const list = tabs.filter(t => this.canUnload(t, { manual: true }));
    if (!list.length) {
      return 0;
    }
    // Unloading the tab you are looking at means leaving it first, otherwise
    // the browser simply refuses and nothing appears to happen.
    if (list.some(t => t.selected)) {
      const next = gBrowser.visibleTabs.find(t => !list.includes(t) && !t.hasAttribute("pending"))
        || gBrowser.visibleTabs.find(t => !list.includes(t));
      if (next) {
        gBrowser.selectedTab = next;
      } else {
        return 0;
      }
    }
    try {
      await gBrowser.explicitUnloadTabs(list);
    } catch (e) {
      console.error("zen: unload failed", e);
      return 0;
    }
    return list.length;
  },

  unloadOthers(tab) {
    const others = gBrowser.visibleTabs.filter(t => t !== tab);
    return this.unload(others);
  },

  _sweep() {
    const cutoff = Date.now() - this.autoMinutes * 60 * 1000;
    const stale = gBrowser.visibleTabs.filter(
      t => this.canUnload(t) && (t._zenLastUsed ?? 0) < cutoff
    );
    if (stale.length) {
      gBrowser.explicitUnloadTabs(stale).catch(e => console.error("zen: auto-unload", e));
    }
  },

  // --- menu ------------------------------------------------------------

  _buildMenu() {
    const context = document.getElementById("tabContextMenu");
    if (!context || document.getElementById("zen-context-unload-tab")) {
      return;
    }

    /* One row instead of four. This popup's open latency tracks its painted
       area - these three rows measured ~27 ms of it - and a shorter menu also
       reaches the screen edge later. */
    const parent = document.createXULElement("menu");
    parent.id = "zen-context-unload-menu";
    document.l10n.setAttributes(parent, "zen-tab-unload-menu");
    const popup = document.createXULElement("menupopup");
    parent.append(popup);

    const unload = document.createXULElement("menuitem");
    unload.id = "zen-context-unload-tab";
    document.l10n.setAttributes(unload, "zen-tab-unload-tab");
    unload.addEventListener("command", () => {
      const tabs = TabContextMenu.contextTab?.multiselected
        ? gBrowser.selectedTabs
        : [TabContextMenu.contextTab];
      this.unload(tabs);
    });

    const others = document.createXULElement("menuitem");
    others.id = "zen-context-unload-others";
    document.l10n.setAttributes(others, "zen-tab-unload-others");
    others.addEventListener("command", () => {
      this.unloadOthers(TabContextMenu.contextTab);
    });

    const auto = document.createXULElement("menuitem");
    auto.id = "zen-context-unload-auto";
    auto.setAttribute("type", "checkbox");
    document.l10n.setAttributes(auto, "zen-tab-unload-auto");
    auto.setAttribute("closemenu", "none");
    auto.addEventListener("command", () => {
      Services.prefs.setBoolPref(PREF + "auto", !this.autoEnabled);
    });

    popup.append(unload, others, auto);
    /* Unloading is the opposite of reloading, so it sits with Reload Tab and
       needs no separator of its own. */
    const anchor = document.getElementById("context_reloadTab");
    if (anchor) {
      anchor.after(parent);
    } else {
      context.append(parent);
    }

    /* Per-show state is the submenu's own business: the parent popup does not
       pay for a visibleTabs scan it may never need. */
    popup.addEventListener("popupshowing", event => {
      if (event.target !== popup) {
        return;
      }
      const tab = TabContextMenu.contextTab;
      unload.disabled = !this.canUnload(tab, { manual: true });
      others.disabled = !gBrowser.visibleTabs.some(
        t => t !== tab && this.canUnload(t, { manual: true })
      );
      auto.setAttribute("checked", this.autoEnabled ? "true" : "false");
    });
  },
};

window.addEventListener(
  "MozAfterPaint",
  () => {
    gZenTabUnload.init();
  },
  { once: true }
);
