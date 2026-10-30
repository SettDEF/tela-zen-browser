// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at http://mozilla.org/MPL/2.0/.

/* Per-site memory for the pop-out video window.
 *
 * Firefox keeps exactly one slot for the player's size and position, so a
 * small corner window for one site becomes the size every other site opens
 * at. Here each host keeps its own, and falls back to Firefox's single slot
 * the first time a host is seen.
 *
 * The three PictureInPicture entry points are wrapped rather than reimplemented:
 * loadPosition() is only consulted when a window opens, savePosition() only
 * when one closes, and handlePictureInPictureRequest() is the one place that
 * still knows which page asked. */

const { PictureInPicture } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/pictureinpicture/PictureInPicture.sys.mjs"
);

const PLAYER_URI = "chrome://global/content/pictureinpicture/player.xhtml";
const PREF = "zen.pictureinpicture.remember-per-site";
const FIELDS = ["left", "top", "width", "height"];

window.gZenPictureInPicture = {
  init() {
    // The module is shared by every browser window; only the first wraps it.
    if (PictureInPicture._zenWrapped) {
      return;
    }
    PictureInPicture._zenWrapped = true;

    const original = {
      request: PictureInPicture.handlePictureInPictureRequest,
      load: PictureInPicture.loadPosition,
      save: PictureInPicture.savePosition,
    };

    PictureInPicture.handlePictureInPictureRequest = function (wgp, videoData) {
      PictureInPicture._zenHost = gZenPictureInPicture._host(
        wgp.browsingContext.top.embedderElement
      );
      return original.request.call(this, wgp, videoData);
    };

    PictureInPicture.loadPosition = function () {
      return (
        gZenPictureInPicture._read(PictureInPicture._zenHost) ||
        original.load.call(this)
      );
    };

    PictureInPicture.savePosition = function (win) {
      original.save.call(this, win);
      gZenPictureInPicture._write(
        gZenPictureInPicture._host(this.weakWinToBrowser.get(win)),
        win
      );
    };
  },

  get enabled() {
    return Services.prefs.getBoolPref(PREF, true);
  },

  _host(browser) {
    try {
      return browser?.currentURI?.host || "";
    } catch {
      // about: and data: URIs have no host; they share the global slot.
      return "";
    }
  },

  _key(host) {
    return `zen-pip-${host}`;
  },

  _read(host) {
    if (!host || !this.enabled) {
      return null;
    }
    const saved = {};
    for (const field of FIELDS) {
      saved[field] = parseInt(
        Services.xulStore.getValue(PLAYER_URI, this._key(host), field)
      );
      if (isNaN(saved[field])) {
        return null;
      }
    }
    return saved;
  },

  /* Stored the way Firefox stores its own slot: left/top in desktop pixels,
     which are screen-independent, and the size in CSS pixels. */
  _write(host, win) {
    if (!host || !this.enabled) {
      return;
    }
    const scale = win.devicePixelRatio / win.desktopToDeviceScale;
    const values = {
      left: win.screenX * scale,
      top: win.screenY * scale,
      width: win.outerWidth,
      height: win.outerHeight,
    };
    for (const field of FIELDS) {
      Services.xulStore.setValue(
        PLAYER_URI,
        this._key(host),
        field,
        Math.round(values[field])
      );
    }
  },
};

window.addEventListener("MozAfterPaint", () => gZenPictureInPicture.init(), {
  once: true,
});
