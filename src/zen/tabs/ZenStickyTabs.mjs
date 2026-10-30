// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at http://mozilla.org/MPL/2.0/.

/* Tabs pinned to the BOTTOM of the sidebar.
 *
 * The tab stays exactly where it is in gBrowser's own list - moving the
 * element into a container of our own would put it outside #tabbrowser-tabs,
 * which every drag, selection and session-restore path assumes it is inside.
 * Instead it is marked and the stylesheet sticks it to the bottom of the
 * scroller, so it stays reachable however far the list is scrolled.
 *
 * The mark is stored with SessionStore, so it survives a restart the same way
 * a tab's title or icon does. */

const ATTR = "zen-sticky-bottom";
const KEY = "zenStickyBottom";

window.gZenStickyTabs = {
  init() {
    if (this._inited) {
      return;
    }
    this._inited = true;
    this._buildMenu();
    /* Where the pinned row sits is measured, not assumed: the strip below the
       tab list (downloads, new tab) is a different height per layout. */
    this._layout = () => this._relayout();
    for (const ev of ["TabOpen", "TabClose", "TabMove", "TabSelect", "TabAttrModified"]) {
      gBrowser.tabContainer.addEventListener(ev, this._layout);
    }
    window.addEventListener("resize", this._layout);

    // Restored tabs carry the mark in their session data, not the DOM.
    window.addEventListener("SSTabRestored", event => this._restore(event.target));
    for (const tab of gBrowser.tabs) {
      this._restore(tab);
    }
    this._relayout();
  },

  isSticky(tab) {
    return !!tab?.hasAttribute(ATTR);
  },

  _restore(tab) {
    try {
      if (SessionStore.getCustomTabValue(tab, KEY) === "true") {
        tab.setAttribute(ATTR, "true");
      }
    } catch {
      // A tab that is closing has no session data; nothing to restore.
    }
  },

  toggle(tab) {
    if (!tab) {
      return;
    }
    const next = !this.isSticky(tab);
    tab.toggleAttribute(ATTR, next);
    try {
      SessionStore.setCustomTabValue(tab, KEY, next ? "true" : "");
    } catch (ex) {
      console.error("[zen] sticky tab", ex);
    }
    this._relayout();
  },

  /* Anchored to the sidebar itself rather than the scroller, so the row stays
     put instead of scrolling away with the list. Several pinned tabs stack
     upwards, and the list gets padding so its last rows are never hidden
     behind them. */
  /* The row is drawn OUTSIDE the workspace element. That element carries a
     transform (Zen animates workspace swipes with it) and overflow:hidden, and
     a transform makes it the containing block for fixed descendants as well as
     clipping them - so the real tab, placed below its box, was measured in the
     right position and then painted nowhere. The tab itself stays untouched in
     gBrowser's list; only its row is hidden and mirrored down here. */
  _relayout() {
    const foot = document.getElementById("zen-sidebar-foot-buttons");
    if (!foot) {
      return;
    }
    let box = document.getElementById("zen-bottom-pinned");
    const stuck = [...gBrowser.tabs].filter(t => this.isSticky(t) && !t.closing);
    if (!stuck.length) {
      box?.remove();
      return;
    }
    if (!box) {
      box = document.createXULElement("vbox");
      box.id = "zen-bottom-pinned";
      foot.parentElement.insertBefore(box, foot);
    }

    const seen = new Set();
    for (const tab of stuck) {
      seen.add(tab);
      let row = [...box.children].find(r => r._zenTab === tab);
      if (!row) {
        row = this._row(tab);
        box.appendChild(row);
      }
      this._paint(row, tab);
    }
    for (const row of [...box.children]) {
      if (!seen.has(row._zenTab)) {
        row.remove();
      }
    }
  },

  /* The mirrored row stands in for the tab everywhere, the context menu
     included: `updateContextMenu` reads `triggerNode.tab`, and the icon and
     label are made click-through in CSS so the trigger is always the row. */
  _row(tab) {
    const row = document.createXULElement("hbox");
    row.className = "zen-bottom-pinned-row";
    row.setAttribute("context", "tabContextMenu");
    row._zenTab = tab;
    row.tab = tab;
    const icon = document.createXULElement("image");
    icon.className = "zen-bottom-pinned-icon";
    const label = document.createXULElement("label");
    label.className = "zen-bottom-pinned-label";
    row.append(icon, label);
    row.addEventListener("click", () => {
      if (tab.isConnected) {
        gBrowser.selectedTab = tab;
      }
    });
    return row;
  },

  _paint(row, tab) {
    row.querySelector(".zen-bottom-pinned-label").setAttribute("value", tab.label || "");
    const icon = row.querySelector(".zen-bottom-pinned-icon");
    const src = tab.image || tab.getAttribute("image");
    if (src) {
      icon.setAttribute("src", src);
    } else {
      icon.removeAttribute("src");
    }
    row.toggleAttribute("selected", gBrowser.selectedTab === tab);
  },

  /* Sits with Pin Tab - it is the same kind of decision about where a tab
     lives - and its label flips so one entry covers both directions. */
  _buildMenu() {
    const context = document.getElementById("tabContextMenu");
    if (!context || document.getElementById("context_zenStickyBottom")) {
      return;
    }
    const item = document.createXULElement("menuitem");
    item.id = "context_zenStickyBottom";
    item.addEventListener("command", () => {
      this.toggle(TabContextMenu.contextTab || gBrowser.selectedTab);
    });
    /* The tab is resolved from the trigger the same way the tab menu does it,
       rather than read back from TabContextMenu - this listener and the menu's
       own are both on popupshowing, and the label was whatever ran first. */
    context.addEventListener("popupshowing", event => {
      if (event.target !== context) {
        return;
      }
      const trigger = context.triggerNode;
      const tab =
        trigger?.tab ||
        trigger?.closest?.("tab") ||
        TabContextMenu.contextTab ||
        gBrowser.selectedTab;
      document.l10n.setAttributes(
        item,
        this.isSticky(tab) ? "zen-tab-unstick-bottom" : "zen-tab-stick-bottom"
      );
    });
    document.getElementById("context_pinTab")?.after(item);
  },
};

window.addEventListener("MozAfterPaint", () => gZenStickyTabs.init(), { once: true });
