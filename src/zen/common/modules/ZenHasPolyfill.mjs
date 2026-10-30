// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

/* One popup closing and the next opening is two mutations, not one. Releasing
   on the first slides the sidebar out from under the popup that is about to
   open - measured at -4px to -175px inside 120ms. */
const RELEASE_GRACE_MS = 400;

class nsHasPolyfill {
  constructor() {
    this.observers = [];
    this.idStore = 0;
  }

  /**
   * @param {HTMLElement} element
   * @param {Array<{selector: string, exists: boolean}>} descendantSelectors
   * @param {string} stateAttribute
   * @param {Array<string>} attributeFilter
   */
  observeSelectorExistence(
    element,
    descendantSelectors,
    stateAttribute,
    attributeFilter = [],
    { watchFocus = false } = {}
  ) {
    /* A doorhanger is anchored to something in here but lives in the popup
       set, so no descendant ever carries [open] for it. Releasing on that
       slid the sidebar away under an extension's permission prompt, which
       closed with its anchor. */
    const anchoredPopupOpen = () =>
      [...element.ownerDocument.querySelectorAll("panel, menupopup")].some(
        popup =>
          (popup.state === "open" || popup.state === "showing") &&
          popup.anchorNode &&
          element.contains(popup.anchorNode)
      );

    const updateState = () => {
      const matched = descendantSelectors.some(({ selector }) => {
        let selected = element.querySelector(selector);
        if (selected?.tagName?.toLowerCase() === "menu") {
          return null;
        }
        if (selected) {
          gZenCompactModeManager.log(
            `Selector "${selector}" exists for: `,
            element
          );
        }
        return selected;
      });
      // An anchored popup holds this open exactly as a descendant would.
      const exists = matched || anchoredPopupOpen();
      const { exists: shouldExist = true } = descendantSelectors;
      if (exists === shouldExist) {
        clearTimeout(this._releaseTimers?.[stateAttribute]);
        if (!element.hasAttribute(stateAttribute)) {
          gZenCompactModeManager._setElementExpandAttribute(
            element,
            true,
            stateAttribute
          );
        }
      } else if (element.hasAttribute(stateAttribute)) {
        this._releaseTimers ??= {};
        clearTimeout(this._releaseTimers[stateAttribute]);
        this._releaseTimers[stateAttribute] = setTimeout(() => {
          // Re-check rather than trust the mutation that scheduled this: a
          // popup may have opened during the grace.
          const still = descendantSelectors.some(({ selector }) => {
            const found = element.querySelector(selector);
            return found?.tagName?.toLowerCase() === "menu" ? null : found;
          });
          if (still === shouldExist || anchoredPopupOpen()) {
            return;
          }
          gZenCompactModeManager._setElementExpandAttribute(
            element,
            false,
            stateAttribute
          );
        }, RELEASE_GRACE_MS);
      }
    };

    const observer = new MutationObserver(updateState);
    const doc = element.ownerDocument;
    /* Popups change [open] and focus changes :focus-within without mutating
       anything in here. Focus is opt-in and ignored while the window settles:
       the startup focus otherwise slides the urlbar in. */
    const popupEvents = ["popupshown", "popuphidden"];
    for (const ev of popupEvents) {
      doc.addEventListener(ev, updateState, true);
    }
    const onFocus = () => {
      if (!doc.documentElement.hasAttribute("zen-startup-settling")) {
        updateState();
      }
    };
    const focusEvents = watchFocus ? ["focusin", "focusout"] : [];
    for (const ev of focusEvents) {
      doc.addEventListener(ev, onFocus, true);
    }
    const observerId = this.idStore++;
    this.observers.push({
      id: observerId,
      observer,
      element,
      attributeFilter,
      detach: () => {
        for (const ev of popupEvents) {
          doc.removeEventListener(ev, updateState, true);
        }
        for (const ev of focusEvents) {
          doc.removeEventListener(ev, onFocus, true);
        }
      },
    });
    return observerId;
  }

  disconnectObserver(observerId) {
    const index = this.observers.findIndex(o => o.id === observerId);
    if (index !== -1) {
      this.observers[index].observer.disconnect();
      this.observers[index].detach?.();
    }
  }

  connectObserver(observerId) {
    const observer = this.observers.find(o => o.id === observerId);
    if (observer) {
      observer.observer.observe(observer.element, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: observer.attributeFilter.length
          ? observer.attributeFilter
          : undefined,
      });
    }
  }

  destroy() {
    this.observers.forEach(observer => observer.observer.disconnect());
    this.observers = [];
  }
}

const hasPolyfillInstance = new nsHasPolyfill();
window.addEventListener("unload", () => hasPolyfillInstance.destroy(), {
  once: true,
});

window.ZenHasPolyfill = hasPolyfillInstance;
