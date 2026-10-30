/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Classic tabs-on-top chrome, as real elements.
 *
 * Reusing Zen's #tabbrowser-tabs does not work: there is one
 * #navigator-toolbox and it IS the sidebar, its zen-workspace children are
 * position:absolute (contributing no size, so every ancestor collapses to 0),
 * and the arrowscrollboxes take flex-direction from XUL orient. So this builds
 * its own stack instead, inserted into <body> (a flex column) above
 * #zen-main-app-wrapper, giving a full-width bar over BOTH sidebar and content:
 *
 *   #zen-horizontal-chrome
 *     .zen-htabs-strip     - our tab strip
 *     #nav-bar             - Firefox's real one, MOVED here and restored on exit
 *
 * Moving #nav-bar rather than cloning keeps the urlbar, its handlers and every
 * page action working; _navHome remembers exactly where to put it back. */

const HTML_NS = "http://www.w3.org/1999/xhtml";

window.gZenHorizontalTabs = {
  _rows: new Map(),
  _groupWraps: new Map(),
  _navHome: null,
  _inCustomizeMode: false,

  /* Where #nav-bar lives is the other half of the layout, and init() cannot run
     before gBrowser exists. Doing the move at initial XUL layout means the
     window's first painted frame already has the urlbar in the top bar, rather
     than in the sidebar for the second it takes session restore to finish.
     _watchReclaim comes too: Zen's toolbar manager reclaims #nav-bar during
     startup, and nothing would put it back until MozAfterPaint. */
  earlyInit() {
    if (this._chrome) {
      return;
    }
    this._build();
    // No anchor at initial layout is survivable; init() calls this again.
    if (!this._chrome) {
      return;
    }
    this._applyLayout();
    this._watchReclaim();
  },

  init() {
    if (this._inited) {
      return;
    }
    this._inited = true;
    this.earlyInit();
    for (const ev of ["TabOpen", "TabClose", "TabMove", "TabPinned", "TabUnpinned"]) {
      gBrowser.tabContainer.addEventListener(ev, () => this._scheduleSync());
    }
    gBrowser.tabContainer.addEventListener("TabSelect", () => this._markSelected());
    gBrowser.tabContainer.addEventListener("TabAttrModified", (e) => this._update(e.target));
    /* Group create/remove/membership/collapse/rename/recolour, verified against
       tab.js, tabgroup.js and ZenFolders.mjs - all bubble to window like TabGrouped
       already does there. No-ops harmlessly if a build never fires them. */
    for (const ev of ["TabGroupCreate", "TabGrouped", "TabUngrouped", "TabGroupRemoved",
                       "TabGroupCollapse", "TabGroupExpand", "TabGroupUpdate"]) {
      window.addEventListener(ev, () => this._scheduleSync());
    }
    /* A workspace switch shows and hides tabs rather than firing an event of
       its own, so watch the attributes that carry it. */
    new MutationObserver(() => this._scheduleSync()).observe(gBrowser.tabContainer, {
      subtree: true, attributes: true,
      attributeFilter: ["hidden", "zen-workspace-id", "zen-essential", "pinned", "soundplaying", "muted", "zen-agent"],
    });

    // The layout attribute is what ZenLayoutPresets flips.
    new MutationObserver(() => this._applyLayout()).observe(document.documentElement, {
      attributes: true, attributeFilter: ["zen-layout"],
    });
    // Same pattern as gZenVerticalTabsManager's forCustomizableMode: Customize
    // Mode needs #nav-bar back in navigator-toolbox, not our chrome bar.
    window.addEventListener("customizationstarting", () => this._onCustomizeStart());
    window.addEventListener("aftercustomization", () => this._onCustomizeEnd());
    this._applyLayout();
    this._sync();
  },

  get horizontal() {
    return document.documentElement.getAttribute("zen-layout") === "horizontal";
  },

  _build() {
    const anchor = document.getElementById("zen-main-app-wrapper");
    if (!anchor || document.getElementById("zen-horizontal-chrome")) {
      return;
    }
    const chrome = document.createElementNS(HTML_NS, "div");
    chrome.id = "zen-horizontal-chrome";

    const strip = document.createElementNS(HTML_NS, "div");
    strip.className = "zen-htabs-strip";

    const list = document.createElementNS(HTML_NS, "div");
    list.className = "zen-htabs-list";
    strip.append(list);

    const add = document.createElementNS(HTML_NS, "button");
    add.className = "zen-htabs-new";
    document.l10n.setAttributes(add, "zen-htabs-new-tab");
    add.textContent = "+";
    add.addEventListener("click", () =>
      gBrowser.addTrustedTab("about:newtab", { inBackground: false }));
    strip.append(add);

    // Firefox holds tab widths while the pointer is in the strip, so repeated
    // closes keep the next X under the cursor. Released on leaving.
    strip.addEventListener("mouseleave", () => this._unlockWidths());

    for (const ev of ["dblclick", "auxclick"]) {
      strip.addEventListener(ev, (e) => {
        if (e.target.closest(".zen-htabs-tab") || (ev === "auxclick" && e.button !== 1)) {
          return;
        }
        gBrowser.addTrustedTab("about:newtab", { inBackground: false });
      });
    }

    // Wheel over the strip scrolls it, the way a top tab bar behaves.
    list.addEventListener("wheel", (e) => {
      if (!e.deltaY) {
        return;
      }
      list.scrollLeft += e.deltaY;
      e.preventDefault();
    }, { passive: false });

    // Right-click the strip for Firefox's toolbar menu, which carries Customize.
    strip.addEventListener("contextmenu", (e) => {
      if (e.target.closest(".zen-htabs-tab")) {
        return;
      }
      const menu = document.getElementById("toolbar-context-menu");
      if (menu) {
        e.preventDefault();
        menu.openPopupAtScreen(e.screenX, e.screenY, true);
      }
    });

    list.addEventListener("dragover", (e) => {
      if (!this._dragTab) {
        return;
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      this._markDrop(this._dropTarget(e.clientX));
    });
    list.addEventListener("drop", (e) => {
      if (!this._dragTab) {
        return;
      }
      e.preventDefault();
      this._drop(this._dropTarget(e.clientX));
    });
    list.addEventListener("dragleave", () => this._clearMarks());

    chrome.append(strip);
    anchor.parentElement.insertBefore(chrome, anchor);
    this._chrome = chrome;
    this._list = list;

    // Feeds --zen-shy-chrome-height for the "shy" preset: the collapsed bar
    // needs a real target to expand to, and scrollHeight stays accurate even
    // while shy CSS is clipping the box down to a sliver.
    this._shyRO = new ResizeObserver(() => this._updateShyChromeHeight());
    this._shyRO.observe(strip);
  },

  _updateShyChromeHeight() {
    if (!this._chrome) {
      return;
    }
    this._chrome.style.setProperty("--zen-shy-chrome-height", `${this._chrome.scrollHeight}px`);
  },

  /* Moving #nav-bar is the only way to get a full-width urlbar: in the sidebar
     it is 181px wide and every Zen rule sizes it that way. The sidebar's top
     buttons come too - that is where Zen keeps the extensions button, so
     without them a horizontal layout has no extensions at all. */
  _applyLayout() {
    const nav = document.getElementById("nav-bar");
    const buttons = document.getElementById("zen-sidebar-top-buttons");
    /* Cold start into this layout sets zen-layout before this module loads, so
       the observer never fires and init's own call is the only chance - and at
       that point the chrome may not exist yet. Retry rather than guess a moment
       that is late enough. */
    if (!this._chrome || !nav) {
      clearTimeout(this._layoutRetry);
      this._layoutRetry = setTimeout(() => this._applyLayout(), 120);
      return;
    }
    clearTimeout(this._layoutRetry);
    // The strip only unlocks on mouseleave, which a layout switch never fires:
    // measured, the strip came back from another preset still pinned at 61px.
    this._unlockWidths();
    /* Zen's own "normal" mode: no breakout, no floating box, no dropdown of
       its own. Fighting the breakout attributes in CSS never worked because
       Firefox also writes an inline top. Skipped while customizing: nodes
       stay put and _onCustomizeEnd reconciles once the session is over. */
    if (this.horizontal && !this._inCustomizeMode) {
      const behavior = Services.prefs.getStringPref("zen.urlbar.behavior", "floating-on-type");
      if (behavior !== "normal") {
        this._behaviorHome = behavior;
        Services.prefs.setStringPref("zen.urlbar.behavior", "normal");
      }
      if (nav.parentElement !== this._chrome) {
        this._navHome = { parent: nav.parentElement, next: nav.nextElementSibling };
        this._chrome.append(nav);
        this._shyRO?.observe(nav);
      }
      if (buttons && buttons.parentElement !== nav) {
        this._buttonsHome = { parent: buttons.parentElement, next: buttons.nextElementSibling };
        nav.append(buttons);
      }
      this._updateShyChromeHeight();
    } else {
      if (this._behaviorHome) {
        Services.prefs.setStringPref("zen.urlbar.behavior", this._behaviorHome);
        this._behaviorHome = null;
      }
      if (this._buttonsHome && buttons) {
        this._buttonsHome.parent.insertBefore(buttons, this._buttonsHome.next);
        this._buttonsHome = null;
      }
      if (this._navHome) {
        this._navHome.parent.insertBefore(nav, this._navHome.next);
        this._shyRO?.unobserve(nav);
        this._navHome = null;
      }
    }
  },

  /* Zen's own toolbar manager re-parents #nav-bar and the top buttons back
     into the toolbox whenever the layout prefs change - which is exactly what
     switching to this preset does, so our move was being undone a tick later.
     Watching for them leaving is writer-agnostic; running after each writer is
     not. */
  _watchReclaim() {
    if (!this._chrome) {
      return;
    }
    const reassert = () => {
      if (!this.horizontal || this._inCustomizeMode) {
        return;
      }
      const nav = document.getElementById("nav-bar");
      const buttons = document.getElementById("zen-sidebar-top-buttons");
      if (nav?.parentElement === this._chrome && buttons?.parentElement === nav) {
        return;
      }
      if (!this._reclaimAllowed()) {
        return;
      }
      this._applyLayout();
      window.gZenRightRail?._applyLayout();
    };
    const obs = new MutationObserver(reassert);
    obs.observe(this._chrome, { childList: true });
    const nav = document.getElementById("nav-bar");
    if (nav) {
      obs.observe(nav, { childList: true });
    }
  },

  /* Two writers that disagree would otherwise re-assert at each other forever;
     this caps a burst rather than the total, so a later legitimate switch is
     still honoured. */
  _reclaimAllowed() {
    const now = Date.now();
    if (now - (this._reclaimAt || 0) > 2000) {
      this._reclaimAt = now;
      this._reclaimCount = 0;
    }
    if (++this._reclaimCount > 10) {
      if (!this._reclaimWarned) {
        this._reclaimWarned = true;
        console.warn("[zen] horizontal layout kept being reverted; standing down");
      }
      return false;
    }
    return true;
  },

  /* customizationstarting fires synchronously, before CustomizeMode wraps any
     toolbar items, so this must run in-line rather than on a microtask. */
  _onCustomizeStart() {
    this._inCustomizeMode = true;
    this._applyLayout();
  },

  /* aftercustomization fires once CustomizeMode has fully unwrapped its
     items, so nav/buttons are plain nodes again and safe to re-home here. */
  _onCustomizeEnd() {
    this._inCustomizeMode = false;
    this._applyLayout();
  },

  _lockWidths() {
    const row = this._list?.querySelector(".zen-htabs-tab:not([pinned])");
    const w = row ? Math.round(row.getBoundingClientRect().width) : 0;
    if (!w) {
      return;
    }
    this._list.style.setProperty("--zen-htabs-locked", w + "px");
    this._list.setAttribute("locked", "");
  },

  _unlockWidths() {
    if (!this._list) {
      return;
    }
    this._list.removeAttribute("locked");
    this._list.style.removeProperty("--zen-htabs-locked");
  },


  _scheduleSync() {
    if (this._raf) {
      return;
    }
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this._sync();
    });
  },

  /* Rebuild only when the set of tabs changes; titles and selection are
     patched in place so typing in a page never rebuilds the strip. Grouped
     tabs are appended into their group's wrapper instead of the list
     directly, which is enough to keep a contiguous run of a group's tiles
     visually together without touching how ungrouped tabs are ordered. */
  _sync() {
    if (!this._list) {
      return;
    }
    const tabs = gBrowser.tabs.filter(t => this._belongs(t));

    for (const [tab, row] of this._rows) {
      if (!tabs.includes(tab)) {
        row.remove();
        this._rows.delete(tab);
      }
    }

    const seenGroups = new Set();
    let currentGroup = null;
    let currentWrap = null;
    for (const tab of tabs) {
      let row = this._rows.get(tab);
      if (!row) {
        row = this._row(tab);
        this._rows.set(tab, row);
      }

      const group = this._tabGroup(tab);
      if (group !== currentGroup) {
        currentGroup = group;
        currentWrap = group ? this._groupWrap(group) : null;
        if (currentWrap) {
          // append() moves an existing node, so this keeps wrapper order
          // correct even when a group's run isn't touched every sync.
          this._list.append(currentWrap);
        }
      }
      (currentWrap || this._list).append(row);
      this._update(tab);
      if (group) {
        seenGroups.add(group);
      }
    }

    // Drop wrappers for groups no tab belongs to any more this sync.
    for (const [group, wrap] of this._groupWraps) {
      if (!seenGroups.has(group)) {
        wrap.remove();
        this._groupWraps.delete(group);
      }
    }
    for (const group of seenGroups) {
      this._updateGroup(group, this._groupWraps.get(group));
    }

    this._markSelected();
  },

  /* The real tab-group/zen-folder a tab belongs to, or null - guards every
     step since group support may be entirely absent, and deliberately
     excludes the collapsible-pins pseudo-group `tab.group` also returns for
     a pinned tab (see tab.js get group()). */
  _tabGroup(tab) {
    try {
      const group = tab.group;
      if (group && gBrowser.isTabGroup?.(group)) {
        return group;
      }
    } catch {
      // group support missing or tab in a transient state - render as ungrouped.
    }
    return null;
  },

  /* The coloured container for one contiguous run of a group's tiles. Reused
     across syncs; live state (label/colour/collapsed) is refreshed by
     _updateGroup after all of this sync's tabs have been placed. */
  _groupWrap(group) {
    let wrap = this._groupWraps.get(group);
    if (wrap) {
      return wrap;
    }
    wrap = document.createElementNS(HTML_NS, "div");
    wrap.className = "zen-htabs-group";

    const label = document.createElementNS(HTML_NS, "span");
    label.className = "zen-htabs-group-label";
    // Mirrors Firefox's own tab-group-label: click toggles collapsed.
    label.addEventListener("click", (e) => {
      e.stopPropagation();
      try {
        group.collapsed = !group.collapsed;
      } catch {
        // Group went away mid-click; the next sync will drop the wrapper.
      }
    });
    wrap.append(label);
    wrap._label = label;

    this._groupWraps.set(group, wrap);
    return wrap;
  },

  /* Label text, collapsed state and colour, all guarded - a group missing
     any of these accessors just renders with whatever it does have. */
  _updateGroup(group, wrap) {
    if (!wrap) {
      return;
    }
    let name = "";
    let collapsed = false;
    let color = "";
    try {
      name = group.label || group.name || group.defaultGroupName || "";
      collapsed = !!group.collapsed;
      // Plain groups colour via --tab-group-color; Zen folders (which
      // extend the same element) via --zen-folder-accent instead.
      const cs = getComputedStyle(group);
      color = cs.getPropertyValue("--zen-folder-accent").trim()
        || cs.getPropertyValue("--tab-group-color").trim();
    } catch {
      // Missing accessor - fall through with whatever was read so far.
    }
    const count = wrap.querySelectorAll(".zen-htabs-tab").length;
    wrap._label.textContent = collapsed && count ? `${name} (${count})` : name;
    wrap.toggleAttribute("collapsed", collapsed);
    if (color) {
      wrap.style.setProperty("--zen-htabs-group-color", color);
    } else {
      wrap.style.removeProperty("--zen-htabs-group-color");
    }
  },

  /* Only this workspace's tabs, plus essentials, which Zen shows everywhere. */
  _belongs(tab) {
    if (tab.hidden || tab.closing) {
      return false;
    }
    if (tab.hasAttribute("zen-essential")) {
      return true;
    }
    const active = this._activeWorkspace();
    const ws = tab.getAttribute("zen-workspace-id");
    return !active || !ws || ws === active;
  },

  _activeWorkspace() {
    try {
      return gZenWorkspaces?.activeWorkspace || null;
    } catch {
      return null;
    }
  },

  _row(tab) {
    const row = document.createElementNS(HTML_NS, "div");
    row.className = "zen-htabs-tab";
    row._tab = tab;
    row.draggable = true;

    const icon = document.createElementNS(HTML_NS, "img");
    icon.className = "zen-htabs-icon";

    const label = document.createElementNS(HTML_NS, "span");
    label.className = "zen-htabs-label";

    const close = document.createElementNS(HTML_NS, "button");
    close.className = "zen-htabs-close";
    document.l10n.setAttributes(close, "zen-htabs-close-tab");
    close.textContent = "×";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      // Freeze widths first, so the next tab's x stays under the cursor.
      this._lockWidths();
      gBrowser.removeTab(tab, { animate: true });
    });

    row.append(icon, label, close);
    row.addEventListener("mousedown", (e) => {
      if (e.button === 1) {
        e.preventDefault();
        this._lockWidths();
        gBrowser.removeTab(tab, { animate: true });
      } else if (e.button === 0) {
        gBrowser.selectedTab = tab;
        this._focusContent();
      }
    });
    row.addEventListener("dragstart", (e) => {
      this._dragTab = tab;
      row.setAttribute("dragging", "");
      e.dataTransfer.effectAllowed = "move";
      // Firefox needs some payload or the drag never starts.
      e.dataTransfer.setData("text/x-zen-tab", String(tab._tPos ?? 0));
    });
    row.addEventListener("dragend", () => {
      row.removeAttribute("dragging");
      this._clearMarks();
      this._dragTab = null;
    });

    // Zen's own tab menu, so right-click behaves the same as in the sidebar.
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const menu = document.getElementById("tabContextMenu");
      if (!menu) {
        return;
      }
      // Real tabs trigger this via a contextmenu/mouseover listener on
      // gBrowser.tabContainer before the popup opens; our rows live outside
      // that container, so tabContextMenu.ftl never got lazily inserted and
      // labels stayed blank. Do it explicitly here.
      gBrowser.translateTabContextMenu();
      TabContextMenu.contextTab = tab;
      menu.openPopupAtScreen(e.screenX, e.screenY, true);
    });
    return row;
  },

  _update(tab) {
    const row = this._rows.get(tab);
    if (!row) {
      return;
    }
    const label = tab.getAttribute("label") || tab.linkedBrowser?.currentURI?.spec
      || gBrowser.tabContainer.emptyTabTitle;
    row.querySelector(".zen-htabs-label").textContent = label;
    row.title = label;
    const icon = row.querySelector(".zen-htabs-icon");
    const src = tab.getAttribute("image");
    icon.hidden = !src;
    if (src) {
      icon.src = src;
    }
    /* Sections are CSS order, not separate containers: essentials first, then
       pinned, then the rest - no DOM juggling when a tab changes state. */
    row.toggleAttribute("essential", tab.hasAttribute("zen-essential"));
    row.toggleAttribute("pinned", tab.pinned);
    row.toggleAttribute("busy", tab.hasAttribute("busy"));
    row.toggleAttribute("sound", tab.hasAttribute("soundplaying"));
    row.toggleAttribute("muted", tab.hasAttribute("muted"));
    /* An agent-owned tab has to be as findable here as in the sidebar: a tab
       the user cannot locate is a backdoor, not a feature. */
    row.toggleAttribute("agent", tab.hasAttribute("zen-agent"));
    // The tab's own colour, painted by ZenTabFocus.
    const color = tab.style.getPropertyValue("--zen-tab-color");
    row.toggleAttribute("zen-tab-colored", tab.hasAttribute("zen-tab-colored"));
    if (color) {
      row.style.setProperty("--zen-tab-color", color);
    } else {
      row.style.removeProperty("--zen-tab-color");
    }
  },

  /* Tab rows in left-to-right visual order, descending into group wrappers -
     a group wrapper itself is never a drag target, only the tiles in it. */
  _rowsInOrder() {
    const out = [];
    for (const child of this._list?.children || []) {
      if (child.classList.contains("zen-htabs-group")) {
        for (const row of child.children) {
          if (row.classList.contains("zen-htabs-tab")) {
            out.push(row);
          }
        }
      } else if (child.classList.contains("zen-htabs-tab")) {
        out.push(child);
      }
    }
    return out;
  },

  /* The row to insert BEFORE, or null for the end of the strip. */
  _dropTarget(x) {
    for (const row of this._rowsInOrder()) {
      if (row === this._dragRow()) {
        continue;
      }
      const r = row.getBoundingClientRect();
      if (x < r.left + r.width / 2) {
        return row;
      }
    }
    return null;
  },

  _dragRow() {
    return this._dragTab ? this._rows.get(this._dragTab) : null;
  },

  _markDrop(before) {
    this._clearMarks();
    if (before) {
      before.setAttribute("drop-before", "");
    } else {
      const rows = this._rowsInOrder();
      rows[rows.length - 1]?.setAttribute("drop-after", "");
    }
  },

  _clearMarks() {
    for (const row of this._rowsInOrder()) {
      row.removeAttribute("drop-before");
      row.removeAttribute("drop-after");
    }
  },

  /* Element-based moves only: gBrowser.moveTabTo(tab, index) is a no-op here
     (measured), while moveTabBefore/After work and need no index arithmetic. */
  _drop(before) {
    const tab = this._dragTab;
    this._clearMarks();
    if (!tab) {
      return;
    }
    const target = before?._tab;
    if (target && target !== tab) {
      gBrowser.moveTabBefore(tab, target);
      return;
    }
    if (!target) {
      const rows = this._rowsInOrder();
      const last = rows[rows.length - 1]?._tab;
      if (last && last !== tab) {
        gBrowser.moveTabAfter(tab, last);
      }
    }
  },

  /* Selecting a tab is not the same as focusing it: without this the urlbar
     kept focus and its results panel stayed open on top of the tab just
     clicked. Firefox's own tab bar moves focus to the content for the same
     reason. */
  _focusContent() {
    try {
      if (window.gURLBar?.view?.isOpen) {
        window.gURLBar.view.close();
      }
      gBrowser.selectedBrowser?.focus();
    } catch {
      // Urlbar internals differ across rebases; selection already happened.
    }
  },

  _markSelected() {
    for (const [tab, row] of this._rows) {
      row.toggleAttribute("selected", tab === gBrowser.selectedTab);
    }
  },
};

window.addEventListener(
  "MozBeforeInitialXULLayout",
  () => {
    gZenHorizontalTabs.earlyInit();
  },
  { once: true }
);

window.addEventListener(
  "MozAfterPaint",
  () => {
    gZenHorizontalTabs.init();
  },
  { once: true }
);
