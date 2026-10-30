// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

const WIDGET_ID = "zen-closed-tabs-button";
const POPUP_ID = "zen-closed-tabs-popup";

// A menupopup's open latency tracks its painted area, so the list is capped
// rather than left to grow with however many tabs the session remembers.
const MAX_ITEMS = 12;

window.gZenClosedTabs = {
  init() {
    this._registerWidget();
    /* TabClose fires before SessionStore has recorded the tab, so the count
       read from it is always one behind; this is the notification SessionStore
       itself sends once the closed list has actually changed. */
    Services.obs.addObserver(this, "sessionstore-closed-objects-changed");
    window.addEventListener(
      "unload",
      () => Services.obs.removeObserver(this, "sessionstore-closed-objects-changed"),
      { once: true }
    );
    this._update();
  },

  observe() {
    this._update();
  },

  // --- data ---------------------------------------------------------------

  get _closedTabs() {
    try {
      return SessionStore.getClosedTabDataForWindow(window) || [];
    } catch (e) {
      return [];
    }
  },

  get count() {
    try {
      return SessionStore.getClosedTabCountForWindow(window);
    } catch (e) {
      return 0;
    }
  },

  /* The entry the tab was showing when it closed - `index` is 1-based and may
     be absent, which is the same reading Firefox's own consumers do. */
  _activeEntry(closedTab) {
    const state = closedTab?.state;
    const entries = state?.entries;
    if (!entries?.length) {
      return null;
    }
    const active = (state.index || entries.length) - 1;
    return entries[active] || entries[entries.length - 1] || null;
  },

  _label(closedTab) {
    const entry = this._activeEntry(closedTab);
    return closedTab.title || entry?.title || entry?.url || "";
  },

  // --- the widget ---------------------------------------------------------

  /* A CustomizableUI widget rather than a fixed place in the sidebar: the
     sidebar does not exist in every layout preset, and this way the button
     follows the toolbar wherever that preset puts it. */
  _registerWidget() {
    if (
      CustomizableUI.getWidget(WIDGET_ID)?.provider ===
      CustomizableUI.PROVIDER_API
    ) {
      return;
    }
    try {
      CustomizableUI.createWidget({
        id: WIDGET_ID,
        type: "custom",
        l10nId: WIDGET_ID,
        // The sidebar's icon row, where Zen's other toolbar icons already sit.
        defaultArea: "zen-sidebar-top-buttons",
        onBuild(doc) {
          const button = doc.createXULElement("toolbarbutton");
          button.id = WIDGET_ID;
          button.className = "toolbarbutton-1 chromeclass-toolbar-additional";
          button.setAttribute("removable", "true");
          doc.l10n.setAttributes(button, WIDGET_ID);
          button.addEventListener("command", () =>
            doc.defaultView.gZenClosedTabs?.openList(button)
          );
          return button;
        },
      });
    } catch (ex) {
      console.error("[zen-closed-tabs] could not register the widget", ex);
    }
  },

  _update() {
    const button = document.getElementById(WIDGET_ID);
    if (button) {
      button.toggleAttribute("zen-empty", !this.count);
    }
  },

  /* A menupopup rather than a panel: this list can outgrow the screen and only
     a menupopup gets an arrowscrollbox. It is anchored to the button rather
     than parented to it, because the layout presets move the button between
     the sidebar and a horizontal bar. */
  _ensurePopup() {
    let popup = document.getElementById(POPUP_ID);
    if (popup) {
      return popup;
    }
    popup = document.createXULElement("menupopup");
    popup.id = POPUP_ID;
    popup.addEventListener("popupshowing", event => {
      if (event.target === popup) {
        this._fill(popup);
      }
    });
    document.getElementById("mainPopupSet").appendChild(popup);
    return popup;
  },

  openList(anchor) {
    const popup = this._ensurePopup();
    const button = anchor || document.getElementById(WIDGET_ID);
    if (popup.state === "open" || popup.state === "showing") {
      popup.hidePopup();
      return;
    }
    popup.openPopup(button, "after_start", 0, 0, false, false);
  },

  // --- the list -----------------------------------------------------------

  /* Built on the popup's own popupshowing, so a session with a long closed-tab
     history costs nothing until the button is actually used. */
  _fill(popup) {
    while (popup.firstChild) {
      popup.firstChild.remove();
    }
    const closed = this._closedTabs;
    if (!closed.length) {
      const empty = document.createXULElement("menuitem");
      document.l10n.setAttributes(empty, "zen-closed-tabs-empty");
      empty.setAttribute("disabled", "true");
      popup.appendChild(empty);
      return;
    }

    for (const closedTab of closed.slice(0, MAX_ITEMS)) {
      const entry = this._activeEntry(closedTab);
      if (!entry?.url) {
        continue;
      }
      const item = document.createXULElement("menuitem");
      item.classList.add("menuitem-iconic", "zen-closed-tab-item");
      item.setAttribute("label", this._label(closedTab));
      item.setAttribute("tooltiptext", entry.url);
      if (closedTab.image) {
        item.setAttribute("image", closedTab.image);
      }
      /* Restore by closed id, not list index: the list shifts under any
         restore, and an index captured at build time then reopens a
         different tab. */
      const closedId = closedTab.closedId;
      item.addEventListener("command", () => this.restore(closedId));
      popup.appendChild(item);
    }

    popup.appendChild(document.createXULElement("menuseparator"));

    const all = document.createXULElement("menuitem");
    document.l10n.setAttributes(all, "zen-closed-tabs-restore-all");
    all.addEventListener("command", () => this.restoreAll());
    popup.appendChild(all);

    const clear = document.createXULElement("menuitem");
    document.l10n.setAttributes(clear, "zen-closed-tabs-clear");
    clear.addEventListener("command", () => this.clear());
    popup.appendChild(clear);
  },

  // --- actions ------------------------------------------------------------

  restore(closedId) {
    try {
      SessionStore.undoCloseById(closedId, false, window);
    } catch (e) {
      console.error("[zen-closed-tabs] could not restore", e);
    }
  },

  restoreAll() {
    // Oldest first, so the restored tabs land in the order they were closed.
    for (const closedTab of this._closedTabs.slice(0, MAX_ITEMS).reverse()) {
      this.restore(closedTab.closedId);
    }
  },

  clear() {
    // forgetClosedTab takes an index, and every call renumbers the rest.
    for (let i = this.count - 1; i >= 0; i--) {
      try {
        SessionStore.forgetClosedTab(window, i);
      } catch (e) {
        break;
      }
    }
  },
};

window.addEventListener(
  "MozAfterPaint",
  () => {
    gZenClosedTabs.init();
  },
  { once: true }
);
