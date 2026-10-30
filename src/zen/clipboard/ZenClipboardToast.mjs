// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at http://mozilla.org/MPL/2.0/.

/* A toast in the bottom-right corner when something is copied.
 *
 * Zen's own toast container is pinned to the top and shared with every other
 * feature, so this keeps its own container rather than moving that one and
 * relocating unrelated toasts. Styling reuses .zen-toast so it still looks
 * like the rest of the browser.
 *
 * Copies happen in two places: the chrome (urlbar, menus) and the page. The
 * chrome side is a plain listener; the page side needs a frame script, since
 * content events never reach here. The copied TEXT is deliberately never read
 * or shown - a clipboard routinely holds passwords. */

const CONTAINER_ID = "zen-clipboard-toast-container";
const DEFAULT_SHOW_MS = 1600;

window.gZenClipboardToast = {
  init() {
    if (this._inited) {
      return;
    }
    this._inited = true;

    document.addEventListener("copy", () => this.show(), true);
    document.addEventListener("cut", () => this.show(), true);

    window.messageManager.loadFrameScript(
      "chrome://browser/content/zen-components/zen-clipboard-frame.js",
      true
    );
    window.messageManager.addMessageListener("ZenClipboard:Copied", () => this.show());
  },

  get enabled() {
    return Services.prefs.getBoolPref("zen.clipboard.toast", true);
  },

  /* Read from CSS so a mod can retime the toast without touching any JS. */
  _showMs() {
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue("--zen-clipboard-toast-duration")
      .trim();
    const ms = raw.endsWith("ms") ? parseFloat(raw) : parseFloat(raw) * 1000;
    return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_SHOW_MS;
  },

  _container() {
    let box = document.getElementById(CONTAINER_ID);
    if (!box) {
      box = document.createXULElement("vbox");
      box.id = CONTAINER_ID;
      box.setAttribute("hidden", "true");
      document.documentElement.appendChild(box);
    }
    return box;
  },

  show() {
    if (!this.enabled) {
      return;
    }
    const box = this._container();
    box.removeAttribute("hidden");

    /* One toast at a time: copying twice quickly should re-arm the existing
       one rather than stack a second identical message. */
    let toast = box.firstElementChild;
    if (!toast) {
      toast = document.createXULElement("hbox");
      toast.className = "zen-toast zen-clipboard-toast";
      const label = document.createXULElement("label");
      label.className = "zen-clipboard-toast-label";
      document.l10n.setAttributes(label, "zen-clipboard-copied");
      toast.appendChild(label);
      box.appendChild(toast);
    }
    toast.removeAttribute("leaving");
    // Restart the entry animation even when the toast is already up.
    toast.removeAttribute("entering");
    void toast.getBoundingClientRect();
    toast.setAttribute("entering", "true");

    clearTimeout(this._hideTimer);
    this._hideTimer = setTimeout(() => {
      toast.setAttribute("leaving", "true");
      clearTimeout(this._removeTimer);
      this._removeTimer = setTimeout(() => {
        toast.remove();
        if (!box.children.length) {
          box.setAttribute("hidden", "true");
        }
      }, 200);
    }, this._showMs());
  },
};

window.addEventListener("MozAfterPaint", () => gZenClipboardToast.init(), { once: true });
