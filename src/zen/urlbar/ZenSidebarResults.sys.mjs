/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Sidebar results list, rendered by us instead of the stock urlbar view.
 * The stock view is hidden by `.urlbar:not([breakout])` and opened by
 * #openPanel, which is the floating-popup machinery; we never touch either. */

const PREF = "zen.urlbar.sidebar.";

/* The result enums, which in 154 live in UrlbarShared, not UrlbarUtils, and
   not on window.UrlbarUtils either - browser.js defines that on its own
   global, and what this module reads there carries no enums. */
const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  UrlbarShared: "chrome://browser/content/urlbar/UrlbarShared.mjs",
});

const PROPS = ["transition", "width", "min-width", "max-width"];

window.gZenSidebarResults = {
  _list: null,
  _rows: [],
  _selected: -1,
  _chip: -1,

  get enabled() {
    return Services.prefs.getStringPref("zen.urlbar.behavior", "") === "sidebar";
  },

  /* Read per render rather than cached: a render happens once a frame at
     most, and this keeps a settings change live without an observer each. */
  get opts() {
    const bool = (k, d) => Services.prefs.getBoolPref(PREF + k, d);
    const int = (k, d) => Services.prefs.getIntPref(PREF + k, d);
    return {
      maxRows: Math.max(1, Math.min(20, int("max-rows", 8))),
      group: bool("group-by-site", true),
      paths: bool("show-paths", true),
      maxPaths: Math.max(0, Math.min(6, int("max-paths", 3))),
      url: bool("show-url", true),
      source: bool("show-source", true),
      density: Services.prefs.getStringPref(PREF + "density", "comfortable"),
    };
  },

  get _toolbox() {
    return document.getElementById("navigator-toolbox");
  },

  /* Horizontal has no tab-strip sidebar: everything this module measures from
     the toolbox, and every width it writes, is meaningless there. */
  get _horizontal() {
    return document.documentElement.getAttribute("zen-layout") === "horizontal";
  },

  /* Watch the behavior pref: without this the component only ever set
     itself up if "sidebar" was already active at startup, so switching
     modes was the only thing that made it appear. */
  init() {
    if (this._inited) {
      return;
    }
    this._inited = true;
    Services.prefs.addObserver("zen.urlbar.behavior", this);
    this._killBreakout();
    this._measureRest();
    /* Not straight off resize: every frame of a sidebar drag dispatches a
       synthetic window resize, and each one costs two forced layouts here.
       The trailing edge is all this needs - it only records a resting width -
       and the sweep below still catches anything that drifts. */
    window.addEventListener("resize", () => {
      clearTimeout(this._measureTimer);
      this._measureTimer = setTimeout(() => this._measureRest(), 150);
    });
    /* Self-heal: the field's resting width comes from --zen-sidebar-rest, and
       if that is ever stale the rule falls back to --urlbar-width, which other
       layouts have been seen to leave at 751px - the field then renders far
       wider than the sidebar. Re-measuring while idle costs two rect reads a
       second and puts it right within a second of it ever drifting. */
    setInterval(() => this._measureRest(), 1000);
    /* Separate from _measureRest, which returns early while the sidebar reports
       itself animating - true for the first ~7s of a window until the watchdog
       clears it, during which the field keeps its natural width and overhangs.
       Fitting is safe mid-animation; it is the width it should have either way. */
    setInterval(() => {
      if (this._fixedWidth) {
        this._fitField();
      }
    }, 1000);
    /* Dragging the splitter must always win: our pin is !important on both
       min- and max-width, so a widen still in flight would otherwise hold the
       sidebar where it was and the drag would do nothing. */
    window.addEventListener(
      "mousedown",
      event => {
        if (
          event.target?.closest?.(
            "#zen-sidebar-splitter, #zen-compact-sidebar-resizer"
          )
        ) {
          this._settleAnimating();
        }
      },
      { capture: true }
    );
    // Kept, not inline: an anonymous observer can never be removed again.
    this._modeObserver = { observe: () => this._markMode() };
    Services.prefs.addObserver("zen.urlbar.behavior", this._modeObserver);
    window.addEventListener("unload", () => this.uninit(), { once: true });
    if (!this._setup()) {
      this._startRetry();
    }
  },

  /* Hiding the stock view with .urlbar:not([breakout]) was never enough: the
     field itself still broke out into a wide box over the content on focus,
     which is the popup users kept reporting in sidebar mode. Results live in
     the sidebar here, so the field should not move at all - strip the
     attributes, as the horizontal layout already does. Firefox also writes an
     inline top alongside them. */
  _markMode() {
    document.documentElement.toggleAttribute("zen-urlbar-sidebar", this.enabled);
  },

  _killBreakout() {
    this._markMode();
    const url = document.getElementById("urlbar");
    if (!url || this._breakoutObserver) {
      return;
    }
    const ATTRS = ["breakout", "breakout-extend", "breakout-extend-animate"];
    const strip = () => {
      if (!this.enabled) {
        return;
      }
      for (const a of ATTRS) {
        url.removeAttribute(a);
      }
      if (url.style.top) {
        url.style.removeProperty("top");
      }
    };
    this._breakoutObserver = new MutationObserver(strip);
    this._breakoutObserver.observe(url, {
      attributes: true, attributeFilter: [...ATTRS, "style"],
    });
    strip();
  },

  /* If the window wasn't ready, retry on delayed startup and on the first
     focus, so setting up doesn't depend on winning a startup race. */
  _startRetry() {
    if (this._retry) {
      return;
    }
    this._retry = () => {
      if (this._setup()) {
        this._stopRetry();
      }
    };
    window.addEventListener("focusin", this._retry, true);
    Services.obs.addObserver(this, "browser-delayed-startup-finished");
  },

  _stopRetry() {
    if (!this._retry) {
      return;
    }
    window.removeEventListener("focusin", this._retry, true);
    this._retry = null;
    try {
      Services.obs.removeObserver(this, "browser-delayed-startup-finished");
    } catch {}
  },

  observe(_subject, topic) {
    if (topic === "browser-delayed-startup-finished") {
      this._retry?.();
      return;
    }
    if (topic !== "nsPref:changed") {
      return;
    }
    if (this.enabled) {
      if (!this._setup()) {
        this._startRetry();
      }
    } else {
      this.hide();
      this._toolbox?.removeAttribute("zen-urlbar-focused");
      document.documentElement.removeAttribute("zen-sidebar-urlbar");
    }
  },

  /* Returns false when the window isn't ready yet so callers can retry;
     gURLBar may not exist at MozAfterPaint on a heavy session restore. */
  _setup() {
    if (this._list) {
      return true;
    }
    if (!this.enabled) {
      return false;
    }
    const navBar = document.getElementById("nav-bar");
    if (!navBar || !window.gURLBar?.controller || !gURLBar.inputField) {
      return false;
    }

    this._list = document.createXULElement("vbox");
    this._list.id = "zen-sidebar-results";
    navBar.after(this._list);

    gURLBar.controller.addListener(this);
    gURLBar.inputField.addEventListener("keydown", this, true);
    gURLBar.inputField.addEventListener("blur", this);
    gURLBar.inputField.addEventListener("focus", this);
    /* Marks the window as owning the results, so CSS can hide the stock
       .urlbarView. Set here rather than derived from the pref in CSS: a
       string pref has no -moz-pref media query, and this is also the exact
       point at which we are actually able to render them. */
    document.documentElement.setAttribute("zen-sidebar-urlbar", "true");
    return true;
  },

  /* Every window - not just the first - selects an empty tab, and Firefox
     focuses the address bar for a blank page (gBrowser._adjustFocusAfterTab-
     Switch), measured at ~+70ms. In sidebar mode that opens the results and
     widens the sidebar; in horizontal it sails the field into the middle of
     the window and leaves it there over the new tab page. So this runs in
     every mode now, armed from MozBeforeInitialXULLayout rather than from
     _setup, which both bails outside sidebar mode and runs a paint too late.

     The listener removes itself on the first real interaction, so it can
     never fight a deliberate click or Ctrl+L - mousedown and keydown capture
     ahead of the focus they cause - and gives up after 2s regardless. */
  _suppressStartupFocus() {
    if (this._startupArmed) {
      return;
    }
    this._startupArmed = true;
    const root = document.documentElement;
    // Read by zen-horizontal-tabs.css: while this is up, a focus is the
    // startup one and the field must not animate anywhere.
    root.setAttribute("zen-startup-settling", "true");
    /* On the window, not on gURLBar.inputField: at this point gURLBar may not
       exist yet, and waiting for it is what made this too late. */
    const onFocus = event => {
      if (event.target === window.gURLBar?.inputField && !gURLBar.value) {
        gURLBar.blur();
      }
    };
    const release = () => {
      if (this._startupReleased) {
        return;
      }
      this._startupReleased = true;
      root.removeAttribute("zen-startup-settling");
      window.removeEventListener("focus", onFocus, true);
      window.removeEventListener("mousedown", release, true);
      window.removeEventListener("keydown", release, true);
    };
    window.addEventListener("focus", onFocus, true);
    window.addEventListener("mousedown", release, true);
    window.addEventListener("keydown", release, true);
    window.setTimeout(release, 2000);
    // The focus can land before this is armed, so clear it once now as well
    // rather than waiting for an event that already fired.
    if (window.gURLBar?.focused && !gURLBar.value) {
      gURLBar.blur();
    }
  },

  /* Zen moves #nav-bar into the sidebar column after we init, which would
   * leave the list orphaned outside it, so re-anchor before showing. */
  _ensurePlacement() {
    const navBar = document.getElementById("nav-bar");
    if (navBar && this._list.previousElementSibling !== navBar) {
      navBar.after(this._list);
    }
  },

  uninit() {
    this._stopRetry();
    if (this._modeObserver) {
      Services.prefs.removeObserver("zen.urlbar.behavior", this._modeObserver);
      this._modeObserver = null;
    }
    if (this._inited) {
      Services.prefs.removeObserver("zen.urlbar.behavior", this);
      this._inited = false;
    }
    if (!this._list) {
      return;
    }
    gURLBar.controller.removeListener(this);
    gURLBar.inputField.removeEventListener("keydown", this, true);
    gURLBar.inputField.removeEventListener("blur", this);
    gURLBar.inputField.removeEventListener("focus", this);
    document.documentElement.removeAttribute("zen-sidebar-urlbar");
  },

  // --- result stream -------------------------------------------------

  /* The urlbar emits several result batches per query, and _render tears the
     whole list down (textContent = "") and rebuilds every row. Rendering each
     batch synchronously meant repeated full rebuilds inside a single focus -
     JS and DOM work landing on the same frames as the sidebar width
     animation, which is what still made it stutter. Coalesced into one
     rebuild per frame; the last batch wins, which is the one that matters. */
  onQueryResults(queryContext) {
    this._pendingResults = queryContext?.results || [];
    if (this._renderScheduled) {
      return;
    }
    this._renderScheduled = true;
    window.requestAnimationFrame(() => {
      this._renderScheduled = false;
      this._render(this._pendingResults || []);
    });
  },

  /* Neither cancel nor finish hides: every keystroke cancels the previous
     query, and the finish notification need not carry results. Visibility
     follows what was actually rendered. */
  onQueryCancelled() {},

  onQueryFinished() {
    if (!this._rows.length) {
      this.hide();
    }
  },

  // --- rendering -----------------------------------------------------

  /* Groups results by origin so each site gets one row, with its other
   * visited paths shown as chips beside it. The heuristic result is kept
   * first and ungrouped: it is what plain Enter acts on. */
  _group(results, opts) {
    const groups = [];
    const byHost = new Map();

    for (const result of results) {
      if (!opts.group) {
        groups.push({ result, chips: [] });
        continue;
      }
      const url = result.payload?.url;
      if (result.heuristic || !url) {
        groups.push({ result, chips: [] });
        continue;
      }

      let host;
      try {
        host = new URL(url).host;
      } catch {
        groups.push({ result, chips: [] });
        continue;
      }

      const existing = byHost.get(host);
      if (!existing) {
        const group = { result, chips: [], host };
        byHost.set(host, group);
        groups.push(group);
        continue;
      }
      if (opts.paths && existing.chips.length < opts.maxPaths) {
        const label = this._pathLabel(url);
        if (label && !existing.chips.some(c => c.label === label)) {
          existing.chips.push({ label, url });
        }
      }
    }
    return groups.slice(0, opts.maxRows);
  },

  _pathLabel(url) {
    try {
      const { pathname } = new URL(url);
      let path = decodeURI(pathname).replace(/\/+$/, "");
      if (!path) {
        return null;
      }
      if (path.length > 22) {
        // The last segment identifies the page; the prefix rarely does.
        const tail = path.split("/").filter(Boolean).pop() || path;
        path = "…/" + tail;
        if (path.length > 22) {
          path = path.slice(0, 21) + "…";
        }
      }
      return path;
    } catch {
      return null;
    }
  },

  _title(result) {
    const p = result.payload || {};
    return p.title || p.suggestion || p.url || "";
  },

  /* What the row is, so the icon column and the tag can say so. Falls back to
     "page" when UrlbarUtils is not in scope yet rather than guessing. */
  _kind(result) {
    const T = lazy.UrlbarShared?.RESULT_TYPE;
    const S = lazy.UrlbarShared?.RESULT_SOURCE;
    if (!T || !S) {
      return "page";
    }
    if (result.type === T.TAB_SWITCH) {
      return "tab";
    }
    if (result.type === T.REMOTE_TAB) {
      return "remote-tab";
    }
    if (result.source === S.BOOKMARKS) {
      return "bookmark";
    }
    if (result.type === T.SEARCH) {
      return "search";
    }
    return "page";
  },

  _kindSafe(result) {
    try {
      return this._kind(result);
    } catch (ex) {
      console.error("[zen] sidebar result kind", ex);
      return "page";
    }
  },

  /* The second line: where the row would take you. For a search that is the
     engine, for anything else the address with the noise trimmed off. */
  _secondary(result, kind) {
    const p = result.payload || {};
    if (kind === "search") {
      return p.engine || "";
    }
    const url = p.url || "";
    try {
      const u = new URL(url);
      const path = decodeURI(u.pathname).replace(/\/+$/, "");
      return u.host.replace(/^www\./, "") + path + (u.search ? "…" : "");
    } catch {
      return url;
    }
  },

  _tagId(kind) {
    return (
      {
        tab: "zen-sidebar-result-tag-tab",
        "remote-tab": "zen-sidebar-result-tag-remote-tab",
        bookmark: "zen-sidebar-result-tag-bookmark",
      }[kind] || null
    );
  },

  _render(results) {
    if (!this._list) {
      return;
    }
    if (!results.length || !gURLBar.value?.trim()) {
      this.hide();
      return;
    }

    const opts = this.opts;

    this._ensurePlacement();
    this._list.setAttribute("zen-density", opts.density);
    this._list.textContent = "";
    this._rows = [];
    this._selected = -1;

    for (const group of this._group(results, opts)) {
      const kind = this._kindSafe(group.result);
      const row = document.createXULElement("hbox");
      row.className = "zen-sidebar-result";
      row.setAttribute("zen-result-kind", kind);
      row.toggleAttribute("zen-result-heuristic", !!group.result.heuristic);

      const icon = document.createXULElement("image");
      icon.className = "zen-sidebar-result-icon";
      if (group.result.payload?.icon) {
        icon.setAttribute("src", group.result.payload.icon);
      }

      const text = document.createXULElement("vbox");
      text.className = "zen-sidebar-result-text";

      const title = this._title(group.result);
      const label = document.createXULElement("label");
      label.className = "zen-sidebar-result-title";
      label.setAttribute("crop", "end");
      label.setAttribute("value", title);
      text.append(label);

      /* Address and tag share the second line. On the first line the tag
         competed with the title for a narrow sidebar's width, and the title
         is what the row is for - it lost down to two characters. */
      const secondary = opts.url ? this._secondary(group.result, kind) : "";
      const tagId = opts.source ? this._tagId(kind) : null;
      if ((secondary && secondary !== title) || tagId) {
        const meta = document.createXULElement("hbox");
        meta.className = "zen-sidebar-result-meta";
        if (secondary && secondary !== title) {
          const sub = document.createXULElement("label");
          sub.className = "zen-sidebar-result-url";
          sub.setAttribute("crop", "end");
          sub.setAttribute("value", secondary);
          meta.append(sub);
        }
        if (tagId) {
          const tag = document.createXULElement("label");
          tag.className = "zen-sidebar-result-tag";
          document.l10n.setAttributes(tag, tagId);
          meta.append(tag);
        }
        text.append(meta);
      }

      row.append(icon, text);
      // mousedown, not click: mousedown blurs the input, and blur hides us.
      row.addEventListener("mousedown", event => {
        event.preventDefault();
        this._activate(group.result);
      });

      const wrapper = document.createXULElement("vbox");
      wrapper.className = "zen-sidebar-result-group";
      wrapper.append(row);

      const chipEls = [];
      if (group.chips.length) {
        const chips = document.createXULElement("hbox");
        chips.className = "zen-sidebar-result-chips";
        for (const chip of group.chips) {
          const button = document.createXULElement("label");
          button.className = "zen-sidebar-result-chip";
          button.setAttribute("value", chip.label);
          button.addEventListener("mousedown", event => {
            event.preventDefault();
            event.stopPropagation();
            this._openUrl(chip.url);
          });
          chipEls.push({ el: button, url: chip.url });
          chips.append(button);
        }
        wrapper.append(chips);
      }

      this._list.append(wrapper);
      this._rows.push({ row, result: group.result, chips: chipEls });
    }

    this.show();
  },

  // --- visibility ----------------------------------------------------

  show() {
    if (!this._list || !this._rows.length) {
      return;
    }
    this._place();
    this._list.setAttribute("open", "true");
    this._toolbox?.setAttribute("zen-sidebar-results", "true");
  },

  /* An overlay, out of the flow: opening must not reflow the tab list below
     on every frame, which is what slow machines felt. One measure per open. */
  _place() {
    const navBar = document.getElementById("nav-bar");
    const parent = this._list.offsetParent;
    if (!navBar || !parent) {
      return;
    }
    const n = navBar.getBoundingClientRect();
    const p = parent.getBoundingClientRect();
    const s = this._list.style;
    s.setProperty("--zen-results-top", `${Math.round(n.bottom - p.top)}px`);
    // Overlay: under the field, as wide as it opened, from its own edge.
    const wide = this._toolbox?.hasAttribute("zen-urlbar-overlay")
      ? parseInt(this._toolbox.style.getPropertyValue("--zen-urlbar-overlay-width"), 10)
      : 0;
    const right = this._toolbox?.getAttribute("zen-right-side") === "true";
    // Overlay: the panel continues the field itself - its bottom edge, its x.
    const field = document.querySelector("#urlbar .urlbar-background");
    if (field && this._toolbox?.hasAttribute("zen-urlbar-overlay")) {
      const f = field.getBoundingClientRect();
      // Unrounded: a 1px seam shows between two greys.
      s.setProperty("--zen-results-joined-top", `${f.bottom - p.top}px`);
      // Right side grows leftward, so its left edge is still moving here.
      const fieldLeft = right && wide ? f.right - (wide - 2) : f.left;
      s.setProperty("--zen-results-field-left", `${fieldLeft - p.left}px`);
    }
    const width = wide || n.width;
    const left = right ? n.right - width : n.left;
    s.setProperty("--zen-results-left", `${Math.round(left - p.left)}px`);
    s.setProperty("--zen-results-width", `${Math.round(width)}px`);
  },

  hide() {
    if (!this._list) {
      return;
    }
    this._list.removeAttribute("open");
    this._selected = -1;
    this._toolbox?.removeAttribute("zen-sidebar-results");
  },

  get isOpen() {
    return !!this._list && this._list.hasAttribute("open");
  },

  // --- interaction ---------------------------------------------------

  _select(index, chipIndex = -1) {
    for (const entry of this._rows) {
      entry.row.removeAttribute("selected");
      for (const chip of entry.chips || []) {
        chip.el.removeAttribute("selected");
      }
    }
    this._selected = index;
    this._chip = chipIndex;
    const entry = this._rows[index];
    if (!entry) {
      return;
    }
    if (chipIndex >= 0 && entry.chips?.[chipIndex]) {
      entry.chips[chipIndex].el.setAttribute("selected", "true");
    } else {
      entry.row.setAttribute("selected", "true");
    }
  },

  _openUrl(url) {
    this.hide();
    openTrustedLinkIn(url, "current");
  },

  /* Search results carry no URL, so they go back through the urlbar,
   * which knows how to turn a suggestion into an engine query. */
  _activate(result) {
    const url = result.payload?.url;
    if (url) {
      this._openUrl(url);
      return;
    }
    const suggestion = result.payload?.suggestion || result.payload?.query;
    if (suggestion) {
      this.hide();
      gURLBar.value = suggestion;
      gURLBar.handleCommand();
    }
  },

  /* A pair of methods here measured a widened width on focus and pinned
     --zen-sidebar-width back on blur. The widen is gone - results render at
     sidebar width, so the field never needed a wider toolbox - and with
     nothing consuming --zen-urlbar-focus-width the pin was pure side effect:
     it rewrote the sidebar's width variables on every blur, which is the
     resize seen when clicking away. Nothing here touches the width now. */

  /* Target width and list anchor, measured once per focus rather than per
     frame - the animation itself is pure CSS on an absolutely positioned
     element, so nothing here runs while it plays. */
  /* The resting cap, measured from the container the field actually sits in.
     Once per window resize, never during the animation. */
  _measureRest() {
    const toolbox = this._toolbox;
    const url = document.getElementById("urlbar");
    if (!toolbox || !url) {
      return;
    }
    // A pin surviving a switch into horizontal would otherwise sit there
    // until the next focus; this sweep already runs every second.
    if (this._horizontal) {
      this._pinField(0, "none");
      return;
    }
    const inset = this._measureInset();
    /* From the toolbox, not #urlbar-container: the container's own width is
       derived from --urlbar-width, so capping against it inherited the same
       stale value it was meant to defend against. */
    /* Only ever measured at rest. Measuring mid-interaction once captured a
       widened field as the resting width, and it stayed that way. */
    if (document.documentElement.hasAttribute("zen-sidebar-animating") ||
        toolbox.hasAttribute("zen-urlbar-focused")) {
      return;
    }
    /* At rest, with neither focus nor animation, no pin should still be in
       place. One that is came from a widen whose release was lost. */
    if (this._inline) {
      this._clearWidth();
    }
    const sidebar = Math.round(toolbox.getBoundingClientRect().width);
    if (sidebar <= 0) {
      return;
    }
    /* The sidebar's own width is always trustworthy, so it is written every
       time - gating it on the field being sane meant the one state that needed
       repairing (field wider than the panel) was the one state never repaired.
       The inset is the only value that needs the sanity check. */
    toolbox.style.setProperty("--zen-sidebar-rest", `${sidebar}px`);
    if (inset == null) {
      const field = Math.round(url.getBoundingClientRect().width);
      if (field > 0 && field <= sidebar) {
        toolbox.style.setProperty("--zen-urlbar-inset", `${sidebar - field}px`);
      }
    }
    // The resting state needs the same fit as focus/blur, or the field is only
    // the right width at whatever window size it was last focused at.
    if (this._fixedWidth) {
      this._fitField();
    }
  },

  /* Outside _measureRest's animating guard on purpose: a padding difference
     survives the sidebar moving, and the one moment it is wrong - before the
     rows have laid out - falls inside the seconds that flag holds at startup.
     From a sibling row: the field gave 0 when it was already too wide, and the
     toolbox padding gave 16 where the rows actually inset 13 a side. */
  _measureInset() {
    const toolbox = this._toolbox;
    const url = document.getElementById("urlbar");
    if (!toolbox || !url || toolbox.hasAttribute("zen-urlbar-focused")) {
      return null;
    }
    const row =
      document.getElementById("zen-sidebar-top-buttons") ||
      document.getElementById("tabbrowser-tabs");
    const sidebar = Math.round(toolbox.getBoundingClientRect().width);
    const rowWidth = row ? Math.round(row.getBoundingClientRect().width) : 0;
    if (sidebar <= 0 || rowWidth <= 0 || rowWidth >= sidebar) {
      return null;
    }
    toolbox.style.setProperty("--zen-urlbar-inset", `${sidebar - rowWidth}px`);
    return sidebar - rowWidth;
  },

  /* Compact floats the sidebar over the page, so growing it on focus covers
     what is being read - measured 207 -> 367. Nothing resizes there. */
  /* Compact only: the row this fits to is the sidebar's, and horizontal has no
     equivalent. Extending it there was tried and reverted. */
  get _overlay() {
    return Services.prefs.getBoolPref("zen.urlbar.sidebar.overlay", true);
  },

  get _fixedWidth() {
    return (
      document.documentElement.getAttribute("zen-compact-mode") === "true"
    );
  },

  _anchorWide() {
    const toolbox = this._toolbox;
    if (!toolbox || toolbox.hasAttribute("zen-urlbar-focused")) {
      return;
    }
    const stored = parseInt(toolbox.style.getPropertyValue("--zen-sidebar-rest"), 10);
    const resting = Number.isFinite(stored)
      ? stored
      : Math.round(toolbox.getBoundingClientRect().width);
    const wide = Math.round(Math.max(resting + 160, Math.min(460, window.innerWidth * 0.32)));
    toolbox.style.setProperty("--zen-urlbar-wide", `${wide}px`);
  },

  /* Hold off the sidebar's resize feedback for the length of the animation,
     then let it measure the settled width exactly once. */
  /* Inline geometry for both elements. `important` because Zen pins the
     sidebar's min/max width that way, and all three must move together or the
     used width snaps to whichever one jumped. */
  _setWidth(px, animate) {
    if (!this._inline) {
      this._saveInline();
    }
    const toolbox = this._toolbox;
    const ease = "cubic-bezier(0.22, 0.61, 0.36, 1)";
    const tr = animate
      ? `width 0.28s ${ease}, min-width 0.28s ${ease}, max-width 0.28s ${ease}`
      : "none";
    if (toolbox) {
      toolbox.style.setProperty("transition", tr, "important");
      toolbox.style.setProperty("width", `${px}px`, "important");
      toolbox.style.setProperty("min-width", `${px}px`, "important");
      toolbox.style.setProperty("max-width", `${px}px`, "important");
    }
    this._pinField(px - this._inset(), tr);
  },

  /* The only place #urlbar's own inline width/min-width/max-width get
     written - _setWidth, _fitField and _clearWidth's restore all go through
     this, so there is one writer to reason about instead of three. */
  _pinField(px, transition) {
    const url = document.getElementById("urlbar");
    if (!url) {
      return;
    }
    /* The field belongs to the toolbar row in horizontal and is sized by
       zen-horizontal-tabs.css. Left alone this pinned a 181px field inside a
       320px slot, and inline !important beat the sheet every time. */
    if (this._horizontal) {
      for (const k of PROPS) {
        url.style.removeProperty(k);
      }
      return;
    }
    url.style.setProperty("transition", transition, "important");
    url.style.setProperty("width", `${px}px`, "important");
    url.style.setProperty("min-width", "0", "important");
    url.style.setProperty("max-width", `${px}px`, "important");
  },

  /* Compact must not resize the sidebar, but the field still has to fit inside
     it - left alone it keeps its natural CSS width and overhangs at any window
     size that is not the one it was tuned at. Field only; the toolbox is not
     touched. */
  _fitField() {
    const row =
      document.getElementById("zen-sidebar-top-buttons") ||
      document.getElementById("tabbrowser-tabs");
    if (!row) {
      return;
    }
    const target = Math.round(row.getBoundingClientRect().width);
    // Only when it actually changed: this runs on a 1s interval, and writing
    // three inline properties every tick invalidates style for nothing.
    if (target <= 0 || target === this._fittedWidth) {
      return;
    }
    this._fittedWidth = target;
    this._pinField(target, "none");
  },

  /* Measures rather than reads back: every resting pin is computed through
     here, and the stored value is only as fresh as the last unguarded sweep. */
  _inset() {
    const measured = this._measureInset();
    if (measured != null) {
      return measured;
    }
    const v = parseInt(this._toolbox?.style.getPropertyValue("--zen-urlbar-inset"), 10);
    return Number.isFinite(v) ? v : 7;
  },

  /* --zen-sidebar-rest as a number, or null before _measureRest has ever run. */
  _restPx() {
    const v = parseInt(this._toolbox?.style.getPropertyValue("--zen-sidebar-rest"), 10);
    return Number.isFinite(v) ? v : null;
  },

  /* Needed, not just tidy: nothing in the sheets carries the field at its
     resting sidebar width. Horizontal is the exception and _pinField turns it
     into a strip there - that layout sizes the field from CSS. */
  _resumeRest() {
    const rest = this._restPx();
    if (rest != null) {
      this._pinField(rest - this._inset(), "none");
    }
  },

  /* Zen keeps the sidebar's width as an inline style of its own, so blanket
     removal wiped it and the panel dropped to its unstyled width while the tabs
     kept the wider size - which is what looked like a box-sizing bug. Save what
     was there and put exactly that back.

     #urlbar gets no snapshot: unlike the toolbox, nothing else owns its width,
     so its rest value is always the same formula (_inset() against
     --zen-sidebar-rest) rather than whatever happened to be inline before. */
  _saveInline() {
    const toolbox = this._toolbox;
    if (!toolbox) {
      this._inline = null;
      return;
    }
    const saved = {};
    for (const k of PROPS) {
      saved[k] = [toolbox.style.getPropertyValue(k), toolbox.style.getPropertyPriority(k)];
    }
    this._inline = { el: toolbox, saved };
  },

  _clearWidth() {
    if (this._inline) {
      const { el, saved } = this._inline;
      for (const k of PROPS) {
        const [value, priority] = saved[k];
        el.style.removeProperty(k);
        if (value) {
          el.style.setProperty(k, value, priority);
        }
      }
      this._inline = null;
    }
    this._resumeRest();
    /* The snapshot is from before the widen, so putting it back also puts back
       the width the sidebar had then - the compact resizer's pin included. */
    window.gZenSidebarResizer?._syncPin(false);
  },

  _suspend() {
    clearTimeout(this._animTimer);
    document.documentElement.setAttribute("zen-sidebar-animating", "true");
    /* Nothing that reads this flag may be left waiting on a _release that never
       comes - a blur lost to a closed window or a space switch used to leave the
       strip frozen for the rest of the session. */
    clearTimeout(this._animWatchdog);
    this._animWatchdog = setTimeout(() => this._settleAnimating(), 8000);
  },

  /* Clears the flag and lets the observers that were skipped catch up: a
     ResizeObserver drops the entries it declines, so nothing redelivers them. */
  _settleAnimating() {
    clearTimeout(this._animWatchdog);
    clearTimeout(this._animTimer);
    cancelAnimationFrame(this._focusRaf);
    document.documentElement.removeAttribute("zen-sidebar-animating");
    /* The pin is min-width AND max-width, both !important, so anything left
       behind holds the sidebar at that exact width - the splitter then refuses
       to move. Unwinding the flag without unwinding the pin left it stuck. */
    this._clearWidth();
    try {
      window.gZenWorkspaces?.updateTabsContainers();
      window.gZenCompactModeManager?.getAndApplySidebarWidth({});
    } catch (ex) {
      console.error("[zen] sidebar settle", ex);
    }
  },

  /* Released only once the sidebar is back at its resting width. Releasing it
     while widened let the observers record the widened value as the resting
     one, so each focus started wider than the last. */
  _release() {
    clearTimeout(this._animTimer);
    this._animTimer = setTimeout(() => {
      this._settleAnimating();
      /* Deliberately not forcing a width recompute here: called while the
         transition was still running it recorded a mid-animation width as the
         new resting one, and the sidebar crept smaller each cycle. Zen's own
         observers fire on the settled width; we only refresh our measurement
         once layout has caught up. */
      requestAnimationFrame(() => requestAnimationFrame(() => this._measureRest()));
    }, 420);
  },

  handleEvent(event) {
    /* Two reasons to leave the toolbox alone. Horizontal has nothing to widen
       into - it opened an empty 460px band down the window and pushed the page
       over. And a focus during startup is Firefox's, not the user's: blurring
       it is not enough on its own, because this listener runs at target and
       had already widened by then (measured: --zen-urlbar-wide written on a
       cold start into comfortable).

       Bailing before _anchorWide/_suspend/_setWidth and before the deferred
       frames, because a guard on the entry point alone still let the queued
       callback apply the wide value two frames later. */
    if ((this._horizontal ||
         document.documentElement.hasAttribute("zen-startup-settling")) &&
        (event.type === "focus" || event.type === "blur")) {
      cancelAnimationFrame(this._focusRaf);
      this._toolbox?.removeAttribute("zen-urlbar-focused");
      if (event.type === "blur") {
        this.hide();
      }
      return;
    }
    if (event.type === "focus") {
      /* Overlay: the field lifts out over the page and the sidebar keeps its
         width, so nothing behind it re-lays-out. */
      if (this._overlay) {
        this._anchorWide();
        const wide = this._toolbox?.style.getPropertyValue("--zen-urlbar-wide");
        this._toolbox?.style.setProperty("--zen-urlbar-overlay-width", wide);
        this._toolbox?.setAttribute("zen-urlbar-overlay", "true");
        // Compact pins the field inline !important; only inline outranks it.
        const url = document.getElementById("urlbar");
        /* With breakout off the field is a row item, and a row item is
           squeezed back to the row's width. Lift it, holding its slot. */
        const slot = url?.parentElement;
        if (url && slot && window.getComputedStyle(url).position !== "absolute") {
          slot.style.setProperty("min-height", `${url.getBoundingClientRect().height}px`);
          this._toolbox?.setAttribute("zen-urlbar-lift", "true");
        }
        if (url && wide) {
          this._overlayPin = ["width", "max-width"].map(k => [k, url.style.getPropertyValue(k), url.style.getPropertyPriority(k)]);
          url.style.setProperty("width", wide, "important");
          url.style.setProperty("max-width", "none", "important");
        }
        this._toolbox?.setAttribute("zen-urlbar-focused", "true");
        if (this.isOpen) {
          this._place();
        }
        return;
      }
      if (this._fixedWidth) {
        this._toolbox?.setAttribute("zen-urlbar-focused", "true");
        this._fitField();
        return;
      }
      this._anchorWide();
      this._suspend();
      /* At rest min-width is `fit-content`, which cannot be interpolated, so
         pinning and widening in one style pass gave the transition no start
         value and it snapped. Let the pin paint first, then widen. */
      const rest = parseInt(this._toolbox?.style.getPropertyValue("--zen-sidebar-rest"), 10);
      const wide = parseInt(this._toolbox?.style.getPropertyValue("--zen-urlbar-wide"), 10);
      this._setWidth(rest, false);
      this._focusRaf = requestAnimationFrame(() => {
        this._focusRaf = requestAnimationFrame(() => {
          if (gURLBar.focused) {
            this._toolbox?.setAttribute("zen-urlbar-focused", "true");
            this._setWidth(wide, true);
          }
        });
      });
      return;
    }
    if (event.type === "blur") {
      cancelAnimationFrame(this._focusRaf);
      if (this._toolbox?.hasAttribute("zen-urlbar-overlay")) {
        const url = document.getElementById("urlbar");
        for (const [k, v, prio] of this._overlayPin || []) {
          if (v) {
            url?.style.setProperty(k, v, prio);
          } else {
            url?.style.removeProperty(k);
          }
        }
        this._overlayPin = null;
        if (this._toolbox.hasAttribute("zen-urlbar-lift")) {
          url?.parentElement?.style.removeProperty("min-height");
          this._toolbox.removeAttribute("zen-urlbar-lift");
        }
        this._toolbox.removeAttribute("zen-urlbar-overlay");
        this._toolbox.removeAttribute("zen-urlbar-focused");
        this.hide();
        return;
      }
      if (this._fixedWidth) {
        this._release();
        this._toolbox?.removeAttribute("zen-urlbar-focused");
        this._fitField();
        this.hide();
        return;
      }
      const rest = parseInt(this._toolbox?.style.getPropertyValue("--zen-sidebar-rest"), 10);
      this._setWidth(rest, true);
      this._release();
      this._toolbox?.removeAttribute("zen-urlbar-focused");
      this.hide();
      return;
    }
    if (event.type !== "keydown" || !this.isOpen) {
      return;
    }

    switch (event.key) {
      case "ArrowDown":
        this._select(Math.min(this._selected + 1, this._rows.length - 1));
        event.preventDefault();
        break;
      case "ArrowUp":
        if (this._selected <= 0) {
          this._select(-1);
        } else {
          this._select(this._selected - 1);
        }
        event.preventDefault();
        break;
      case "ArrowRight": {
        const chips = this._rows[this._selected]?.chips || [];
        if (chips.length && this._chip < chips.length - 1) {
          this._select(this._selected, this._chip + 1);
          event.preventDefault();
        }
        break;
      }
      case "ArrowLeft":
        if (this._chip >= 0) {
          this._select(this._selected, this._chip - 1);
          event.preventDefault();
        }
        break;
      case "Enter": {
        const entry = this._rows[this._selected];
        if (!entry) {
          break;
        }
        const chip = this._chip >= 0 ? entry.chips?.[this._chip] : null;
        if (chip) {
          this._openUrl(chip.url);
        } else {
          this._activate(entry.result);
        }
        event.preventDefault();
        break;
      }
      case "Escape":
        this.hide();
        event.preventDefault();
        break;
    }
  },
};

/* Before first paint: the startup focus lands at ~+70ms, ahead of the
   MozAfterPaint that init() waits for. */
window.addEventListener(
  "MozBeforeInitialXULLayout",
  () => {
    gZenSidebarResults._suppressStartupFocus();
  },
  { once: true }
);

window.addEventListener(
  "MozAfterPaint",
  () => {
    gZenSidebarResults.init();
  },
  { once: true }
);
