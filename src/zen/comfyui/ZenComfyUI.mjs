/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Shows a local ComfyUI's generation progress as an Activity card. Reads the
   server's own API rather than its page, so it works whether or not a ComfyUI
   tab is open, and survives frontend rewrites that would break a selector. */

const PREF_ENABLED = "zen.comfyui.enabled";
const PREF_URL = "zen.comfyui.url";
const CARD_ID = "zen-comfyui";

window.gZenComfyUI = {
  _socket: null,
  _poll: 0,
  _retry: 0,
  _progress: null,
  _queue: { running: 0, pending: 0 },

  get enabled() {
    return Services.prefs.getBoolPref(PREF_ENABLED, true);
  },

  get base() {
    return Services.prefs.getStringPref(PREF_URL, "http://127.0.0.1:8188");
  },

  init() {
    if (!this.enabled) {
      return;
    }
    this._tick();
    window.addEventListener("unload", () => this._stop(), { once: true });
  },

  _stop() {
    window.clearTimeout(this._poll);
    this._socket?.close();
    this._socket = null;
  },

  /* /queue is authoritative for whether anything runs; it is cheap and needs no
     socket. Backs off while the server is unreachable, so an absent ComfyUI
     costs a request every half minute rather than every second. */
  async _tick() {
    let delay = 1500;
    try {
      const res = await fetch(this.base + "/queue", { cache: "no-store" });
      const q = await res.json();
      this._queue = {
        running: (q.queue_running || []).length,
        pending: (q.queue_pending || []).length,
      };
      this._retry = 0;
      this._ensureSocket();
    } catch {
      this._queue = { running: 0, pending: 0 };
      this._progress = null;
      this._retry = Math.min(this._retry + 1, 6);
      delay = 1500 * 2 ** this._retry;
    }
    this._render();
    this._poll = window.setTimeout(() => this._tick(), delay);
  },

  /* The percentage only exists on the websocket. ComfyUI targets progress at the
     client that queued the job, so an observer may never receive it - the card
     then still shows running and queued from /queue, just without a bar. */
  _ensureSocket() {
    if (this._socket) {
      return;
    }
    const url = this.base.replace(/^http/, "ws") + "/ws";
    try {
      this._socket = new WebSocket(url);
    } catch {
      return;
    }
    this._socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        return;
      }
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === "progress" && msg.data?.max > 0) {
        this._progress = msg.data.value / msg.data.max;
        this._render();
      } else if (msg.type === "executing" && msg.data?.node == null) {
        this._progress = null;
        this._render();
      }
    });
    this._socket.addEventListener("close", () => {
      this._socket = null;
    });
  },

  _renderSeq: 0,

  async _render() {
    const seq = ++this._renderSeq;
    const cards = window.gZenPageCards;
    if (!cards?.setWindowCard) {
      return;
    }
    const { running, pending } = this._queue;
    if (!running && !pending) {
      cards.clearWindowCard(CARD_ID);
      return;
    }
    const [title, subtitle, row] = await document.l10n.formatValues([
      { id: "zen-comfyui-title" },
      { id: "zen-comfyui-subtitle", args: { running, pending } },
      { id: running ? "zen-comfyui-generating" : "zen-comfyui-waiting" },
    ]);
    // A newer render started while this one awaited its strings; let it win.
    if (seq !== this._renderSeq) {
      return;
    }
    cards.setWindowCard({
      id: CARD_ID,
      title,
      subtitle,
      accent: "#7b61ff",
      items: [{
        label: row,
        kind: "image",
        progress: running && this._progress != null ? this._progress : -1,
        status: running ? "running" : "",
      }],
    });
  },
};
