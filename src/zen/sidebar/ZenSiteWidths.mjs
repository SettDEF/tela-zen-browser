// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at http://mozilla.org/MPL/2.0/.

/* A sidebar width remembered per site.
 *
 * A site with long titles wants a wide list; a dashboard wants the list out of
 * the way. One global width cannot be both, so each host keeps its own and the
 * sidebar takes it back on every switch to that host.
 *
 * The map is a JSON object in a single pref, host -> px, which is what the
 * per-site editor in Settings reads and writes. Keyed by host without `www.`,
 * the same way the tab focus colours are, so a site is one entry however you
 * reached it. */

const PREF = "zen.sidebar.site-widths";
const ENABLED = "zen.sidebar.remember-per-site";
const MIN = 140;
const MAX = 700;

window.gZenSiteWidths = {
  init() {
    if (this._inited) {
      return;
    }
    this._inited = true;
    gBrowser.tabContainer.addEventListener("TabSelect", () => this._apply());
    window.addEventListener("XULFrameLoaderCreated", () => this._apply(), true);

    /* Recorded when the drag ends, not while it runs: mid-drag widths are
       every width between the two, and the last one is the only real answer. */
    const splitter = document.getElementById("zen-sidebar-splitter");
    splitter?.addEventListener("mouseup", () => setTimeout(() => this._record(), 60));
    this._apply();
  },

  get enabled() {
    return Services.prefs.getBoolPref(ENABLED, false);
  },

  get map() {
    try {
      return JSON.parse(Services.prefs.getStringPref(PREF, "{}")) || {};
    } catch {
      // A hand-edited pref that no longer parses must not take the browser
      // down with it; an empty map behaves exactly like the feature being off.
      return {};
    }
  },

  save(map) {
    Services.prefs.setStringPref(PREF, JSON.stringify(map));
  },

  hostFor(tab = gBrowser.selectedTab) {
    try {
      const uri = tab?.linkedBrowser?.currentURI;
      if (!uri || !/^https?$/.test(uri.scheme)) {
        return null;
      }
      return uri.host.replace(/^www\./, "");
    } catch {
      return null;
    }
  },

  _sidebar() {
    return document.getElementById("navigator-toolbox");
  },

  _record() {
    if (!this.enabled) {
      return;
    }
    const host = this.hostFor();
    const sidebar = this._sidebar();
    if (!host || !sidebar) {
      return;
    }
    const width = Math.round(sidebar.getBoundingClientRect().width);
    if (width < MIN || width > MAX) {
      return;
    }
    const map = this.map;
    map[host] = width;
    this.save(map);
  },

  /* Zen keeps the expanded width as an inline style of its own, so this writes
     the same property rather than a rule of its own - anything else is beaten
     by the min/max width it pins with `important`. */
  _apply() {
    if (!this.enabled) {
      return;
    }
    const host = this.hostFor();
    const sidebar = this._sidebar();
    if (!host || !sidebar) {
      return;
    }
    const width = this.map[host];
    if (!Number.isFinite(width) || width < MIN || width > MAX) {
      return;
    }
    if (Math.round(sidebar.getBoundingClientRect().width) === width) {
      return;
    }
    /* Marked for the length of the change so the width observers settle once at
       the end instead of firing per frame - the same flag the urlbar widen
       uses, and it carries the same watchdog. */
    const root = document.documentElement;
    root.setAttribute("zen-sidebar-animating", "true");
    clearTimeout(this._settleTimer);
    this._settleTimer = setTimeout(() => {
      /* Deliberately not _settleAnimating(): that calls _clearWidth(), which
         restores the inline width saved before the urlbar widen and threw away
         the width just set here. Clear the flag and let the observers settle. */
      root.removeAttribute("zen-sidebar-animating");
      sidebar.style.removeProperty("transition");
      window.gZenCompactModeManager?.getAndApplySidebarWidth({});
    }, 320);
    sidebar.style.setProperty(
      "transition",
      "width 0.28s cubic-bezier(0.22, 0.61, 0.36, 1), min-width 0.28s cubic-bezier(0.22, 0.61, 0.36, 1), max-width 0.28s cubic-bezier(0.22, 0.61, 0.36, 1)",
      "important"
    );
    sidebar.style.setProperty("width", `${width}px`, "important");
    sidebar.style.setProperty("max-width", `${width}px`, "important");
    sidebar.style.setProperty("min-width", `${width}px`, "important");
    window.gZenCompactModeManager?.getAndApplySidebarWidth({});
  },
};

window.addEventListener("MozAfterPaint", () => gZenSiteWidths.init(), { once: true });
