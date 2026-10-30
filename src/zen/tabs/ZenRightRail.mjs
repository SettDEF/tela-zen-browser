/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/* A narrow icon-only rail down the right edge.
 *
 * Registered as a real CustomizableUI area rather than a hand-built strip, so
 * Customize Mode treats it like any Firefox toolbar: widgets and extension
 * buttons drag in and out, placements persist, and the built-in "spring"
 * (flexible transparent space) works with no code of ours. */

const AREA = "zen-right-rail";

window.gZenRightRail = {
  _inCustomizeMode: false,

  init() {
    if (this._inited) {
      return;
    }
    this._inited = true;
    this._build();
    new MutationObserver(() => this._applyLayout()).observe(document.documentElement, {
      attributes: true, attributeFilter: ["zen-layout"],
    });
    // CustomizeMode wraps unified-extensions-button in a toolbarpaletteitem;
    // moving it mid-session would yank it out from under that wrapper.
    window.addEventListener("customizationstarting", () => this._onCustomizeStart());
    window.addEventListener("aftercustomization", () => this._onCustomizeEnd());
    this._applyLayout();
    this._watchReclaim();
  },

  /* Zen's toolbar manager sweeps every [cui-areatype="toolbar"] button back
     into the sidebar's target when the layout prefs change, taking the
     extensions button out of the rail with them. Put it back when it goes.
     _placeExtensions() is itself a no-op once the button is back in place, so
     this settles in one bounce - the cap is the same defence
     ZenHorizontalTabs._reclaimAllowed uses, kept here in case a future writer
     fights this one the way #nav-bar's did. */
  _watchReclaim() {
    const target = document.getElementById(AREA + "-customization-target");
    if (!target) {
      return;
    }
    new MutationObserver(() => {
      if (this.active && !this._inCustomizeMode && this._reclaimAllowed()) {
        this._placeExtensions();
      }
    }).observe(target, { childList: true });
  },

  _reclaimAllowed() {
    const now = Date.now();
    if (now - (this._reclaimAt || 0) > 2000) {
      this._reclaimAt = now;
      this._reclaimCount = 0;
    }
    if (++this._reclaimCount > 10) {
      if (!this._reclaimWarned) {
        this._reclaimWarned = true;
        console.warn("[zen] right rail kept losing the extensions button; standing down");
      }
      return false;
    }
    return true;
  },

  get active() {
    return document.documentElement.getAttribute("zen-layout") === "horizontal";
  },

  _build() {
    if (document.getElementById(AREA)) {
      return;
    }
    const anchor = document.getElementById("browser");
    if (!anchor) {
      return;
    }

    /* A toolbar plus its customization target, the same shape #nav-bar has -
       CustomizableUI needs both to accept drops. */
    const bar = document.createXULElement("toolbar");
    bar.id = AREA;
    bar.setAttribute("customizable", "true");
    bar.setAttribute("mode", "icons");
    bar.setAttribute("orient", "vertical");
    bar.setAttribute("context", "toolbar-context-menu");

    // The single Tab-order entry point for the toolbar, same as every other
    // keyboard-navigable toolbar (see PersonalToolbar). Without it the rail
    // is a real CustomizableUI area but Tab skips over it entirely - nothing
    // here was ever reachable from the keyboard.
    const tabstop = document.createXULElement("toolbartabstop");
    tabstop.setAttribute("skipintoolbarset", "true");
    bar.append(tabstop);

    const label = document.createXULElement("label");
    label.id = AREA + "-label";
    document.l10n.setAttributes(label, "zen-right-rail-label");
    bar.append(label);

    const target = document.createXULElement("vbox");
    target.id = AREA + "-customization-target";
    target.className = "customization-target";
    target.setAttribute("flex", "1");
    bar.append(target);
    bar.setAttribute("customizationtarget", target.id);

    anchor.append(bar);
    this._bar = bar;

    try {
      if (!CustomizableUI.areas.includes(AREA)) {
        CustomizableUI.registerArea(AREA, {
          type: CustomizableUI.TYPE_TOOLBAR,
          defaultPlacements: ["unified-extensions-button", "spring"],
        });
      }
      CustomizableUI.registerToolbarNode(bar);
    } catch (ex) {
      console.error("[zen] right rail area", ex);
    }

    this._initKeyNav(bar);
  },

  /* ToolbarKeyboardNavigator wires up every built-in toolbar from a static
     list (`kToolbars`) walked once at window load, before this toolbar
     exists. Doing the same setup here, once the node is real, is what that
     list would have done for us if we'd been in it from the start; joining
     the list too makes CustomizableUI.addWidgetToArea (drag-and-drop in
     Customize Mode) give new buttons a tabstop the same way. */
  _initKeyNav(bar) {
    if (typeof ToolbarKeyboardNavigator === "undefined" || !gToolbarKeyNavEnabled) {
      return;
    }
    if (!ToolbarKeyboardNavigator.kToolbars.includes(AREA)) {
      ToolbarKeyboardNavigator.kToolbars.push(AREA);
    }
    bar.setAttribute("keyNav", "true");
    ToolbarKeyboardNavigator._initTabStops(bar);
    bar.addEventListener("keydown", ToolbarKeyboardNavigator);
    bar.addEventListener("keypress", ToolbarKeyboardNavigator);
  },

  _applyLayout() {
    // Deferred while customizing; the button may be inside a wrapper node.
    if (this._inCustomizeMode) {
      return;
    }
    if (this._bar) {
      this._bar.hidden = !this.active;
    }
    this._placeExtensions();
  },

  /* In Customize Mode #browser shrinks to the toolbox strip, leaving the rail
     a 40px sliver stranded at the far right of an empty band - it reads as
     missing. Show it as a row inside the toolbox instead, next to the other
     toolbars being edited; the CustomizableUI area is the same either way. */
  _onCustomizeStart() {
    this._inCustomizeMode = true;
    const toolbox = document.getElementById("navigator-toolbox");
    if (!this._bar || !toolbox || !this.active) {
      return;
    }
    this._barHome = { parent: this._bar.parentElement, next: this._bar.nextElementSibling };
    this._bar.setAttribute("orient", "horizontal");
    toolbox.append(this._bar);
  },

  // Runs after CustomizeMode has unwrapped everything, so the button is a
  // plain node again - reconciles any zen-layout toggle made mid-session.
  _onCustomizeEnd() {
    this._inCustomizeMode = false;
    if (this._barHome) {
      this._bar.setAttribute("orient", "vertical");
      this._barHome.parent.insertBefore(this._bar, this._barHome.next);
      this._barHome = null;
    }
    this._applyLayout();
  },

  /* Zen places the extensions button as a plain node rather than registering
     it as a CustomizableUI widget, so addWidgetToArea silently no-ops on it
     (measured: currentArea and removable are both undefined). Move the node. */
  _placeExtensions() {
    const btn = document.getElementById("unified-extensions-button");
    const target = document.getElementById(AREA + "-customization-target");
    if (!btn || !target) {
      return;
    }
    if (this.active) {
      if (btn.parentElement !== target) {
        this._extHome = { parent: btn.parentElement, next: btn.nextElementSibling };
        target.prepend(btn);
      }
    } else if (this._extHome) {
      this._extHome.parent.insertBefore(btn, this._extHome.next);
      this._extHome = null;
    }
  },
};

window.addEventListener(
  "MozAfterPaint",
  () => {
    gZenRightRail.init();
  },
  { once: true }
);
