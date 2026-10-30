/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Real glass: the chrome's background see-through (Hyprland blurs behind it),
 * text and pages solid. The desktop shell writes
 *   ~/.config/tela-zen/glass.json = { "enabled": bool, "opacity": 0..1 }
 * and every window follows it live. */
const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AppConstants: "resource://gre/modules/AppConstants.sys.mjs",
  setInterval: "resource://gre/modules/Timer.sys.mjs",
});

const PREF_ENABLED = "zen.widget.linux.transparency";
const PREF_OPACITY = "zen.glass.opacity";
const PREF_PAGES = "zen.glass.pages";
const PREF_TRANSPARENT_TABS = "browser.tabs.allow_transparent_browser";
// Tests point this elsewhere, so a test browser never follows the real shell.
const PREF_FILE = "zen.glass.file";
const POLL_MS = 1000;

export const TelaGlass = {
  _started: false,
  _mtime: null,

  get _path() {
    const override = Services.prefs.getStringPref(PREF_FILE, "");
    if (override) {
      return override;
    }
    const config =
      Services.env.get("XDG_CONFIG_HOME") ||
      PathUtils.join(Services.dirsvc.get("Home", Ci.nsIFile).path, ".config");
    return PathUtils.join(config, "tela-zen", "glass.json");
  },

  init() {
    if (this._started || lazy.AppConstants.platform !== "linux") {
      return;
    }
    this._started = true;
    Services.prefs.addObserver(PREF_ENABLED, () => this._applyAll(true));
    Services.prefs.addObserver(PREF_PAGES, () => this._applyAll());
    Services.prefs.addObserver(PREF_OPACITY, () => this._applyAll(false));
    Services.obs.addObserver(
      (win) => this._apply(win),
      "browser-delayed-startup-finished"
    );
    this._applyAll();
    this._poll();
    lazy.setInterval(() => this._poll(), POLL_MS);
  },

  // A stat a second; the file only changes when the shell's slider moves.
  async _poll() {
    let stat;
    try {
      stat = await IOUtils.stat(this._path);
    } catch {
      return; // No file: whatever the prefs say stays.
    }
    if (stat.lastModified === this._mtime) {
      return;
    }
    this._mtime = stat.lastModified;
    let data;
    try {
      data = await IOUtils.readJSON(this._path);
    } catch {
      return; // Half-written; the next poll reads it whole.
    }
    if (typeof data?.enabled === "boolean") {
      Services.prefs.setBoolPref(PREF_ENABLED, data.enabled);
    }
    if (typeof data?.pages === "boolean") {
      Services.prefs.setBoolPref(PREF_PAGES, data.pages);
    }
    const opacity = Number(data?.opacity);
    if (Number.isFinite(opacity)) {
      const pct = Math.round(Math.min(1, Math.max(0, opacity)) * 100);
      Services.prefs.setIntPref(PREF_OPACITY, pct);
    }
  },

  get _pages() {
    return (
      Services.prefs.getBoolPref(PREF_ENABLED, false) &&
      Services.prefs.getBoolPref(PREF_PAGES, false)
    );
  },

  _applyAll(repaint = false) {
    // New tabs read this when their browser is created.
    if (Services.prefs.getBoolPref(PREF_TRANSPARENT_TABS, false) !== this._pages) {
      Services.prefs.setBoolPref(PREF_TRANSPARENT_TABS, this._pages);
    }
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      this._apply(win, repaint);
    }
  },

  // Tabs already open follow too: the attribute takes effect live. Zen's
  // empty tab is always transparent and is left alone.
  _applyPages(win) {
    const gBrowser = win.gBrowser;
    const pages = this._pages;
    for (const browser of gBrowser?.browsers ?? []) {
      if (gBrowser.getTabForBrowser(browser)?.hasAttribute("zen-empty-tab")) {
        continue;
      }
      if (pages) {
        browser.setAttribute("transparent", "true");
      } else {
        browser.removeAttribute("transparent");
      }
    }
  },

  _apply(win, repaint = false) {
    const root = win.document?.documentElement;
    if (!root) {
      return;
    }
    const pct = Services.prefs.getIntPref(PREF_OPACITY, 85);
    root.style.setProperty("--tela-glass-opacity", `${pct}%`);
    this._applyPages(win);
    if (!repaint) {
      return;
    }
    // The window keeps its old opaque region until something repaints it;
    // the theme refresh does, once the new style has been applied.
    win.setTimeout(() => {
      const space = win.gZenWorkspaces?.getActiveWorkspace?.();
      if (win.closed || !space || !win.gZenThemePicker?.promiseInitialized) {
        return;
      }
      try {
        win.gZenThemePicker.onWorkspaceChange(space);
      } catch (e) {
        console.error("[tela-glass] repaint failed", e);
      }
    }, 200);
  },
};
