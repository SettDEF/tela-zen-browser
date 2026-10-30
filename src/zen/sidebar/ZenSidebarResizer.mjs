// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at http://mozilla.org/MPL/2.0/.

/* Resizing the sidebar while compact mode floats it.
 *
 * #zen-sidebar-splitter is a XUL splitter, which resizes a sibling that shares
 * its flow; compact takes the toolbox out of the flow (position: fixed), which
 * is why compact hides it. This is the replacement: a grab strip parented to
 * the toolbox itself, so it floats with it, dragged with plain mouse events.
 *
 * The width goes where Zen already keeps it - the toolbox's inline width and
 * its `width` attribute, both named in its `persist`, so a restart restores it
 * with no storage of our own. */

const MIN_WIDTH = 150;
const FALLBACK_MAX = 500;
// The floating sidebar's share of the window, at most: a fixed width covered
// nearly all of a narrow tiled window.
const MAX_SHARE = 0.6;
const ANIM_MS = 180;
const EASE = "cubic-bezier(0.22, 0.61, 0.36, 1)";

window.gZenSidebarResizer = {
  init() {
    if (this._inited) {
      return;
    }
    this._inited = true;
    this._toolbox = document.getElementById("navigator-toolbox");
    if (!this._toolbox) {
      return;
    }
    this._onMove = this._onMove.bind(this);
    this._onUp = this._onUp.bind(this);

    const handle = document.createXULElement("hbox");
    handle.id = "zen-compact-sidebar-resizer";
    handle.setAttribute("skipintoolbarset", "true");
    handle.addEventListener("mousedown", this);
    handle.addEventListener("dblclick", this);
    this._toolbox.appendChild(handle);

    /* Not ZenCompactMode:Toggled: compact restored from the XULStore is
       already set by the time this runs, and its setter dispatches nothing
       when the value it is handed is the one already in place. */
    new MutationObserver(() => this._syncPin(this._synced)).observe(
      document.documentElement,
      { attributes: true, attributeFilter: ["zen-compact-mode"] }
    );
    /* And again once the transition has run: entering compact recomputes the
       width variables from the toolbox's outer width, which is the padding too
       wide, and the sidebar's contents then overflow the panel they sit in. */
    window.addEventListener("ZenCompactMode:Toggled", this);
    window.addEventListener("resize", () => {
      cancelAnimationFrame(this._fitFrame);
      this._fitFrame = requestAnimationFrame(() => this._syncPin(false));
    });
    this._syncPin(false);
  },

  /* What the window has room for. The stored width is never rewritten with
     this, so widening the window brings the user's own width back. */
  _fit(width) {
    const cap = Math.max(MIN_WIDTH, Math.round(window.innerWidth * MAX_SHARE));
    return Math.min(width, cap);
  },

  handleEvent(event) {
    switch (event.type) {
      case "mousedown":
        this._onDown(event);
        break;
      case "dblclick":
        this._onReset(event);
        break;
      case "ZenCompactMode:Toggled":
        this._syncPin(false);
        break;
    }
  },

  get _compact() {
    return document.documentElement.getAttribute("zen-compact-mode") === "true";
  },

  /* The persisted `width` attribute, not the inline width: the urlbar's own
     widen saves and restores the inline geometry around a focus, so anything
     read back from there is whatever that snapshot happened to hold. */
  get _stored() {
    const width = parseFloat(this._toolbox.getAttribute("width"));
    return Number.isFinite(width) ? width : null;
  },

  /* The stored width sits below the toolbox's fit-content minimum for most
     people, and only an explicit min-width lets it hold. That pin belongs to
     compact alone - in the flow, the splitter and fit-content own the width. */
  _syncPin(animate) {
    this._synced = true;
    if (this._drag) {
      return;
    }
    const width = this._stored;
    if (!this._compact) {
      if (this._toolbox.style.minWidth) {
        this._animate(animate);
        this._toolbox.style.removeProperty("min-width");
      }
      return;
    }
    if (width !== null) {
      this._setWidth(this._fit(width), { animate });
    }
  },

  /* --zen-sidebar-width is the width the sidebar's *contents* lay out to; the
     toolbox is that plus its own padding. Zen's resize observer deliberately
     leaves that variable alone while compact is expanded, so it is ours to
     keep in step, or the panel grows while everything inside it stays put. */
  _applyVars(width) {
    const style = window.getComputedStyle(this._toolbox);
    const inner =
      width -
      parseFloat(style.paddingLeft) -
      parseFloat(style.paddingRight) -
      parseFloat(style.getPropertyValue("--zen-toolbox-padding"));
    this._toolbox.style.setProperty("--actual-zen-sidebar-width", `${width}px`);
    this._toolbox.style.setProperty(
      "--zen-sidebar-width",
      `${Math.round(inner)}px`
    );
  },

  /* Width is a layout property, so this is deliberately short and never runs
     during a drag. The left/right/visibility transitions are repeated because
     zen-omnibox.css sets them with `important` and this has to outrank it. */
  _animate(on) {
    clearTimeout(this._animTimer);
    if (!on) {
      this._toolbox.style.removeProperty("transition");
      return;
    }
    this._toolbox.style.setProperty(
      "transition",
      `left 0.15s ease, right 0.15s ease, visibility 0.15s ease,
       width ${ANIM_MS}ms ${EASE}, min-width ${ANIM_MS}ms ${EASE}`,
      "important"
    );
    this._animTimer = setTimeout(() => {
      this._toolbox.style.removeProperty("transition");
      window.gZenCompactModeManager?.getAndApplySidebarWidth({});
    }, ANIM_MS + 40);
  },

  _setWidth(width, { animate = false, persist = false } = {}) {
    this._animate(animate);
    this._toolbox.style.width = `${width}px`;
    this._toolbox.style.minWidth = `${width}px`;
    this._applyVars(width);
    if (persist) {
      this._toolbox.setAttribute("width", `${width}px`);
    }
  },

  _clamp(width) {
    return Math.round(Math.min(this._drag.max, Math.max(MIN_WIDTH, width)));
  },

  _onDown(event) {
    if (event.button !== 0 || !this._compact) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this._animate(false);
    const css = parseFloat(window.getComputedStyle(this._toolbox).maxWidth);
    const max = this._fit(Number.isFinite(css) ? css : FALLBACK_MAX);
    this._drag = {
      x: event.screenX,
      width: this._toolbox.getBoundingClientRect().width,
      dir: window.gZenCompactModeManager?.sidebarIsOnRight ? -1 : 1,
      max: Number.isFinite(max) ? max : FALLBACK_MAX,
    };
    this._pointer = event.screenX;
    /* Silences Zen's resize feedback for the length of the drag: every write
       to the sidebar's width otherwise dispatches a synthetic window resize
       and runs every resize listener in the chrome. Settled once at the end. */
    document.documentElement.setAttribute("zen-sidebar-animating", "true");
    this._toolbox.setAttribute("zen-resizing", "true");
    /* Half the travel is over web content, which swallows the pointer. */
    gBrowser.tabpanels.style.pointerEvents = "none";
    window.setCursor("ew-resize");
    window.addEventListener("mousemove", this._onMove, true);
    window.addEventListener("mouseup", this._onUp, true);
  },

  _onMove(event) {
    if (!this._drag) {
      return;
    }
    this._pointer = event.screenX;
    if (this._raf) {
      return;
    }
    this._raf = window.requestAnimationFrame(() => {
      this._raf = 0;
      if (!this._drag) {
        return;
      }
      const delta = (this._pointer - this._drag.x) * this._drag.dir;
      this._setWidth(this._clamp(this._drag.width + delta));
    });
  },

  _onUp() {
    if (!this._drag) {
      return;
    }
    window.cancelAnimationFrame(this._raf);
    this._raf = 0;
    const delta = (this._pointer - this._drag.x) * this._drag.dir;
    const width = this._clamp(this._drag.width + delta);
    this._drag = null;
    window.removeEventListener("mousemove", this._onMove, true);
    window.removeEventListener("mouseup", this._onUp, true);
    window.setCursor("auto");
    gBrowser.tabpanels.style.removeProperty("pointer-events");
    this._setWidth(width, { persist: true });
    document.documentElement.removeAttribute("zen-sidebar-animating");
    window.gZenCompactModeManager?.getAndApplySidebarWidth({});
    /* Dropped one frame late: the sidebar is only kept out by [zen-resizing]
       while the drag runs, and letting it collapse under the pointer that just
       finished resizing it reads as the drag having failed. */
    window.requestAnimationFrame(() => {
      this._toolbox.removeAttribute("zen-resizing");
      if (this._toolbox.matches(":hover")) {
        window.gZenCompactModeManager?._setElementExpandAttribute(
          this._toolbox,
          true
        );
      }
    });
  },

  // Same gesture, and the same width, as the splitter's own reset.
  _onReset(event) {
    if (event.button !== 0 || !this._compact) {
      return;
    }
    const width = parseFloat(ZenCustomizableUI.kDefaultSidebarWidth);
    this._setWidth(width, { animate: true, persist: true });
  },
};

window.addEventListener("MozAfterPaint", () => gZenSidebarResizer.init(), {
  once: true,
});
