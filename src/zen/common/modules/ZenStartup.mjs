// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import checkForZenUpdates, {
  createWindowUpdateAnimation,
  playWindowSweepAnimation,
} from "chrome://browser/content/ZenUpdates.mjs";

class ZenStartup {
  #watermarkIgnoreElements = ["zen-toast-container", "zen-browser-background"];
  #hasInitializedLayout = false;

  isReady = false;
  promiseInitialized = new Promise(resolve => {
    this.promiseInitializedResolve = resolve;
  });

  init() {
    this.#recordStartupFrames();
    this.#showWhenReady();
    this.#coverUntilReady();
    // The dotfile first, so this window lays out with its values.
    try {
      ChromeUtils.importESModule(
        "resource:///modules/zen/TelaConfig.sys.mjs"
      ).TelaConfig.init();
    } catch (e) {
      console.error("[tela-config]", e);
    }
    this.#applyThemeStyle();
    window.addEventListener("load", () => this.#alignPanels(), { once: true });
    this.openWatermark();
    this.#zenInitBrowserLayout();
    this.#zenInitNewTabPage();
  }

  /* The look: zen.theme.style tags :root, and each theme's stylesheet is
     scoped to its tag. Themes that use the desktop's Material palette get it
     loaded and kept current. */
  #applyThemeStyle() {
    ChromeUtils.importESModule(
      "chrome://browser/content/preferences/zen-material-palette.mjs"
    ).ZenMaterialPalette.syncTheme(window);
  }

  /* The Android theme floats the sidebar and the page as two panels on one
     frame. The page's own top offset comes from Zen's layout (and moves with
     the toolbar and compact state), so the sidebar is given exactly the same
     top and bottom gap: measured, not guessed, and re-measured on any change. */
  #alignPanels() {
    const root = document.documentElement;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const toolbox = document.getElementById("navigator-toolbox");
      const page = document.getElementById("tabbrowser-tabpanels");
      if (
        root.getAttribute("zen-theme-style") !== "android" ||
        root.getAttribute("zen-compact-mode") === "true" ||
        !toolbox ||
        !page
      ) {
        root.style.removeProperty("--a-panel-top");
        root.style.removeProperty("--a-panel-bottom");
        return;
      }
      const t = toolbox.getBoundingClientRect();
      const p = page.getBoundingClientRect();
      if (!p.height || !t.height) {
        return;
      }
      const style = getComputedStyle(toolbox);
      const top = parseFloat(style.marginTop) || 0;
      const bottom = parseFloat(style.marginBottom) || 0;
      // Where the sidebar would sit with no margin, against where the page does.
      const wantTop = Math.max(0, Math.round(p.top - (t.top - top)));
      const wantBottom = Math.max(0, Math.round(t.bottom + bottom - p.bottom));
      root.style.setProperty("--a-panel-top", wantTop + "px");
      root.style.setProperty("--a-panel-bottom", wantBottom + "px");
    };
    const schedule = () => {
      frame ||= requestAnimationFrame(measure);
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(root);
    for (const id of ["tabbrowser-tabpanels", "navigator-toolbox", "zen-appcontent-wrapper"]) {
      const el = document.getElementById(id);
      el && resize.observe(el);
    }
    new MutationObserver(schedule).observe(root, {
      attributes: true,
      attributeFilter: ["zen-theme-style", "zen-compact-mode", "zen-sidebar-expanded", "zen-single-toolbar", "zen-layout"],
    });
    schedule();
  }

  /* Points new tabs at a locally served page when zen.newtab.url is set.
     Opt-in and empty by default, so an unset pref (or a backend that is not
     running) leaves the stock new tab exactly as it was. Assigning the same
     value repeatedly is harmless - AboutNewTab holds one global override. */
  #zenInitNewTabPage() {
    const url = Services.prefs.getStringPref("zen.newtab.url", "");
    if (!url) {
      return;
    }
    try {
      AboutNewTab.newTabURL = url;
    } catch (e) {
      console.error("zen: could not set newTabURL", e);
      return;
    }
    if (url.startsWith("chrome:")) {
      this.#redirectChromeNewTabs(url);
    }
  }

  /* A chrome: page cannot be loaded by the content process, and the new-tab
     path runs there: the override resolves, the load is refused, and the tab
     silently settles on about:blank - a blank page where the new tab should
     be. Zen's own empty tab escaped it only because addTrustedTab loads with
     the system principal.
     The tabs meant for the new-tab page are marked as they are created, so a
     genuine about:blank (window.open, a restored blank) is never touched, and
     the marked ones are reloaded with the principal that may read chrome.
     Gecko moves the browser back to the parent process on that load. */
  #redirectChromeNewTabs(url) {
    // This runs before the tabbrowser exists; wait for it.
    if (typeof gBrowser === "undefined" || !gBrowser?.addTab) {
      window.addEventListener(
        "MozAfterPaint",
        () => this.#redirectChromeNewTabs(url),
        { once: true }
      );
      return;
    }
    const original = gBrowser.addTab.bind(gBrowser);
    const system = Services.scriptSecurityManager.getSystemPrincipal();
    gBrowser.addTab = (uri, params) => {
      const wanted = uri === url || uri === "about:newtab";
      const tab = original(uri, params);
      /* Not on TabOpen: addTab fires that synchronously, before this call has
         even returned the tab. Queued instead, so the refused load has settled
         and this one is the last word. */
      if (wanted) {
        Services.tm.dispatchToMainThread(() => {
          const browser = tab.linkedBrowser;
          if (!browser || browser.currentURI.spec === url) {
            return;
          }
          try {
            browser.loadURI(Services.io.newURI(url), {
              triggeringPrincipal: system,
            });
          } catch (ex) {
            console.error("zen: could not open the new tab page", ex);
          }
        });
      }
      return tab;
    };
  }

  get #shouldUseWatermark() {
    return (
      Services.prefs.getBoolPref("zen.watermark.enabled", false) &&
      gZenWorkspaces.shouldHaveWorkspaces
    );
  }

  #zenInitBrowserLayout() {
    if (this.#hasInitializedLayout) {
      return;
    }
    this.#hasInitializedLayout = true;
    gZenKeyboardShortcutsManager.beforeInit();
    try {
      const kNavbarItems = ["nav-bar", "PersonalToolbar"];
      const kNewContainerId = "zen-appcontent-navbar-container";
      let newContainer = document.getElementById(kNewContainerId);
      for (let id of kNavbarItems) {
        const node = document.getElementById(id);
        if (!node) {
          console.error("Could not find node with id: " + id);
          continue;
        }
        newContainer.appendChild(node);
      }
      // Fix notification deck
      const deckTemplate =
        document.getElementById("tab-notification-deck-template") ||
        document.getElementById("tab-notification-deck");

      // overlap and interaction issues with vertical tabs
      document.getElementById("browser").prepend(deckTemplate);

      gZenWorkspaces.init().then(() => {
        this.timing.workspaces = Date.now();
        gZenUIManager.init();
        this.#initUIComponents();
        this.#checkForWelcomePage();
      });
    } catch (e) {
      console.error("ZenThemeModifier: Error initializing browser layout", e);
    }
    if (gBrowserInit.delayedStartupFinished) {
      this.delayedStartupFinished();
    } else {
      Services.obs.addObserver(this, "browser-delayed-startup-finished");
    }
  }

  observe(aSubject, aTopic) {
    // This nsIObserver method allows us to defer initialization until after
    // this window has finished painting and starting up.
    if (aTopic == "browser-delayed-startup-finished" && aSubject == window) {
      Services.obs.removeObserver(this, "browser-delayed-startup-finished");
      this.delayedStartupFinished();
    }
  }

  // Startup milestones (Date.now()), for measuring the reveal gap.
  timing = {};

  /* Gecko shows the window as soon as the chrome document loads, before the
     session has filled the sidebar: a placeholder layout, then the real one
     popping in. Held back until restored, so it opens once, complete. Before
     the load, visibility=false only defers Gecko's own show. */
  #showWhenReady() {
    if (!Services.prefs.getBoolPref("zen.startup.show-when-ready", false)) {
      return;
    }
    let base;
    try {
      base = window.docShell.treeOwner
        .QueryInterface(Ci.nsIInterfaceRequestor)
        .getInterface(Ci.nsIAppWindow)
        .QueryInterface(Ci.nsIBaseWindow);
      base.visibility = false;
    } catch (e) {
      console.error("zen: could not hold the window", e);
      return;
    }
    this.timing.held = Date.now();
    let shown = false;
    // The window watcher sets it visible again after this, once the document
    // is parsed: hold again until the load, which comes before Gecko's show.
    const hold = () => !shown && (base.visibility = false);
    window.addEventListener("DOMContentLoaded", hold, { once: true });
    window.addEventListener("load", hold, { once: true, capture: true });
    // Raising a window shows it (nsFocusManager::WindowRaised), and session
    // restore focuses the window mid-restore: defer that until shown.
    // focus is the global's own property, not inherited: keep it to restore.
    let focusWanted = false;
    const realFocus = Object.getOwnPropertyDescriptor(window, "focus");
    window.focus = () => (focusWanted = true);
    const show = why => {
      if (shown) {
        return;
      }
      shown = true;
      this.timing.shown = Date.now();
      this.timing.shownBy = why;
      Object.defineProperty(window, "focus", realFocus);
      try {
        base.visibility = true;
      } catch (e) {
        console.error("zen: could not show the window", e);
      }
      if (focusWanted) {
        window.focus();
      }
    };
    // Never stranded hidden, whatever fails below.
    setTimeout(() => show("timeout"), 3000);
    window.addEventListener(
      "load",
      async () => {
        try {
          // Delayed startup (and with it session restore) waits for the first
          // paint, which a hidden window never has: start it ourselves.
          await new Promise(r => setTimeout(r, 0));
          gBrowserInit._boundDelayedStartup?.();
          await gZenWorkspaces.promiseInitialized;
          await SessionStore.promiseAllWindowsRestored;
          // Flush layout so the first frame is the finished one; rAF does
          // not run while hidden.
          document.documentElement.getBoundingClientRect();
        } catch (e) {
          console.error(e);
        }
        show("ready");
      },
      { once: true }
    );
  }

  /* zen.startup.cover: the smooth start that leaves the native window alone.
     The window shows when Gecko wants it (hiding it broke its size under a
     scaled Wayland compositor), but a flat sheet in the theme's base colour
     covers the half-built layout until the session is restored, then fades. */
  #coverUntilReady() {
    if (!Services.prefs.getBoolPref("zen.startup.cover", false)) {
      return;
    }
    const cover = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
    cover.id = "zen-startup-cover";
    Object.assign(cover.style, {
      position: "fixed",
      inset: "0",
      zIndex: "2147483647",
      background: "var(--zen-startup-cover-bg, var(--zen-branding-bg, #111))",
      transition: "opacity 200ms cubic-bezier(0.34, 0.8, 0.34, 1)",
    });
    document.documentElement.append(cover);
    let done = false;
    const reveal = why => {
      if (done) {
        return;
      }
      done = true;
      this.timing.revealedBy = why;
      cover.style.opacity = "0";
      cover.style.pointerEvents = "none";
      setTimeout(() => cover.remove(), 300);
    };
    // Never stranded under the cover, whatever fails.
    setTimeout(() => reveal("timeout"), 4000);
    window.addEventListener(
      "load",
      async () => {
        try {
          await gZenWorkspaces.promiseInitialized;
          await SessionStore.promiseAllWindowsRestored;
        } catch (e) {
          console.error(e);
        }
        reveal("ready");
      },
      { once: true }
    );
  }

  /* zen.debug.startup-frames: the window's own render every 50ms for 4s,
     into <profile>/startup-frames/, to see what moves while opening. */
  #recordStartupFrames() {
    if (!Services.prefs.getBoolPref("zen.debug.startup-frames", false)) {
      return;
    }
    const dir = PathUtils.join(PathUtils.profileDir, "startup-frames");
    const start = Date.now();
    const shot = async () => {
      const t = Date.now() - start;
      if (t > 4000) {
        return;
      }
      setTimeout(shot, 50);
      try {
        const w = window.innerWidth, h = window.innerHeight;
        const c = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
        c.width = Math.ceil(w / 2);
        c.height = Math.ceil(h / 2);
        const ctx = c.getContext("2d");
        ctx.scale(0.5, 0.5);
        ctx.drawWindow(window, 0, 0, w, h, "rgb(255,0,255)");
        const blob = await new Promise(r => c.toBlob(r, "image/png"));
        await IOUtils.makeDirectory(dir);
        await IOUtils.write(PathUtils.join(dir, `${String(t).padStart(5, "0")}.png`),
          new Uint8Array(await blob.arrayBuffer()));
      } catch {}
    };
    shot();
  }

  delayedStartupFinished() {
    gZenWorkspaces.promiseInitialized.then(async () => {
      await delayedStartupPromise;
      this.timing.delayed = Date.now();
      await SessionStore.promiseAllWindowsRestored;
      this.timing.restored = Date.now();
      delete gZenUIManager.promiseInitialized;
      gZenCompactModeManager.init();
      ChromeUtils.importESModule(
        "resource:///modules/zen/agent/ZenAgentChannel.sys.mjs"
      ).ZenAgentChannel.autoStart?.();
      ChromeUtils.importESModule(
        "resource:///modules/zen/ZenCookieGuard.sys.mjs"
      ).ZenCookieGuard.init();
      ChromeUtils.importESModule(
        "resource:///modules/zen/TelaDownloadProgress.sys.mjs"
      ).TelaDownloadProgress.init();
      ChromeUtils.importESModule(
        "resource:///modules/zen/TelaMediaBridge.sys.mjs"
      ).TelaMediaBridge.init();
      ChromeUtils.importESModule(
        "resource:///modules/zen/TelaGlass.sys.mjs"
      ).TelaGlass.init();
      ChromeUtils.importESModule(
        "resource:///modules/zen/ZenDesktopSpaces.sys.mjs"
      ).ZenDesktopSpaces.init();
      // gZenCompactModeManager.init() restores compact mode itself via a
      // .then() on this same (already-resolved) promise, which sets
      // .preference from its own cached startup value. Chaining onto the
      // same promise here - rather than calling init() synchronously -
      // guarantees that restore runs first and this doesn't get clobbered
      // by it: same-promise .then() callbacks run in registration order.
      SessionStore.promiseAllWindowsRestored.then(() => {
        gZenLayoutPresets.init();
        window.gZenComfyUI?.init();
      });
      // Fix for https://github.com/zen-browser/desktop/issues/7605, specially in compact mode.
      // Skipped in sidebar mode: there the urlbar is not a floating popup, so
      // #7605 (a stranded popup) cannot happen, while an empty tab leaves
      // breakout-extend set and this focused the search field - opening the
      // results and widening the sidebar - on every new window.
      const zenSidebarUrlbar =
        Services.prefs.getStringPref("zen.urlbar.behavior", "") === "sidebar";
      if (!zenSidebarUrlbar && gURLBar.hasAttribute("breakout-extend")) {
        gURLBar.focus();
      }
      // A bit of a hack to make sure the tabs toolbar is updated.
      // Just in case we didn't get the right size.
      gZenUIManager.updateTabsToolbar();
      this.closeWatermark();
      document
        .getElementById("tabbrowser-arrowscrollbox")
        .setAttribute("orient", "vertical");
      this.isReady = true;
      this.promiseInitializedResolve();
      delete this.promiseInitializedResolve;

      setTimeout(() => {
        // Wait for the natural PlacesToolbar rebuild before invalidating, so
        // the two async rebuilds don't interleave and duplicate bookmarks.
        // promiseRebuilt() returns undefined when no rebuild is in flight.
        const rebuilt =
          document
            .getElementById("PlacesToolbar")
            ?._placesView?.promiseRebuilt() ?? Promise.resolve();
        rebuilt
          .catch(console.error)
          .then(() => gZenWorkspaces._invalidateBookmarkContainers());
      });
    });
  }

  openWatermark() {
    if (!this.#shouldUseWatermark) {
      document.documentElement.removeAttribute("zen-before-loaded");
      return;
    }
    for (let elem of document.querySelectorAll(
      `#browser > *:not(${this.#watermarkIgnoreElements.map(id => "#" + id).join(", ")}), #urlbar`
    )) {
      elem.style.opacity = 0;
    }
  }

  closeWatermark() {
    this.timing.revealed = Date.now();
    document.documentElement.removeAttribute("zen-before-loaded");
    if (this.#shouldUseWatermark) {
      let elementsToIgnore = this.#watermarkIgnoreElements
        .map(id => "#" + id)
        .join(", ");
      gZenUIManager.motion
        .animate(
          "#browser > *:not(" +
            elementsToIgnore +
            "), #urlbar, #tabbrowser-tabbox > *",
          {
            opacity: [0, 1],
          },
          {
            duration: 0.1,
          }
        )
        .then(() => {
          for (let elem of document.querySelectorAll(
            "#browser > *, #urlbar, #tabbrowser-tabbox > *"
          )) {
            elem.style.removeProperty("opacity");
          }
        });
    }
    window.requestAnimationFrame(() => {
      window.dispatchEvent(new window.Event("resize")); // To recalculate the layout
    });
  }

  #initUIComponents() {
    const kUIComponents = ["ZenProgressBar", "ZenSpaceRoutingNavigation"];
    for (let component of kUIComponents) {
      const module = ChromeUtils.importESModule(
        "resource:///modules/zen/ui/" + component + ".sys.mjs"
      );
      new module[component](window);
    }
  }

  #checkForWelcomePage() {
    const kWelcomeScreenSeenPref = "zen.welcome-screen.seen";
    if (Services.env.get("MOZ_HEADLESS")) {
      Services.prefs.setBoolPref(kWelcomeScreenSeenPref, true);
      return;
    }
    if (!Services.prefs.getBoolPref(kWelcomeScreenSeenPref, false)) {
      Services.prefs.setBoolPref(kWelcomeScreenSeenPref, true);
      Services.prefs.setStringPref(
        "zen.updates.last-build-id",
        Services.appinfo.appBuildID
      );
      Services.prefs.setStringPref(
        "zen.updates.last-version",
        Services.appinfo.version
      );
      Services.scriptloader.loadSubScript(
        "chrome://browser/content/zen-components/ZenWelcome.mjs",
        window
      );
    } else {
      this.#createUpdateAnimation();
    }
  }

  async #createUpdateAnimation() {
    checkForZenUpdates();
    return await createWindowUpdateAnimation();
  }

  /**
   * Entry point for privileged modules (e.g. the sync applier) to play the
   * update sweep animation in this window.
   */
  playWindowSweepAnimation() {
    return playWindowSweepAnimation();
  }
}

window.gZenStartup = new ZenStartup();

window.addEventListener(
  "MozBeforeInitialXULLayout",
  () => {
    gZenStartup.init();
  },
  { once: true }
);
