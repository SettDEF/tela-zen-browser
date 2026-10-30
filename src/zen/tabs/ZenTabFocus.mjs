/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Focus effects for the selected tab. A preset is just a set of values for
   the same variables, so picking one and hand-tuning it share a code path:
   nudge anything and the preset becomes "custom". */

const HTML_NS = "http://www.w3.org/1999/xhtml";
const PREF = "zen.tabs.focus.";

const PRESETS = [
  { id: "siren", a: "#ff3b3b", b: "#3b6bff", speed: 2400, blur: 14, size: 70, intensity: 85 },
  { id: "beacon", a: "#ffb03b", b: "#ffe08a", speed: 3200, blur: 12, size: 65, intensity: 80 },
  { id: "scanner", a: "#ff2d2d", b: "#ff8a3c", speed: 1600, blur: 16, size: 60, intensity: 90 },
  { id: "pulse", a: "#a9b4d1", b: "#a9b4d1", speed: 2800, blur: 18, size: 75, intensity: 70 },
  { id: "aurora", a: "#3fd48a", b: "#4a7fe0", speed: 9000, blur: 22, size: 80, intensity: 65 },
  /* Nothing runs at rest. The mark travels to the tab you just picked,
     smearing along the way, and stops - kitty's cursor_trail and Neovide's
     animated cursor, not a loop. */
  { id: "trail", a: "#a9b4d1", b: "#6f8cff", speed: 260, blur: 8, size: 70, intensity: 90 },
  { id: "flat", a: "#a9b4d1", b: "#a9b4d1", speed: 0, blur: 0, size: 70, intensity: 0 },
];

const SWATCHES = [
  "#ff3b3b", "#ff8a3c", "#ffd23c", "#5fcf6a", "#3fd48a", "#3fc4d4",
  "#3b6bff", "#8a4ae0", "#d05ac0", "#a9b4d1", "#e2e2e2", "#6b6b78",
];

const SLIDERS = [
  { key: "speed", min: 600, max: 12000, step: 100, unit: "ms" },
  { key: "blur", min: 0, max: 40, step: 1, unit: "px" },
  { key: "size", min: 30, max: 100, step: 1, unit: "%" },
  { key: "intensity", min: 0, max: 100, step: 1, unit: "%" },
];

const TOGGLES = [{ key: "hover" }, { key: "reverse" }];

const TRIGGERS = ["selected", "hover", "loading", "audio"];

// Subtle keeps the light inside the tab at half strength.
const STRENGTH = { full: 1, subtle: 0.5, off: 0 };
const LOOK = "zen.tabs.look.";
const LOOK_PREFS = ["selected", "hover-shade", "close", "radius", "height", "folder-gap", "color"];

window.gZenTabFocus = {
  _layers: new Map(),
  _panel: null,
  _colorPanel: null,
  _layer: null,
  _halo: null,
  _contextTab: null,

  // Parsed once per change of the pref; painting reads it for every tab.
  get siteColors() {
    const raw = Services.prefs.getStringPref(PREF + "site-colors", "{}");
    if (raw !== this._siteRaw) {
      this._siteRaw = raw;
      try {
        this._siteMap = JSON.parse(raw) || {};
      } catch {
        this._siteMap = {};
      }
    }
    return { ...this._siteMap };
  },

  saveSiteColors(map) {
    Services.prefs.setStringPref(PREF + "site-colors", JSON.stringify(map));
  },

  /* Keyed by host, so every tab on a site shares its colour and a tab opened
     there tomorrow picks it up without being told. */
  hostFor(tab) {
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

  setSiteColor(tab, which, color) {
    const host = this.hostFor(tab);
    if (!host) {
      return false;
    }
    const map = this.siteColors;
    map[host] = { ...(map[host] || {}), [which]: color };
    this.saveSiteColors(map);
    this._paintTabColors();
    this._trackSelected();
    return true;
  },

  clearSiteColor(host) {
    const map = this.siteColors;
    delete map[host];
    this.saveSiteColors(map);
    this._paintTabColors();
    this._trackSelected();
  },

  /* Per-tab colour, the narrowest scope and the default one. Kept in the
     session store rather than on the element, so it survives a restart and
     rides along when the tab is torn out into another window. */
  tabColors(tab) {
    try {
      return JSON.parse(SessionStore.getCustomTabValue(tab, "zenTabFocusColor") || "{}");
    } catch {
      return {};
    }
  },

  setTabColor(tab, which, color) {
    if (!tab) {
      return false;
    }
    const map = { ...this.tabColors(tab), [which]: color };
    SessionStore.setCustomTabValue(tab, "zenTabFocusColor", JSON.stringify(map));
    this._paintTabColors();
    this._trackSelected();
    return true;
  },

  clearTabColor(tab) {
    if (!tab) {
      return;
    }
    SessionStore.setCustomTabValue(tab, "zenTabFocusColor", "{}");
    this._paintTabColors();
    this._trackSelected();
  },

  /* Tor first - a routed tab must not be repaintable as an ordinary one -
     then this tab, then this site, then the global colour. */
  colorFor(tab, which) {
    const tor = window.gZenTor?.focusColor(tab, which);
    if (tor) {
      return tor;
    }
    const own = this.tabColors(tab)[which];
    if (own) {
      return own;
    }
    const site = this.siteColors[this.hostFor(tab)] || {};
    return site[which] || null;
  },

  get preset() {
    return Services.prefs.getStringPref(PREF + "preset", "siren");
  },

  get strength() {
    const value = Services.prefs.getStringPref(PREF + "strength", "full");
    return value in STRENGTH ? value : "full";
  },

  // What the stylesheet sees: off draws exactly what Flat draws.
  get _effectivePreset() {
    return this.strength === "off" ? "flat" : this.preset;
  },

  num(key) {
    const fallback = PRESETS.find(p => p.id === "siren")[key];
    return Services.prefs.getIntPref(PREF + key, fallback);
  },

  color(which) {
    const preset = PRESETS.find(p => p.id === this.preset) || PRESETS[0];
    return Services.prefs.getStringPref(PREF + "color-" + which, preset[which]);
  },

  bool(key) {
    if (key === "gpu") {
      return Services.prefs.getBoolPref(PREF + "gpu", true);
    }
    return Services.prefs.getBoolPref(PREF + key, false);
  },

  init() {
    if (this._inited) {
      return;
    }
    this._inited = true;
    /* Created before the first attach: built afterwards, the initial layer had
       nothing watching it and a splitter drag went unnoticed. */
    this._sizeObserver = new ResizeObserver(() => this._scheduleTrack());
    this.apply();
    this._buildMenu();
    this._attachLayers();
    for (const ev of ["TabSelect", "TabOpen", "TabClose", "TabMove",
                      "TabAttrModified"]) {
      gBrowser.tabContainer.addEventListener(ev, () => this._scheduleAttach());
    }
    /* Hover is a trigger like any other, so the tab under the pointer has to
       be tracked even when nothing else changes. */
    gBrowser.tabContainer.addEventListener("mouseover", event => {
      const tab = event.target.closest(".tabbrowser-tab");
      if (tab !== this._hoverTab) {
        this._hoverTab = tab;
        this._scheduleAttach();
      }
    });
    gBrowser.tabContainer.addEventListener("mouseleave", () => {
      if (this._hoverTab) {
        this._hoverTab = null;
        this._scheduleAttach();
      }
    });
    gBrowser.addProgressListener({
      onLocationChange: (progress) => {
        if (progress.isTopLevel) {
          this._scheduleTrack();
        }
      },
    });
    gBrowser.addTabsProgressListener({
      onLocationChange: (browser, progress) => {
        if (progress.isTopLevel) {
          this._paintTabColors();
          this._scheduleTrack();
        }
      },
    });
    const wrapper = document.getElementById("zen-tabs-wrapper");
    wrapper?.addEventListener("scroll", () => this._scheduleTrack(), { passive: true });
    window.addEventListener("resize", () => this._scheduleTrack());

    for (const key of ["preset", "color-a", "color-b", "speed", "blur", "size",
                       "intensity", "hover", "reverse", "gpu", "strength",
                       ...TRIGGERS.map(t => t + ".enabled")]) {
      Services.prefs.addObserver(PREF + key, this);
    }
    for (const key of LOOK_PREFS) {
      Services.prefs.addObserver(LOOK + key, this);
    }
  },

  observe() {
    this.apply();
  },

  /* Tracking reads the tab's box, which forces layout. Running that straight
     off resize meant one forced reflow per event while the sidebar animates
     its width - coalesce to one per frame instead. */
  _scheduleTrack() {
    this._markBusy();
    if (this._trackRaf) {
      return;
    }
    this._trackRaf = requestAnimationFrame(() => {
      this._trackRaf = 0;
      this._trackSelected();
    });
  },

  /* Restoring a session fires TabOpen and TabAttrModified dozens of times and
     an attach pass costs a forced style and layout flush each - 97ms of the
     launch window, measured. Coalescing to one pass per frame also moves the
     flush inside a tick that was going to lay out anyway. */
  _scheduleAttach() {
    if (this._attachRaf) {
      return;
    }
    this._attachRaf = requestAnimationFrame(() => {
      this._attachRaf = 0;
      this._attachLayers();
    });
  },

  /* kitty's model: a jump shorter than the threshold is not worth a trail, and
     the smear scales with distance rather than being a fixed flourish. The
     transform is set, then cleared on the next frame - the transition between
     the two is the whole animation, and it runs on the compositor. */
  _smear(pair, trigger, centre, height) {
    const last = this._lastCentre?.get(trigger);
    this._lastCentre ??= new Map();
    this._lastCentre.set(trigger, centre);
    const travel = last === undefined ? 0 : centre - last;
    /* kitty's start threshold is two cells, not one: stepping to the tab next
       door should stay calm and only a real jump earns a trail. */
    if (Math.abs(travel) < height * 1.2) {
      return;
    }
    // Eases off rather than saturating, so a medium jump reads shorter than a
    // long one instead of both hitting the cap.
    const stretch = 1 + 2 * (1 - Math.exp(-Math.abs(travel) / (height * 4)));
    this._clearTrail();
    for (const el of [pair.layer, pair.halo]) {
      el.style.setProperty("--zen-trail-from", `${-travel}px`);
      el.style.setProperty("--zen-trail-stretch", stretch.toFixed(3));
      el.style.setProperty("transform-origin", travel > 0 ? "center top" : "center bottom");
      el.setAttribute("trail-start", "true");
    }
    cancelAnimationFrame(this._trailRaf);
    /* Cleared by querying the document, not the pair captured here: rebuilding
       the layers between arming and clearing left the mark on a live element
       while the clear went to an orphan, and the smear stuck. */
    this._trailRaf = requestAnimationFrame(() =>
      requestAnimationFrame(() => this._clearTrail())
    );
  },

  _clearTrail() {
    for (const el of document.querySelectorAll("[trail-start]")) {
      el.removeAttribute("trail-start");
    }
  },

  _radiusFor(element) {
    if (this._radiusOf !== element) {
      this._radiusOf = element;
      this._radius =
        getComputedStyle(element).borderTopLeftRadius || "14px";
    }
    return this._radius;
  },

  /* While the geometry keeps moving, stop paying for the glow: the blurred
     dots repaint every frame on the main thread and that is what makes the
     sidebar animation stutter. Resumes 200ms after things settle. */
  _markBusy() {
    const root = document.documentElement;
    // Re-setting it is a root attribute change, and that restyles the document.
    if (!root.hasAttribute("zen-tab-focus-busy")) {
      root.setAttribute("zen-tab-focus-busy", "true");
    }
    clearTimeout(this._busyTimer);
    this._busyTimer = setTimeout(() => {
      root.removeAttribute("zen-tab-focus-busy");
      this._trackSelected();
    }, 200);
  },

  /* One layer pair PER EVENT, not one for the selected tab. Every trigger
     draws the same animation - only its variables differ - so a tab can glow
     for being selected, hovered, loading or playing sound, each with its own
     colours, and each switched on independently. */
  _targetFor(trigger) {
    switch (trigger) {
      case "selected":
        return gBrowser.selectedTab;
      case "hover":
        return this._hoverTab?.isConnected ? this._hoverTab : null;
      case "loading":
        return gBrowser.tabs.find(t => t.hasAttribute("busy") && !t.closing) || null;
      case "audio":
        return gBrowser.tabs.find(t => t.hasAttribute("soundplaying") && !t.closing) || null;
      default:
        return null;
    }
  },

  triggerEnabled(trigger) {
    if (this.strength === "off") {
      return false;
    }
    return Services.prefs.getBoolPref(
      `${PREF}${trigger}.enabled`,
      trigger === "selected"
    );
  },

  /* A trigger's own value, falling back to the global one when unset - so
     turning a trigger on gives something sensible with nothing configured. */
  triggerValue(trigger, key, fallback) {
    try {
      const pref = `${PREF}${trigger}.${key}`;
      if (Services.prefs.prefHasUserValue(pref)) {
        return Services.prefs.getStringPref(pref);
      }
    } catch {
      // Not set, or set as another type; the global value stands.
    }
    return fallback;
  },

  _containerFor(tab) {
    return (
      tab?.closest(
        ".zen-workspace-tabs-section, #zen-essentials, .zen-essentials-container, " +
          "#vertical-pinned-tabs-container, .zen-workspace-pinned-tabs-section"
      ) ||
      tab?.parentElement ||
      document.getElementById("zen-tabs-wrapper")
    );
  },

  _buildPair(trigger, list) {
    /* Two copies: one clipped to the tab at full strength, one unclipped
       behind it at 10%. A single masked layer could not express "full inside
       the tab, a tenth outside" - the stops are relative to the layer. */
    const make = extra => {
      const layer = document.createElementNS(HTML_NS, "div");
      layer.className = "zen-tab-focus-layer" + extra;
      layer.setAttribute("trigger", trigger);
      for (const name of ["a1", "a2", "b1", "b2"]) {
        /* The dot sits inside a wrapper the animation rotates. Rotation is a
           transform, which Gecko runs on the compositor - offset-distance,
           what the travel used, is main-thread only (bug 1429305). */
        const spin = document.createElementNS(HTML_NS, "div");
        spin.className = "zen-tab-focus-spin zen-tab-focus-spin-" + name;
        const dot = document.createElementNS(HTML_NS, "div");
        dot.className = "zen-tab-focus-dot zen-tab-focus-dot-" + name;
        if (name.startsWith("a")) {
          dot.style.setProperty("--wobble", (2.3 + Math.random() * 1.9).toFixed(2) + "s");
          dot.style.setProperty("--wobble-delay", (-Math.random() * 2).toFixed(2) + "s");
        }
        spin.append(dot);
        layer.append(spin);
      }
      list.prepend(layer);
      return layer;
    };
    return { halo: make(" zen-tab-focus-halo"), layer: make("") };
  },

  _attachLayers() {
    this._paintTabColors();
    for (const trigger of TRIGGERS) {
      const enabled = this.triggerEnabled(trigger);
      const tab = enabled ? this._targetFor(trigger) : null;
      const pair = this._layers.get(trigger);
      if (!tab) {
        pair?.layer.remove();
        pair?.halo.remove();
        this._layers.delete(trigger);
        continue;
      }
      const list = this._containerFor(tab);
      if (!list) {
        continue;
      }
      if (!pair || !pair.layer.isConnected || pair.layer.parentElement !== list) {
        pair?.layer.remove();
        pair?.halo.remove();
        this._layers.set(trigger, this._buildPair(trigger, list));
        /* Only when the pair moves: an unchanged container was positioned on
           the pass that first put a layer in it, and asking again is a forced
           style flush per pass. */
        if (getComputedStyle(list).position === "static") {
          list.style.position = "relative";
        }
      }
    }
    this._trackSelected();
  },

  /* Each tab's own colour (tab, then site) as --zen-tab-color, for the
     selection and tint rules in zen-tabs.css. */
  _paintTabColors() {
    const tiles = window.gZenHorizontalTabs?._rows;
    for (const tab of gBrowser.tabs) {
      const color = this.colorFor(tab, "a");
      // The horizontal strip draws its own tile per tab; it gets the same.
      for (const el of [tab, tiles?.get(tab)]) {
        if (!el) {
          continue;
        }
        if (color) {
          if (el.style.getPropertyValue("--zen-tab-color") !== color) {
            el.style.setProperty("--zen-tab-color", color);
          }
          el.setAttribute("zen-tab-colored", "true");
        } else if (el.hasAttribute("zen-tab-colored")) {
          el.style.removeProperty("--zen-tab-color");
          el.removeAttribute("zen-tab-colored");
        }
      }
    }
  },

  /* Follow each trigger's tab, in its container's coordinate space. */
  _trackSelected() {
    for (const [trigger, pair] of [...this._layers]) {
      const tab = this._targetFor(trigger);
      const parent = pair.layer.parentElement;
      const hide = on => {
        pair.layer.hidden = on;
        pair.halo.hidden = on;
      };
      /* Nothing to light up: hide rather than leave the layer at the last
         tab's geometry, still animating over empty space. */
      if (!tab || !parent || tab.closing || tab.hidden) {
        hide(true);
        continue;
      }
      const visible = tab.querySelector(".tab-background") || tab;
      if (trigger === "selected" && this._sizeObserver && this._observed !== visible) {
        this._sizeObserver.disconnect();
        this._sizeObserver.observe(visible);
        this._sizeObserver.observe(parent);
        this._observed = visible;
      }
      const t = visible.getBoundingClientRect();
      const p = parent.getBoundingClientRect();
      if (!t.width || !t.height) {
        hide(true);
        continue;
      }
      hide(false);

      const px = n => n.toFixed(2) + "px";
      const vars = {
        "--zen-tab-x": px(t.left - p.left + t.width / 2),
        "--zen-tab-y": px(t.top - p.top + t.height / 2),
        "--zen-tab-w": px(t.width),
        "--zen-tab-h": px(t.height),
        "--zen-tab-ratio": (t.width / t.height).toFixed(3),
        // The radius comes from the tab, so clip and travel share one shape.
        // Cached per element: getComputedStyle is a second style flush on top
        // of the two rects, and it costs that every frame of a drag for a
        // value that only changes with the tab style.
        "--zen-tab-radius": this._radiusFor(visible),
      };
      // This tab, then its site, then the trigger's own colour, then global.
      const a = this.colorFor(tab, "a") || this.triggerValue(trigger, "color-a", this.color("a"));
      const b = this.colorFor(tab, "b") || this.triggerValue(trigger, "color-b", this.color("b"));
      vars["--zen-tab-a"] = a;
      vars["--zen-tab-b"] = b || a;
      vars["--zen-tab-speed"] =
        this.triggerValue(trigger, "speed", this.num("speed") + "ms") + "";
      vars["--zen-tab-intensity"] = String(
        Number(this.triggerValue(trigger, "intensity", String(this.num("intensity") / 100))) *
          STRENGTH[this.strength]
      );

      /* Nothing moved: a drag fires this every frame, and rewriting identical
         custom properties still invalidates style for the whole subtree. */
      const signature = JSON.stringify(vars);
      if (pair.signature === signature) {
        continue;
      }
      pair.signature = signature;
      if (this._effectivePreset === "trail") {
        this._smear(pair, trigger, t.top - p.top + t.height / 2, t.height);
      }
      for (const el of [pair.layer, pair.halo]) {
        for (const [key, value] of Object.entries(vars)) {
          el.style.setProperty(key, value);
        }
      }
    }
  },

  /* Everything the stylesheet reads lives on :root, so a pref change repaints
     without touching a single tab element. */
  apply() {
    const root = document.documentElement;
    const preset = this._effectivePreset;
    root.setAttribute("zen-tab-focus", preset);
    root.setAttribute("zen-tab-focus-strength", this.strength);
    root.toggleAttribute("zen-tab-focus-gpu", this.bool("gpu"));
    /* The loading stripe is drawn in CSS off [busy], so it needs the trigger
       and the preset surfaced here or it runs even on Flat (off). */
    root.toggleAttribute(
      "zen-tab-focus-loading",
      preset !== "flat" && this.triggerEnabled("loading")
    );
    root.toggleAttribute("zen-tab-focus-hover", this.bool("hover"));
    if (this.bool("hover")) {
      root.setAttribute("zen-tab-focus-hover", "true");
    }
    const style = root.style;
    style.setProperty("--zen-tab-a", this.color("a"));
    style.setProperty("--zen-tab-b", this.color("b"));
    style.setProperty("--zen-tab-speed", this.num("speed") + "ms");
    style.setProperty("--zen-tab-blur", this.num("blur") + "px");
    style.setProperty("--zen-tab-size", this.num("size") + "%");
    style.setProperty("--zen-tab-intensity", (this.num("intensity") / 100) * STRENGTH[this.strength]);
    style.setProperty("--zen-tab-direction", this.bool("reverse") ? "reverse" : "normal");
    this._applyLook();
    // Strength and the triggers it gates decide whether layers exist at all.
    for (const pair of this._layers.values()) {
      pair.signature = null;
    }
    this._radiusOf = null;
    this._scheduleAttach();
  },

  /* Tab looks: attributes and variables on :root, read by zen-tabs.css. */
  _applyLook() {
    const root = document.documentElement;
    const str = (key, fallback) => Services.prefs.getStringPref(LOOK + key, fallback);
    const int = (key, fallback) => Services.prefs.getIntPref(LOOK + key, fallback);
    root.setAttribute("zen-tab-selected", str("selected", "mark"));
    root.setAttribute("zen-tab-color", str("color", "selected"));
    root.setAttribute("zen-tab-close", str("close", "hover"));
    root.toggleAttribute("zen-tab-no-hover-shade", !Services.prefs.getBoolPref(LOOK + "hover-shade", true));
    const px = (attr, prop, value) => {
      root.toggleAttribute(attr, value >= 0);
      if (value >= 0) {
        root.style.setProperty(prop, value + "px");
      } else {
        root.style.removeProperty(prop);
      }
    };
    px("zen-tab-radius", "--zen-tab-look-radius", int("radius", -1));
    px("zen-tab-height", "--zen-tab-look-height", int("height", -1));
    px("zen-folder-gap", "--zen-folder-gap", int("folder-gap", 6));
  },

  usePreset(id) {
    const preset = PRESETS.find(p => p.id === id);
    if (!preset) {
      return;
    }
    Services.prefs.setStringPref(PREF + "preset", id);
    Services.prefs.setStringPref(PREF + "color-a", preset.a);
    Services.prefs.setStringPref(PREF + "color-b", preset.b);
    for (const key of ["speed", "blur", "size", "intensity"]) {
      Services.prefs.setIntPref(PREF + key, preset[key]);
    }
  },

  // --- menu ----------------------------------------------------------

  _buildMenu() {
    const context = document.getElementById("tabContextMenu");
    if (!context || document.getElementById("zen-tab-focus-menu")) {
      return;
    }

    const menu = document.createXULElement("menu");
    menu.id = "zen-tab-focus-menu";
    document.l10n.setAttributes(menu, "zen-tab-focus-menu");
    const popup = document.createXULElement("menupopup");
    menu.append(popup);

    /* Colour first, then the animation that uses it. This one is a plain
       item opening a panel: swatch rows do not lay out inside a menupopup,
       only inside a panel. */
    const colorMenu = document.createXULElement("menuitem");
    colorMenu.id = "zen-tab-focus-color-menu";
    document.l10n.setAttributes(colorMenu, "zen-tab-focus-colors");
    colorMenu.setAttribute("closemenu", "none");
    context.addEventListener("popupshowing", event => {
      if (event.target === context) {
        this._contextTab = TabContextMenu.contextTab || gBrowser.selectedTab;
      }
    });
    const openColors = () => {
      this._overItem = true;
      this._cancelColorClose();
      this._openColorPanel(colorMenu);
    };
    colorMenu.addEventListener("DOMMenuItemActive", openColors);
    colorMenu.addEventListener("command", openColors);
    colorMenu.addEventListener("DOMMenuItemInactive", () => {
      this._overItem = false;
      this._scheduleColorClose();
    });

    const animMenu = document.createXULElement("menu");
    animMenu.id = "zen-tab-focus-anim-menu";
    document.l10n.setAttributes(animMenu, "zen-tab-focus-animation");
    const animPopup = document.createXULElement("menupopup");
    animMenu.append(animPopup);

    popup.append(colorMenu, animMenu, document.createXULElement("menuseparator"));

    for (const toggle of TOGGLES) {
      const item = document.createXULElement("menuitem");
      item.setAttribute("type", "checkbox");
      document.l10n.setAttributes(item, "zen-tab-focus-" + toggle.key);
      item.setAttribute("closemenu", "none");
      item.addEventListener("command", () => {
        Services.prefs.setBoolPref(PREF + toggle.key, !this.bool(toggle.key));
      });
      item.addEventListener("zen-refresh", () => {
        // checked="false" is still a present attribute in XUL, and rendered as
        // ticked - the state has to be added and removed, not set to a string.
        item.toggleAttribute("checked", this.bool(toggle.key));
      });
      popup.append(item);
      item.dispatchEvent(new CustomEvent("zen-refresh"));
    }

    /* Change Label, Change Icon and the colours are all per-tab appearance,
       so they live behind one entry instead of three. In XUL a submenu is a
       <menu> wrapping a <menupopup>, which is what this builds. */
    const anchor = document.getElementById("context_zen-edit-tab-icon");
    if (!anchor) {
      context.append(document.createXULElement("menuseparator"), menu);
      return;
    }

    const parent = document.createXULElement("menu");
    parent.id = "context_zenTabAppearance";
    document.l10n.setAttributes(parent, "zen-tab-appearance-menu");
    const parentPopup = document.createXULElement("menupopup");
    parent.append(parentPopup);
    anchor.after(parent);

    for (const id of ["context_zen-edit-tab-title", "context_zen-edit-tab-icon"]) {
      const item = document.getElementById(id);
      if (item) {
        parentPopup.append(item);
      }
    }
    parentPopup.append(menu);
    // A tab's colour is the first thing people look for: top level, not in Focus.
    document.l10n.setAttributes(colorMenu, "zen-tab-color-menu");
    parentPopup.insertBefore(colorMenu, menu);

    /* Moving those two out can leave the separators that framed them sitting
       next to each other. Only ever hide an ANONYMOUS one: Firefox looks its
       own separators up by id while building the menu (context_moveTabTo-
       GroupSeparator among them), and removing one threw inside
       updateContextMenu - which then never labelled Mute Tab or hid Ask Chat,
       leaving two blank rows behind. */
    for (const sep of [...context.querySelectorAll(":scope > menuseparator")]) {
      const prev = sep.previousElementSibling;
      if (!sep.id && (!prev || prev.tagName === "menuseparator")) {
        sep.hidden = true;
      }
    }

    animPopup.addEventListener("popupshowing", event => {
      if (event.target === animPopup) {
        this._fillAnimation(animPopup);
      }
    });
    context.addEventListener("popuphidden", event => {
      if (event.target === context) {
        this._colorPanel?.hidePopup();
      }
    });

    popup.addEventListener("popupshowing", event => {
      if (event.target !== popup) {
        return;
      }
      for (const item of popup.querySelectorAll("menuitem[type=checkbox]")) {
        item.dispatchEvent(new CustomEvent("zen-refresh"));
      }
    });
  },

  /* Closes once the pointer is on neither the menu entry nor the panel.
     The delay covers the gap between them; the :hover test catches a
     mouseleave fired by rebuilding the swatches under the cursor. */
  _scheduleColorClose() {
    this._cancelColorClose();
    this._colorCloseTimer = setTimeout(() => {
      this._colorCloseTimer = null;
      const panel = this._colorPanel;
      if (!panel || this._overItem || this._overPanel || panel.matches(":hover")) {
        return;
      }
      panel.hidePopup();
    }, 260);
  },

  _cancelColorClose() {
    if (this._colorCloseTimer) {
      clearTimeout(this._colorCloseTimer);
      this._colorCloseTimer = null;
    }
  },

  _openColorPanel(anchor) {
    const panel = this._ensureColorPanel();
    this._fillColors(panel.querySelector(".zen-tab-focus-colors"));
    if (panel.state === "open" || panel.state === "showing") {
      return;
    }
    panel.openPopup(this._anchorFor(anchor), "end_before", 6, 0);
  },

  _ensureColorPanel() {
    if (this._colorPanel) {
      return this._colorPanel;
    }
    const panel = document.createXULElement("panel");
    panel.id = "zen-tab-focus-color-panel";
    panel.setAttribute("noautofocus", "true");
    panel.setAttribute("rolluponmousewheel", "true");

    panel.addEventListener("mouseenter", () => {
      this._overPanel = true;
      this._cancelColorClose();
    });
    panel.addEventListener("mouseleave", () => {
      this._overPanel = false;
      this._scheduleColorClose();
    });
    panel.addEventListener("popuphidden", () => {
      this._overPanel = false;
      this._cancelColorClose();
    });

    const body = document.createElementNS(HTML_NS, "div");
    body.className = "zen-tab-focus-colors";
    panel.append(body);
    document.getElementById("mainPopupSet").append(panel);
    this._colorPanel = panel;
    return panel;
  },

  _fillColors(body) {
    body.textContent = "";

    /* A swatch paints THIS TAB only. Ticking the box promotes that colour to
       the whole site, so every tab there - now and tomorrow - picks it up. */
    const tabForHost = this._contextTab || gBrowser.selectedTab;
    const host = this.hostFor(tabForHost);
    const remember = document.createElementNS(HTML_NS, "label");
    remember.className = "zen-tab-focus-remember";
    const box = document.createElementNS(HTML_NS, "input");
    box.type = "checkbox";
    box.checked = !!(host && this.siteColors[host]);
    box.disabled = !host;
    box.addEventListener("change", () => {
      if (!host) {
        return;
      }
      if (box.checked) {
        // Promote whatever this tab is showing, not the global colour.
        this.setSiteColor(tabForHost, "a", this.colorFor(tabForHost, "a") || this.color("a"));
        this.setSiteColor(tabForHost, "b", this.colorFor(tabForHost, "b") || this.color("b"));
      } else {
        this.clearSiteColor(host);
      }
      this._fillColors(body);
    });
    const text = document.createElementNS(HTML_NS, "span");
    if (host) {
      document.l10n.setAttributes(text, "zen-tab-focus-remember-site", { host });
    } else {
      document.l10n.setAttributes(text, "zen-tab-focus-remember-none");
    }
    remember.append(box, text);

    const reset = document.createElementNS(HTML_NS, "button");
    reset.className = "zen-tab-focus-reset";
    document.l10n.setAttributes(reset, "zen-tab-focus-reset");
    reset.addEventListener("click", event => {
      event.stopPropagation();
      this.clearTabColor(tabForHost);
      this._fillColors(body);
    });
    remember.append(reset);
    body.append(remember);
    for (const [which, l10nId] of [["a", "zen-tab-focus-primary"], ["b", "zen-tab-focus-secondary"]]) {
      const section = document.createElementNS(HTML_NS, "div");
      section.className = "zen-tab-focus-color-section";

      const caption = document.createElementNS(HTML_NS, "div");
      caption.className = "zen-tab-focus-color-caption";
      const dot = document.createElementNS(HTML_NS, "span");
      dot.className = "zen-tab-focus-color-current";
      dot.style.background = this.color(which);
      const text = document.createElementNS(HTML_NS, "span");
      document.l10n.setAttributes(text, l10nId);
      caption.append(dot, text);

      const grid = document.createElementNS(HTML_NS, "div");
      grid.className = "zen-tab-focus-color-grid";
      const ctxTab = this._contextTab || gBrowser.selectedTab;
      const current = this.colorFor(ctxTab, which) || this.color(which);
      for (const color of SWATCHES) {
        const swatch = document.createElementNS(HTML_NS, "button");
        swatch.className = "zen-tab-focus-swatch";
        swatch.style.background = color;
        swatch.toggleAttribute("selected", color.toLowerCase() === current.toLowerCase());
        swatch.addEventListener("click", event => {
          event.stopPropagation();
          const tab = this._contextTab || gBrowser.selectedTab;
          this.setTabColor(tab, which, color);
          // Keep the site in step when this tab's colour is already the site's.
          const keyed = this.hostFor(tab);
          if (keyed && this.siteColors[keyed]) {
            this.setSiteColor(tab, which, color);
          }
          this._fillColors(body);
        });
        grid.append(swatch);
      }

      section.append(caption, grid);
      body.append(section);
    }
  },

  _fillAnimation(popup) {
    popup.textContent = "";
    for (const preset of PRESETS) {
      const item = document.createXULElement("menuitem");
      item.setAttribute("type", "radio");
      item.setAttribute("name", "zen-tab-focus-preset");
      document.l10n.setAttributes(item, "zen-tab-focus-preset-" + preset.id);
      item.setAttribute("checked", preset.id === this.preset ? "true" : "false");
      item.addEventListener("command", () => this.usePreset(preset.id));
      popup.append(item);
    }
    popup.append(document.createXULElement("menuseparator"));

    const more = document.createXULElement("menuitem");
    document.l10n.setAttributes(more, "zen-tab-focus-more");
    more.addEventListener("command", () => this._openPanel(more));
    popup.append(more);
  },

  /* A panel, not a submenu: HTML controls (sliders, swatches) render
     reliably in a panel and do not inside a menupopup. */
  /* Anchor to something that still has a box. Opening on "command" closes
     the menu first, so the menu item measures 0x0 and the panel lands at an
     arbitrary spot; the tab is always laid out. */
  _anchorFor(preferred) {
    const box = preferred?.getBoundingClientRect?.();
    if (box && box.width > 0 && box.height > 0) {
      return preferred;
    }
    const tab = this._contextTab || gBrowser.selectedTab;
    return tab?.querySelector(".tab-background") || tab || document.getElementById("tabbrowser-tabs");
  },

  _openPanel(anchor) {
    const panel = this._ensurePanel();
    this._fill(panel.querySelector(".zen-tab-focus-body"));
    panel.openPopup(this._anchorFor(anchor), "after_start", 0, 6);
  },

  _ensurePanel() {
    if (this._panel) {
      return this._panel;
    }
    const panel = document.createXULElement("panel");
    panel.id = "zen-tab-focus-panel";
    panel.setAttribute("noautofocus", "true");

    const body = document.createElementNS(HTML_NS, "div");
    body.className = "zen-tab-focus-body";
    panel.append(body);
    document.getElementById("mainPopupSet").append(panel);
    this._panel = panel;
    return panel;
  },

  _fill(body) {
    body.textContent = "";

    const presets = document.createElementNS(HTML_NS, "div");
    presets.className = "zen-tab-focus-presets";
    for (const preset of PRESETS) {
      const chip = document.createElementNS(HTML_NS, "button");
      chip.className = "zen-tab-focus-preset";
      document.l10n.setAttributes(chip, "zen-tab-focus-preset-name-" + preset.id);
      chip.toggleAttribute("selected", preset.id === this.preset);
      chip.addEventListener("click", () => {
        this.usePreset(preset.id);
        this._fill(body);
      });
      presets.append(chip);
    }
    body.append(presets);

    body.append(this._colorRow("a", "zen-tab-focus-primary"));
    body.append(this._colorRow("b", "zen-tab-focus-secondary"));

    for (const slider of SLIDERS) {
      body.append(this._slider(slider));
    }

    const toggles = document.createElementNS(HTML_NS, "div");
    toggles.className = "zen-tab-focus-toggles";
    for (const toggle of TOGGLES) {
      /* Drawn rather than <input type="checkbox">: a native checkbox inside a
         XUL panel only repainted once the pointer left the row, so a click
         appeared to do nothing until you moved away. */
      const row = document.createElementNS(HTML_NS, "div");
      row.className = "zen-tab-focus-toggle";
      row.setAttribute("role", "checkbox");
      row.tabIndex = 0;
      const paint = on => {
        row.toggleAttribute("checked", on);
        row.setAttribute("aria-checked", String(on));
      };
      paint(this.bool(toggle.key));
      const flip = () => {
        const next = !row.hasAttribute("checked");
        paint(next);
        Services.prefs.setBoolPref(PREF + toggle.key, next);
      };
      row.addEventListener("click", flip);
      row.addEventListener("keydown", event => {
        if (event.key === " " || event.key === "Enter") {
          event.preventDefault();
          flip();
        }
      });
      const mark = document.createElementNS(HTML_NS, "span");
      mark.className = "zen-tab-focus-check";
      const text = document.createElementNS(HTML_NS, "span");
      document.l10n.setAttributes(text, "zen-tab-focus-toggle-" + toggle.key);
      row.append(mark, text);
      toggles.append(row);
    }
    body.append(toggles);
  },

  /* Swatches plus a hue strip - deliberately not <input type="color">, which
     hands off to the OS dialog. */
  _colorRow(which, l10nId) {
    const wrap = document.createElementNS(HTML_NS, "div");
    wrap.className = "zen-tab-focus-row";

    const caption = document.createElementNS(HTML_NS, "div");
    caption.className = "zen-tab-focus-label";
    document.l10n.setAttributes(caption, l10nId);
    wrap.append(caption);

    /* Both rows are cells of ONE grid: as two grids with their own gaps and
       heights their columns did not line up. */
    const grid = document.createElementNS(HTML_NS, "div");
    grid.className = "zen-tab-focus-swatches";
    const current = this.color(which);

    const add = (color, cls) => {
      const swatch = document.createElementNS(HTML_NS, "button");
      swatch.className = cls;
      swatch.style.background = color;
      swatch.toggleAttribute("selected", color.toLowerCase() === current.toLowerCase());
      swatch.addEventListener("click", event => {
        event.stopPropagation();
        Services.prefs.setStringPref(PREF + "color-" + which, color);
        Services.prefs.setStringPref(PREF + "preset", "custom");
        this._fill(this._panel.querySelector('.zen-tab-focus-body'));
      });
      grid.append(swatch);
    };

    for (const color of SWATCHES) {
      add(color, "zen-tab-focus-swatch");
    }
    for (let i = 0; i < 12; i++) {
      add(`hsl(${Math.round((i / 12) * 360)} 78% 58%)`, "zen-tab-focus-hue");
    }
    wrap.append(grid);
    return wrap;
  },

  _slider({ key, min, max, step, unit }) {
    const wrap = document.createElementNS(HTML_NS, "div");
    wrap.className = "zen-tab-focus-row zen-tab-focus-slider";

    const caption = document.createElementNS(HTML_NS, "div");
    caption.className = "zen-tab-focus-label";
    const name = document.createElementNS(HTML_NS, "span");
    document.l10n.setAttributes(name, "zen-tab-focus-" + key);
    const value = document.createElementNS(HTML_NS, "span");
    value.textContent = this.num(key) + unit;
    caption.append(name, value);

    const input = document.createElementNS(HTML_NS, "input");
    input.type = "range";
    input.min = min;
    input.max = max;
    input.step = step;
    input.value = this.num(key);
    input.addEventListener("input", () => {
      value.textContent = input.value + unit;
      Services.prefs.setIntPref(PREF + key, Number(input.value));
      Services.prefs.setStringPref(PREF + "preset", "custom");
    });
    input.addEventListener("click", event => event.stopPropagation());

    wrap.append(caption, input);
    return wrap;
  },
};

window.addEventListener(
  "MozAfterPaint",
  () => {
    gZenTabFocus.init();
  },
  { once: true }
);
