/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Publishes in-progress downloads for the desktop dock.
 * $XDG_RUNTIME_DIR/tela-zen/downloads.json:
 *   [{ "file", "currentBytes", "totalBytes", "speed" }]
 * Rewritten at most twice a second, removed when nothing is downloading.
 * Wayland has no _NET_WM_XAPP_PROGRESS, so Firefox publishes this nowhere. */
const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Downloads: "resource://gre/modules/Downloads.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

const MIN_INTERVAL_MS = 500;
// Tests point this elsewhere, so a test browser never drives the real dock.
const PREF_FILE = "zen.downloads.progress-file";

export const TelaDownloadProgress = {
  _list: null,
  _timer: null,
  _lastWrite: 0,

  get _path() {
    const override = Services.prefs.getStringPref(PREF_FILE, "");
    if (override) {
      return override;
    }
    const runtime = Services.env.get("XDG_RUNTIME_DIR");
    return runtime ? PathUtils.join(runtime, "tela-zen", "downloads.json") : null;
  },

  async init() {
    if (this._list || !this._path) {
      return;
    }
    this._list = await lazy.Downloads.getList(lazy.Downloads.ALL);
    // addView replays onDownloadAdded for downloads that already exist.
    await this._list.addView({
      onDownloadAdded: () => this._schedule(),
      onDownloadChanged: () => this._schedule(),
      onDownloadRemoved: () => this._schedule(),
    });
    /* Awaited by shutdown: a bare remove at quit-application-granted was
       still pending when the process exited, leaving the dock a stale ring. */
    IOUtils.profileBeforeChange.addBlocker(
      "TelaDownloadProgress: remove the dock feed",
      () => this._shutdown()
    );
  },

  async _shutdown() {
    this._quitting = true;
    if (this._timer) {
      lazy.clearTimeout(this._timer);
      this._timer = null;
    }
    await IOUtils.remove(this._path, { ignoreAbsent: true });
  },

  // onDownloadChanged fires many times a second per download.
  _schedule() {
    if (this._timer || this._quitting) {
      return;
    }
    const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - this._lastWrite));
    this._timer = lazy.setTimeout(() => {
      this._timer = null;
      this._write().catch(console.error);
    }, wait);
  },

  async _write() {
    if (this._quitting) {
      return;
    }
    this._lastWrite = Date.now();
    const path = this._path;
    // Running = started and not yet stopped. Paused and failed downloads
    // are `stopped`; finished ones are `succeeded`.
    const running = (await this._list.getAll()).filter(d => !d.stopped && !d.succeeded);
    if (!running.length) {
      await IOUtils.remove(path, { ignoreAbsent: true });
      return;
    }
    const items = running.map(d => ({
      file: PathUtils.filename(d.target.path),
      currentBytes: d.currentBytes,
      totalBytes: d.hasProgress ? d.totalBytes : 0,
      speed: Math.round(d.speed),
    }));
    await IOUtils.makeDirectory(PathUtils.parent(path), {
      ignoreExisting: true,
      permissions: 0o700,
    });
    // tmpPath = write then rename: the dock never reads half a file.
    await IOUtils.writeJSON(path, items, { tmpPath: path + ".tmp" });
  },

};
