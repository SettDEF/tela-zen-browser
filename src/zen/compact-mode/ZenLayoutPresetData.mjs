/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

// The layout presets as data: what each one is, where the custom slots keep
// their copy, what order they cycle in and what they are called. Kept apart
// from ZenLayoutPresets.mjs (which applies them to a browser window) because
// about:preferences draws the same list and must not fork a second copy of
// any of it. Everything here is backed by prefs, so both sides see one state.

const ZEN_LAYOUT_PRESETS = {
  comfortable: {
    compactMode: false,
    hideTabbar: false,
    hideToolbar: false,
    tabStyle: "comfortable",
    verticalTabs: true,
  },
  compact: {
    compactMode: true,
    hideTabbar: false,
    hideToolbar: false,
    tabStyle: "compact",
    verticalTabs: true,
  },
  minimal: {
    compactMode: true,
    /* The point of minimal: compact mode floats the sidebar over the page, so
       leaving it pinned open just covered the content it was floating over. */
    hideTabbar: true,
    hideToolbar: true,
    tabStyle: "compact",
    verticalTabs: true,
  },
  // Tabs across the top, the way a stock browser lays them out. The sidebar
  // stops being the tab strip, so compact mode has nothing to collapse.
  horizontal: {
    compactMode: false,
    hideTabbar: false,
    hideToolbar: false,
    tabStyle: "comfortable",
    verticalTabs: false,
  },
  // ShyFox-inspired: horizontal chrome, but the top bar and right rail
  // recede into the window border and only reveal on hover/focus. See
  // the `[zen-shy-chrome]` rules at the end of zen-horizontal-tabs.css.
  shy: {
    compactMode: false,
    hideTabbar: false,
    hideToolbar: false,
    tabStyle: "compact",
    verticalTabs: false,
    shyChrome: true,
  },
};

const PRESET_PREF = "zen.ui.layout-preset";
const ORDER_PREF = `${PRESET_PREF}.order`;
const WIDGETS_PREF = `${PRESET_PREF}.widgets`;

const BUILTIN_PRESETS = Object.keys(ZEN_LAYOUT_PRESETS);
const CUSTOM_SLOTS = ["custom1", "custom2", "custom3", "custom4"];
const CUSTOM_SLOT_RE = /^custom[1-4]$/;

// The states a preset can place widgets for, in precedence order (see
// hiddenWidgetsFor). Their intersection is a state of its own because "last
// active wins" cannot otherwise say "hide on the empty tab even when routed".
const WIDGET_STATES = ["normal", "emptyTab", "tor", "torEmptyTab"];

// The "live" prefs a preset drives, and the per-slot pref each is copied into.
// `configKey` is the same field name the built-in table above uses, so one
// loop can read or write either kind of preset.
const LIVE_PREFS = [
  {
    live: "zen.view.compact.enable-at-startup",
    slotKey: "compact-mode",
    configKey: "compactMode",
    type: "bool",
  },
  {
    live: "zen.view.compact.hide-tabbar",
    slotKey: "hide-tabbar",
    configKey: "hideTabbar",
    type: "bool",
  },
  {
    live: "zen.view.compact.hide-toolbar",
    slotKey: "hide-toolbar",
    configKey: "hideToolbar",
    type: "bool",
  },
  { live: "zen.tabs.style", slotKey: "tab-style", configKey: "tabStyle", type: "string" },
  {
    live: "zen.tabs.vertical.right-side",
    slotKey: "right-side",
    configKey: "rightSide",
    type: "bool",
  },
  {
    live: "zen.tabs.vertical",
    slotKey: "vertical-tabs",
    configKey: "verticalTabs",
    type: "bool",
  },
  // Which widgets a preset hides, per browser state. Unlike the prefs above
  // this drives nothing outside the preset system itself - the "live" pref
  // is simply the current window's copy, same as any other slot-backed
  // value. See hiddenWidgetsFor for how a state resolves to an actual set.
  {
    live: WIDGETS_PREF,
    slotKey: "widgets",
    configKey: "widgets",
    type: "json",
  },
];

function defaultForType(type) {
  if (type === "bool") {
    return false;
  }
  return type === "json" ? "{}" : "comfortable";
}

function getPref(name, type, fallback) {
  if (type === "bool") {
    return Services.prefs.getBoolPref(name, fallback);
  }
  if (type === "json") {
    try {
      return JSON.parse(Services.prefs.getStringPref(name, fallback));
    } catch {
      return {};
    }
  }
  return Services.prefs.getStringPref(name, fallback);
}

function setPref(name, type, value) {
  if (type === "bool") {
    Services.prefs.setBoolPref(name, value);
  } else if (type === "json") {
    Services.prefs.setStringPref(name, JSON.stringify(value ?? {}));
  } else {
    Services.prefs.setStringPref(name, value);
  }
}

export const ZenLayoutPresetData = {
  PRESETS: ZEN_LAYOUT_PRESETS,
  BUILTIN_PRESETS,
  CUSTOM_SLOTS,
  LIVE_PREFS,
  PRESET_PREF,
  ORDER_PREF,

  get current() {
    return Services.prefs.getStringPref(PRESET_PREF, "comfortable");
  },

  isCustomSlot(name) {
    return CUSTOM_SLOT_RE.test(name);
  },

  slotPrefName(slot, key) {
    return `${PRESET_PREF}.${slot}.${key}`;
  },

  // A slot counts as configured once it has been saved into, or - for slots
  // set up before there was a save button - once selecting it in Settings
  // gave any of its prefs a user value.
  isConfigured(name) {
    if (!this.isCustomSlot(name)) {
      return true;
    }
    return (
      Services.prefs.getBoolPref(this.slotPrefName(name, "saved"), false) ||
      LIVE_PREFS.some(({ slotKey }) =>
        Services.prefs.prefHasUserValue(this.slotPrefName(name, slotKey))
      )
    );
  },

  // Empty means "no name of its own"; the caller falls back to the localized
  // label, which is why this never invents "Custom 1" itself.
  nameOf(name) {
    if (!this.isCustomSlot(name)) {
      return "";
    }
    return Services.prefs.getStringPref(this.slotPrefName(name, "name"), "").trim();
  },

  setName(slot, value) {
    const pref = this.slotPrefName(slot, "name");
    const trimmed = (value ?? "").trim();
    if (trimmed) {
      Services.prefs.setStringPref(pref, trimmed);
    } else {
      Services.prefs.clearUserPref(pref);
    }
  },

  // The stored order, repaired: unknown ids dropped, known ones that are
  // missing appended. A preset added in a later version therefore shows up
  // for someone who has already dragged their list around.
  get order() {
    const known = [...BUILTIN_PRESETS, ...CUSTOM_SLOTS];
    const stored = Services.prefs
      .getStringPref(ORDER_PREF, "")
      .split(",")
      .map(id => id.trim())
      .filter((id, index, all) => known.includes(id) && all.indexOf(id) === index);
    return stored.concat(known.filter(id => !stored.includes(id)));
  },

  set order(list) {
    const known = [...BUILTIN_PRESETS, ...CUSTOM_SLOTS];
    const clean = list.filter(
      (id, index) => known.includes(id) && list.indexOf(id) === index
    );
    Services.prefs.setStringPref(
      ORDER_PREF,
      clean.concat(known.filter(id => !clean.includes(id))).join(",")
    );
  },

  // What the keybind and the context menu walk: the user's order, minus the
  // slots that hold nothing - an empty stop would apply whatever the live
  // prefs happen to be.
  get cycle() {
    return this.order.filter(name => this.isConfigured(name));
  },

  // The arrangement a preset stands for, in the same shape for both kinds.
  // Built-ins leave out what they do not claim (right-side is the user's own
  // choice, not part of a preset), and those keys stay undefined here.
  configOf(name) {
    if (!this.isCustomSlot(name)) {
      return ZEN_LAYOUT_PRESETS[name] ?? ZEN_LAYOUT_PRESETS.comfortable;
    }
    const config = {};
    for (const { slotKey, configKey, type } of LIVE_PREFS) {
      config[configKey] = getPref(this.slotPrefName(name, slotKey), type, defaultForType(type));
    }
    return config;
  },

  // The arrangement the window is in right now, ready to be stored in a slot.
  liveConfig() {
    const config = {};
    for (const { live, configKey, type } of LIVE_PREFS) {
      config[configKey] = getPref(live, type, defaultForType(type));
    }
    return config;
  },

  saveToSlot(slot, config = this.liveConfig()) {
    for (const { slotKey, configKey, type } of LIVE_PREFS) {
      setPref(this.slotPrefName(slot, slotKey), type, config[configKey]);
    }
    Services.prefs.setBoolPref(this.slotPrefName(slot, "saved"), true);
  },

  resetSlot(slot) {
    for (const { slotKey } of LIVE_PREFS) {
      Services.prefs.clearUserPref(this.slotPrefName(slot, slotKey));
    }
    Services.prefs.clearUserPref(this.slotPrefName(slot, "saved"));
    Services.prefs.clearUserPref(this.slotPrefName(slot, "name"));
  },

  WIDGETS_PREF,
  WIDGET_STATES,

  getLiveWidgets() {
    return getPref(WIDGETS_PREF, "json", "{}");
  },

  setLiveWidgets(widgets) {
    setPref(WIDGETS_PREF, "json", widgets);
  },

  // The widget set actually in force: start from "normal", then let each
  // state that is currently active - walked in WIDGET_STATES order - replace
  // the working set when the preset defines something for it. A state with
  // nothing defined changes nothing, so "a state that specifies nothing
  // inherits the default" falls out of the same rule. Order is precedence:
  // torEmptyTab is walked last, so it has the final word when a Tor window
  // or space is showing its empty tab.
  hiddenWidgetsFor(widgets, activeStates) {
    let hidden = widgets?.normal ?? [];
    for (const state of WIDGET_STATES) {
      if (state !== "normal" && activeStates.includes(state) && widgets?.[state]) {
        hidden = widgets[state];
      }
    }
    return hidden;
  },
};
