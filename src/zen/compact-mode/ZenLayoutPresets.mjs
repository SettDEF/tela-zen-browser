/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

// Named bundles over the existing Compact Mode prefs + tab style, so
// switching "the UI" is one choice instead of several separate toggles.
// The presets themselves, their order and their names live in
// ZenLayoutPresetData.mjs, shared with the manager in about:preferences;
// this is what turns the chosen one into an actual UI change, including at
// startup.
const { ZenLayoutPresetData } = ChromeUtils.importESModule(
  "chrome://browser/content/zen-components/ZenLayoutPresetData.mjs",
  { global: "current" }
);

const ZEN_LAYOUT_PRESET_PREF = ZenLayoutPresetData.PRESET_PREF;
const LIVE_PREFS = ZenLayoutPresetData.LIVE_PREFS;

window.gZenLayoutPresets = {
  PRESETS: ZenLayoutPresetData.PRESETS,

  init() {
    if (this._hasInitialized) {
      return;
    }
    this._hasInitialized = true;
    Services.prefs.addObserver(ZEN_LAYOUT_PRESET_PREF, this);
    for (const { live } of LIVE_PREFS) {
      Services.prefs.addObserver(live, this);
    }
    window.addEventListener(
      "unload",
      () => {
        Services.prefs.removeObserver(ZEN_LAYOUT_PRESET_PREF, this);
        for (const { live } of LIVE_PREFS) {
          Services.prefs.removeObserver(live, this);
        }
      },
      { once: true }
    );
    this.apply(this.current);
    this._buildContextMenu();
    this._watchCustomizeMode();
    this._watchWidgetStates();
  },

  /* Widget visibility is resolved from these two attributes (see
     _activeWidgetStates), and neither changes through a pref this object
     already observes - zen-has-empty-tab comes from ZenSpaceManager,
     zen-tor from ZenTor - so it needs its own watch. */
  _watchWidgetStates() {
    this._widgetStateObserver = new MutationObserver(() => this._applyWidgetVisibility());
    this._widgetStateObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["zen-has-empty-tab", "zen-tor"],
    });
    window.addEventListener("unload", () => this._widgetStateObserver.disconnect(), {
      once: true,
    });
  },

  /* XUL flex="1" is a UA-!important mapping no stylesheet can outrank, so the
     emptied browser row kept half the window in Customize Mode. Watch the
     attribute, not the events - no exit path can then leave it off. */
  _watchCustomizeMode() {
    const root = document.documentElement;
    const wrapper = document.getElementById("zen-main-app-wrapper");
    if (!wrapper) {
      return;
    }
    const sync = () => {
      if (root.hasAttribute("customizing")) {
        wrapper.removeAttribute("flex");
      } else {
        wrapper.setAttribute("flex", "1");
      }
    };
    new MutationObserver(sync).observe(root, {
      attributes: true,
      attributeFilter: ["customizing"],
    });
    sync();
  },

  /* The presets only lived in Settings and behind keybinds, which is not where
     anyone looks for them - the toolbar's own context menu is. */
  _buildContextMenu() {
    const context = document.getElementById("toolbar-context-menu");
    if (!context || document.getElementById("zen-layout-context-menu")) {
      return;
    }
    const menu = document.createXULElement("menu");
    menu.id = "zen-layout-context-menu";
    document.l10n.setAttributes(menu, "zen-layout-context-menu");
    const popup = document.createXULElement("menupopup");
    menu.appendChild(popup);

    /* Rebuilt each time rather than updated in place: the manager can have
       reordered or renamed anything since the last showing, and nine
       menuitems are cheaper than an observer per pref. */
    context.addEventListener("popupshowing", event => {
      if (event.target === context) {
        this._fillContextMenu(popup);
      }
    });
    context.appendChild(menu);
  },

  _fillContextMenu(popup) {
    const current = this.current;
    popup.replaceChildren();
    for (const name of ZenLayoutPresetData.cycle) {
      const item = document.createXULElement("menuitem");
      item.type = "radio";
      item.setAttribute("name", "zen-layout-preset");
      item.dataset.preset = name;
      const customName = ZenLayoutPresetData.nameOf(name);
      if (customName) {
        item.setAttribute("label", customName);
      } else {
        const id = ZenLayoutPresetData.isCustomSlot(name)
          ? name.replace("custom", "custom-")
          : name;
        document.l10n.setAttributes(item, `zen-layout-context-${id}`);
      }
      // Attribute presence is truthy in XUL, so this has to be set/removed.
      item.toggleAttribute("checked", name === current);
      /* Write the pref rather than calling apply() directly: apply() does not
         persist the choice, and the pref observer applies it anyway - so this
         way the menu, Settings and the keybinds all go through one path. */
      item.addEventListener("command", () =>
        Services.prefs.setStringPref(ZEN_LAYOUT_PRESET_PREF, name)
      );
      popup.appendChild(item);
    }
  },

  get current() {
    return ZenLayoutPresetData.current;
  },

  isCustomSlot(name) {
    return ZenLayoutPresetData.isCustomSlot(name);
  },

  observe(_subject, _topic, data) {
    if (data === ZEN_LAYOUT_PRESET_PREF) {
      this.apply(this.current);
      return;
    }
    // A live pref changed. If we're the ones writing it (inside apply()),
    // ignore - otherwise this is the user editing a control in Settings,
    // and if a custom slot is selected that edit needs to be remembered in
    // that slot specifically, not just left to blow away next switch.
    if (this._applying) {
      return;
    }
    const entry = LIVE_PREFS.find(e => e.live === data);
    if (!entry) {
      return;
    }
    // The widgets picker in Settings writes this pref directly (there is no
    // per-window "live" behaviour to piggyback on, unlike tab style or
    // compact mode), so re-resolving here is the only thing that applies it.
    if (data === ZenLayoutPresetData.WIDGETS_PREF) {
      this._applyWidgetVisibility();
    }
    const current = this.current;
    if (!this.isCustomSlot(current)) {
      return;
    }
    const value =
      entry.type === "bool"
        ? Services.prefs.getBoolPref(entry.live)
        : Services.prefs.getStringPref(entry.live);
    if (entry.type === "bool") {
      Services.prefs.setBoolPref(ZenLayoutPresetData.slotPrefName(current, entry.slotKey), value);
    } else {
      Services.prefs.setStringPref(
        ZenLayoutPresetData.slotPrefName(current, entry.slotKey),
        value
      );
    }
  },

  // "customN" is not one of PRESETS - it means the underlying prefs (bound
  // directly to controls in Settings, same as every other zen.* checkbox)
  // are the source of truth for that slot.
  setPreset(name) {
    if (!this.isCustomSlot(name) && !ZenLayoutPresetData.PRESETS[name]) {
      throw new Error(`Unknown layout preset: ${name}`);
    }
    Services.prefs.setStringPref(ZEN_LAYOUT_PRESET_PREF, name);
  },

  isSlotConfigured(slot) {
    return ZenLayoutPresetData.isConfigured(slot);
  },

  get cycle() {
    return ZenLayoutPresetData.cycle;
  },

  // Bound to a keyboard shortcut (Settings > Keyboard Shortcuts). Wraps
  // around; if the current pref is unrecognized, starts fresh from the
  // beginning rather than erroring. Custom slots used to be excluded
  // outright, which meant the shortcut could not reach them AND dropped you
  // back to comfortable whenever you pressed it while on one.
  cycleNext() {
    const cycle = this.cycle;
    const currentIndex = cycle.indexOf(this.current);
    const nextIndex = (currentIndex + 1) % cycle.length;
    this.setPresetShortcut(cycle[nextIndex]);
  },

  // Jump straight to one preset - bound per-slot to the four custom-layout shortcuts.
  setPresetShortcut(name) {
    this.setPreset(name);
    if (typeof gZenUIManager === "undefined") {
      return;
    }
    const customName = ZenLayoutPresetData.nameOf(name);
    if (customName) {
      gZenUIManager.showToast("zen-ui-layout-named-toast", {
        l10nArgs: { name: customName },
      });
    } else {
      gZenUIManager.showToast(`zen-ui-layout-${name}-toast`);
    }
  },

  // One path for both kinds of preset: read what it stands for, push that
  // into the live prefs, then bring the attributes and compact mode into
  // line. A custom slot used to only get the pref half, so applying one
  // never actually turned compact mode or horizontal tabs on.
  apply(name) {
    const config = ZenLayoutPresetData.configOf(name);
    document.documentElement.toggleAttribute("zen-shy-chrome", !!config.shyChrome);

    /* Write only what differs. Every window ran apply() at startup and rewrote
       these unconditionally, and a pref write relayouts the chrome — which is
       the tab strip appearing at the top for a frame and then snapping into the
       sidebar. Setting a pref to the value it already holds still notifies. */
    this._applying = true;
    try {
      for (const { live, configKey, type } of LIVE_PREFS) {
        const value = config[configKey];
        if (value === undefined) {
          continue;
        }
        if (type === "bool") {
          if (Services.prefs.getBoolPref(live, !value) !== value) {
            Services.prefs.setBoolPref(live, value);
          }
        } else if (type === "json") {
          // configOf() already decoded this one into an object, so it has
          // to go back through JSON before it can be compared to the pref.
          const serialized = JSON.stringify(value ?? {});
          if (Services.prefs.getStringPref(live, "") !== serialized) {
            Services.prefs.setStringPref(live, serialized);
          }
        } else if (Services.prefs.getStringPref(live, "") !== value) {
          Services.prefs.setStringPref(live, value);
        }
      }
    } finally {
      this._applying = false;
    }

    document.documentElement.setAttribute("zen-tab-style", config.tabStyle);
    // zen.tabs.vertical is vestigial - nothing relayouts on it - so the
    // horizontal layout is driven by this attribute and zen-horizontal-tabs.css.
    if (config.verticalTabs === false) {
      document.documentElement.setAttribute("zen-layout", "horizontal");
    } else {
      document.documentElement.removeAttribute("zen-layout");
    }

    if (
      typeof gZenCompactModeManager !== "undefined" &&
      gZenCompactModeManager.preference !== config.compactMode
    ) {
      gZenCompactModeManager.preference = config.compactMode;
    }

    this._applyWidgetVisibility();
  },

  // Which of the states a "widgets" config can target are active right now.
  // Order is not precedence here - hiddenWidgetsFor is what applies that -
  // this just reports the facts on the root element.
  _activeWidgetStates() {
    const root = document.documentElement;
    const empty = root.getAttribute("zen-has-empty-tab") === "true";
    const tor = root.hasAttribute("zen-tor");
    const states = [];
    if (empty) {
      states.push("emptyTab");
    }
    if (tor) {
      states.push("tor");
    }
    if (empty && tor) {
      states.push("torEmptyTab");
    }
    return states;
  },

  /* Presentational only: [zen-preset-hidden] is a display:none in CSS, never
     a CustomizableUI removal, so the widget keeps its place and customize
     mode (which the CSS also excludes) still shows it to drag around. */
  _applyWidgetVisibility() {
    /* The live pref, not the preset's own copy: apply() has already pushed
       a preset that pins widgets into it, and one that does not - every
       built-in - leaves it as the user's own choice, same as right-side. */
    const widgets = ZenLayoutPresetData.getLiveWidgets() ?? {};
    const hidden = new Set(
      ZenLayoutPresetData.hiddenWidgetsFor(widgets, this._activeWidgetStates())
    );
    const previous = this._hiddenWidgetIds ?? new Set();
    for (const id of new Set([...previous, ...hidden])) {
      document.getElementById(id)?.toggleAttribute("zen-preset-hidden", hidden.has(id));
    }
    this._hiddenWidgetIds = hidden;
  },
};

/* init() cannot run until session restore has finished, so these three - which
   are the whole layout as far as CSS is concerned - used to arrive about a
   second AFTER the first paint: the window came up in the sidebar layout and
   visibly rearranged. They are pure presentation and read only prefs, so they
   can be settled here at script evaluation, before initial XUL layout.
   apply() writes them again with everything else; writing the same value twice
   is free, arriving late is not. */
{
  const config = ZenLayoutPresetData.configOf(ZenLayoutPresetData.current);
  const root = document.documentElement;
  root.toggleAttribute("zen-shy-chrome", !!config.shyChrome);
  if (config.tabStyle) {
    root.setAttribute("zen-tab-style", config.tabStyle);
  }
  if (config.verticalTabs === false) {
    root.setAttribute("zen-layout", "horizontal");
  }
}
