/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

// How long a site's data is allowed to live. Stored as Gecko permissions so
// Firefox's own sanitizer enforces two of the three without code from us:
//   keep     persist-data-on-shutdown=ALLOW   survives clear-on-shutdown
//   session  cookie=ACCESS_SESSION            cleared at shutdown, never on disk
//   tab      the above plus zen-clear-on-tab-close, cleared here on last close
// Only `tab` is new behaviour. docs/browser-safety.md covers what a clear reaches.

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

const PERM_KEEP = "persist-data-on-shutdown";
const PERM_COOKIE = "cookie";
const PERM_TAB = "zen-clear-on-tab-close";

const PREF_DEFAULT = "zen.privacy.site-data.default";
const PREF_CLEAR_CACHES = "zen.privacy.site-data.clear-caches";
const PREF_SHUTDOWN_RESTORE = "zen.privacy.site-data.shutdown-prefs-restore";
const PREF_CLEAN_SHUTDOWN = "zen.privacy.site-data.clean-shutdown";
const PREF_LOG = "zen.privacy.log";

const PREF_SANITIZE_ON_SHUTDOWN = "privacy.sanitize.sanitizeOnShutdown";
const PREF_SHUTDOWN_COOKIES = "privacy.clearOnShutdown_v2.cookiesAndStorage";
const PREF_SHUTDOWN_CACHE = "privacy.clearOnShutdown_v2.cache";

// Closing a window fires one TabClose per tab; batch them so a window close is
// one scan instead of one per tab.
const FLUSH_DELAY_MS = 300;

const LIFETIMES = ["keep", "session", "tab"];

export const ZenSiteDataLifetime = {
  _initialized: false,
  _shuttingDown: false,
  _windows: new WeakMap(),
  _pending: new Set(),
  _flushTimer: null,
  _lastSite: new WeakMap(),
  _clearing: Promise.resolve(),

  // Called per browser window from browser-window-delayed-startup.
  init(window) {
    if (!this._initialized) {
      this._initialized = true;
      Services.obs.addObserver(this, "quit-application-granted");
      Services.prefs.addObserver(PREF_DEFAULT, this);
      Services.prefs.addObserver(PREF_CLEAR_CACHES, this);
      this._syncShutdownPrefs();
      this._recoverFromUncleanShutdown();
    }
    this._attach(window);
  },

  uninit() {
    this._shuttingDown = true;
    if (this._flushTimer) {
      lazy.clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    this._pending.clear();
  },

  observe(subject, topic, data) {
    if (topic === "quit-application-granted") {
      // From here on, Sanitizer's shutdown blocker owns the clearing. Firing
      // our own per-site clears while tabs are torn down would race it.
      this.uninit();
      Services.prefs.setBoolPref(PREF_CLEAN_SHUTDOWN, true);
      Services.prefs.savePrefFile(null);
    } else if (
      topic === "nsPref:changed" &&
      (data === PREF_DEFAULT || data === PREF_CLEAR_CACHES)
    ) {
      this._syncShutdownPrefs();
    }
  },

  // Per-window wiring
  // -----------------

  _attach(window) {
    if (this._windows.has(window) || window.closed) {
      return;
    }
    // Private windows have their own cookie jar which is discarded wholesale
    // when the last one closes; clearing by site from here would reach the
    // ordinary jar instead, so they take no part in any of this.
    if (lazy.PrivateBrowsingUtils.isWindowPrivate(window)) {
      return;
    }

    const onTabClose = event => this._onTabClose(event);
    const progressListener = {
      onLocationChange: (browser, webProgress, request, location, flags) => {
        this._onLocationChange(browser, webProgress, location, flags);
      },
    };

    window.gBrowser.tabContainer.addEventListener("TabClose", onTabClose);
    window.gBrowser.addTabsProgressListener(progressListener);
    this._windows.set(window, { onTabClose, progressListener });

    window.addEventListener(
      "unload",
      () => {
        const entry = this._windows.get(window);
        if (!entry) {
          return;
        }
        window.gBrowser.tabContainer.removeEventListener(
          "TabClose",
          entry.onTabClose
        );
        window.gBrowser.removeTabsProgressListener(entry.progressListener);
        this._windows.delete(window);
      },
      { once: true }
    );
  },

  // A tab restored from the last session has no webNavigation until it is
  // first selected, so currentURI is null and the tab looks like it is on no
  // site at all. registeredOpenURI is what tabbrowser gives such a tab.
  uriOfTab(tab) {
    const browser = tab.linkedBrowser;
    return (
      browser?.currentURI ??
      browser?.registeredOpenURI ??
      tab._originalRegisteredOpenURI ??
      null
    );
  },

  _onTabClose(event) {
    const tab = event.target;
    try {
      this._queue(this.siteOf(this.uriOfTab(tab)));
    } catch (ex) {
      console.error("[zen] site-data: TabClose", ex);
    }
  },

  // A tab that navigates away has left the old site just as surely as one that
  // closed, so the same check runs for it.
  _onLocationChange(browser, webProgress, location, flags) {
    if (
      !webProgress?.isTopLevel ||
      flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT
    ) {
      return;
    }
    const previous = this._lastSite.get(browser);
    const current = this.siteOf(location);
    if (current) {
      this._lastSite.set(browser, current);
    } else {
      this._lastSite.delete(browser);
    }
    if (previous && previous !== current) {
      this._queue(previous);
    }
  },

  _queue(site) {
    if (!site || this._shuttingDown) {
      return;
    }
    this._pending.add(site);
    if (this._flushTimer) {
      lazy.clearTimeout(this._flushTimer);
    }
    this._flushTimer = lazy.setTimeout(() => {
      this._flushTimer = null;
      this._flush();
    }, FLUSH_DELAY_MS);
  },

  async _flush() {
    const sites = [...this._pending];
    this._pending.clear();
    for (const site of sites) {
      if (this._shuttingDown) {
        return;
      }
      if (this.lifetimeForSite(site) !== "tab") {
        continue;
      }
      // Drain any clear already in flight before deciding, so the "is it still
      // open" answer is the one that holds at the moment we act on it.
      await this._clearing;
      if (this._shuttingDown || this.isSiteOpen(site)) {
        continue;
      }
      await this.clearSite(site, "last tab closed");
    }
  },

  // State
  // -----

  siteOf(uri) {
    if (!uri || (uri.scheme !== "http" && uri.scheme !== "https")) {
      return null;
    }
    try {
      return Services.eTLD.getSchemelessSite(uri) || null;
    } catch (ex) {
      // No known eTLD (an IP literal, an intranet name): fall back to the host
      // so such sites still get a stable, matchable key.
      return uri.asciiHost || null;
    }
  },

  isSiteOpen(site) {
    for (const window of lazy.BrowserWindowTracker.orderedWindows) {
      if (
        window.closed ||
        !window.gBrowser ||
        lazy.PrivateBrowsingUtils.isWindowPrivate(window)
      ) {
        continue;
      }
      for (const tab of window.gBrowser.tabs) {
        try {
          if (this.siteOf(this.uriOfTab(tab)) === site) {
            return true;
          }
        } catch (ex) {
          console.error("[zen] site-data: reading tab URI", ex);
        }
      }
    }
    return false;
  },

  // Rules
  // -----

  _principals(site) {
    // Permissions are scheme-sensitive, so a rule for a bare site is two
    // permissions - the same thing Firefox's own exceptions dialog does.
    return ["https://", "http://"].map(scheme =>
      Services.scriptSecurityManager.createContentPrincipalFromOrigin(
        scheme + site
      )
    );
  },

  get defaultLifetime() {
    const value = Services.prefs.getStringPref(PREF_DEFAULT, "keep");
    return LIFETIMES.includes(value) ? value : "keep";
  },

  set defaultLifetime(value) {
    if (!LIFETIMES.includes(value)) {
      throw new Error("unknown lifetime: " + value);
    }
    Services.prefs.setStringPref(PREF_DEFAULT, value);
  },

  // The lifetime in force for a site, following the rule set on it or on any
  // parent domain, and otherwise the default.
  lifetimeForSite(site) {
    const explicit = this.ruleForSite(site);
    return explicit ?? this.defaultLifetime;
  },

  // The rule set on this site or a parent domain, or null if there is none.
  ruleForSite(site) {
    let principal;
    try {
      [principal] = this._principals(site);
    } catch (ex) {
      return null;
    }
    if (
      Services.perms.testPermissionFromPrincipal(principal, PERM_KEEP) ===
      Services.perms.ALLOW_ACTION
    ) {
      return "keep";
    }
    if (
      Services.perms.testPermissionFromPrincipal(principal, PERM_COOKIE) !==
      Ci.nsICookiePermission.ACCESS_SESSION
    ) {
      return null;
    }
    return Services.perms.testPermissionFromPrincipal(principal, PERM_TAB) ===
      Services.perms.ALLOW_ACTION
      ? "tab"
      : "session";
  },

  setRuleForSite(site, lifetime) {
    if (lifetime !== null && !LIFETIMES.includes(lifetime)) {
      throw new Error("unknown lifetime: " + lifetime);
    }
    for (const principal of this._principals(site)) {
      Services.perms.removeFromPrincipal(principal, PERM_KEEP);
      Services.perms.removeFromPrincipal(principal, PERM_COOKIE);
      Services.perms.removeFromPrincipal(principal, PERM_TAB);

      if (lifetime === "keep") {
        Services.perms.addFromPrincipal(
          principal,
          PERM_KEEP,
          Services.perms.ALLOW_ACTION
        );
      } else if (lifetime === "session" || lifetime === "tab") {
        Services.perms.addFromPrincipal(
          principal,
          PERM_COOKIE,
          Ci.nsICookiePermission.ACCESS_SESSION
        );
        if (lifetime === "tab") {
          Services.perms.addFromPrincipal(
            principal,
            PERM_TAB,
            Services.perms.ALLOW_ACTION
          );
        }
      }
    }
  },

  // One entry per site, whichever scheme the permissions were stored under.
  listRules() {
    const rules = new Map();
    const note = (host, lifetime) => {
      if (!host) {
        return;
      }
      // keep beats the clearing lifetimes: it is the one that loses data if we
      // get it wrong.
      const existing = rules.get(host);
      if (existing === "keep" || (existing === "tab" && lifetime !== "keep")) {
        return;
      }
      rules.set(host, lifetime);
    };
    for (const perm of Services.perms.getAllByTypes([
      PERM_KEEP,
      PERM_COOKIE,
      PERM_TAB,
    ])) {
      const host = perm.principal.host;
      if (perm.type === PERM_KEEP) {
        if (perm.capability === Services.perms.ALLOW_ACTION) {
          note(host, "keep");
        }
      } else if (perm.type === PERM_TAB) {
        if (perm.capability === Services.perms.ALLOW_ACTION) {
          note(host, "tab");
        }
      } else if (perm.capability === Ci.nsICookiePermission.ACCESS_SESSION) {
        note(host, "session");
      }
    }
    // A cookie=SESSION written by Firefox's own exceptions dialog shows up here
    // as "session", which is exactly what it is.
    return [...rules]
      .map(([site, lifetime]) => ({ site, lifetime }))
      .sort((a, b) => a.site.localeCompare(b.site));
  },

  // Clearing
  // --------

  get clearFlags() {
    let flags = Ci.nsIClearDataService.CLEAR_COOKIES_AND_SITE_DATA;
    if (Services.prefs.getBoolPref(PREF_CLEAR_CACHES, true)) {
      flags |= Ci.nsIClearDataService.CLEAR_ALL_CACHES;
    }
    return flags;
  },

  // Covers cookies, DOM storage, HSTS, EME, TLS tickets and the caches; it
  // cannot reach DNS, Alt-Svc, OCSP or HTTP-auth, which have no per-site path
  // at all. isUserRequest is off because those last two cleaners answer a user
  // request with deleteAll(), which would log you out of every site.
  clearSite(site, reason = "requested", isUserRequest = false) {
    // Serialised: two overlapping deleteDataFromSite calls for the same site
    // race each other inside the quota manager.
    this._clearing = this._clearing.then(
      () =>
        new Promise(resolve => {
          const flags = this.clearFlags;
          Services.clearData.deleteDataFromSite(
            site,
            { privateBrowsingId: 0 },
            isUserRequest,
            flags,
            failed => {
              if (Services.prefs.getBoolPref(PREF_LOG, false)) {
                console.info(
                  `[zen] site-data: cleared ${site} (${reason})` +
                    (failed ? `, failed flags 0x${failed.toString(16)}` : "")
                );
              }
              resolve(failed);
            }
          );
        })
    );
    return this._clearing;
  },

  // Same clear as the automatic one: a per-site button here must not have the
  // global effect Firefox's own Forget About This Site has.
  forgetSite(site) {
    return this.clearSite(site, "user request");
  },

  // Session cookies never reach disk but their storage does, and only a clean
  // shutdown removes it. Firefox records its own pending clear; the branch it
  // runs when clear-on-shutdown is off does not, so this is that record.
  _recoverFromUncleanShutdown() {
    const wasClean = Services.prefs.getBoolPref(PREF_CLEAN_SHUTDOWN, true);
    Services.prefs.setBoolPref(PREF_CLEAN_SHUTDOWN, false);
    Services.prefs.savePrefFile(null);
    if (wasClean || this.defaultLifetime !== "keep") {
      // A non-keep default already rides Sanitizer's own pending-sanitization
      // replay, which honours the same exceptions we do.
      return;
    }
    for (const { site, lifetime } of this.listRules()) {
      if (lifetime !== "keep") {
        this.clearSite(site, "unclean shutdown");
      }
    }
  },

  // Shutdown posture
  // ----------------

  // The cache pref is separate: cookiesAndStorage does not clear caches, and it
  // is the one item that ignores keep exceptions.
  get _drivenShutdownPrefs() {
    if (this.defaultLifetime === "keep") {
      return [];
    }
    const prefs = [PREF_SANITIZE_ON_SHUTDOWN, PREF_SHUTDOWN_COOKIES];
    if (Services.prefs.getBoolPref(PREF_CLEAR_CACHES, true)) {
      prefs.push(PREF_SHUTDOWN_CACHE);
    }
    return prefs;
  },

  // A non-"keep" default is expressed by turning on Firefox's own
  // clear-on-shutdown, so the shutdown path stays Sanitizer's. The prior value
  // of every pref we overwrite is recorded, and restored only if it still holds
  // the value we wrote - a pref the user has since changed by hand is theirs.
  _syncShutdownPrefs() {
    const wanted = new Set(this._drivenShutdownPrefs);
    let restore = {};
    try {
      restore = JSON.parse(
        Services.prefs.getStringPref(PREF_SHUTDOWN_RESTORE, "{}")
      );
    } catch (ex) {}

    for (const [pref, previous] of Object.entries(restore)) {
      if (wanted.has(pref)) {
        continue;
      }
      if (Services.prefs.getBoolPref(pref, previous) === true) {
        Services.prefs.setBoolPref(pref, previous);
      }
      delete restore[pref];
    }
    for (const pref of wanted) {
      if (Services.prefs.getBoolPref(pref, false)) {
        continue;
      }
      if (!(pref in restore)) {
        restore[pref] = false;
      }
      Services.prefs.setBoolPref(pref, true);
    }

    if (Object.keys(restore).length) {
      Services.prefs.setStringPref(
        PREF_SHUTDOWN_RESTORE,
        JSON.stringify(restore)
      );
    } else {
      Services.prefs.clearUserPref(PREF_SHUTDOWN_RESTORE);
    }
  },

  // What the current default actually does at shutdown, for the UI to state
  // rather than imply.
  get shutdownClearIsOn() {
    return (
      Services.prefs.getBoolPref(PREF_SANITIZE_ON_SHUTDOWN, false) &&
      Services.prefs.getBoolPref(PREF_SHUTDOWN_COOKIES, false)
    );
  },

  // Postures
  // --------

  // A named, serialisable snapshot of everything above, so another feature
  // (the layout presets) can switch protections along with a layout. See
  // docs/browser-safety.md for the integration point.
  exportPosture() {
    return {
      version: 1,
      siteDataDefault: this.defaultLifetime,
      clearCaches: Services.prefs.getBoolPref(PREF_CLEAR_CACHES, true),
      rules: this.listRules(),
    };
  },

  applyPosture(posture) {
    if (!posture || posture.version !== 1) {
      throw new Error("unsupported posture");
    }
    if (Array.isArray(posture.rules)) {
      for (const { site } of this.listRules()) {
        if (!posture.rules.some(rule => rule.site === site)) {
          this.setRuleForSite(site, null);
        }
      }
      for (const { site, lifetime } of posture.rules) {
        this.setRuleForSite(site, lifetime);
      }
    }
    if (typeof posture.clearCaches === "boolean") {
      Services.prefs.setBoolPref(PREF_CLEAR_CACHES, posture.clearCaches);
    }
    if (LIFETIMES.includes(posture.siteDataDefault)) {
      this.defaultLifetime = posture.siteDataDefault;
    }
  },
};
