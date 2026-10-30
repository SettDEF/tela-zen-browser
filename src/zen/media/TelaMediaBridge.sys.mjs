/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Every tab's media, for the desktop (~/.scripts/media, the now-playing dock).
 * A client of the loopback media bridge, never a server: posts the tab list to
 * <bridge>/tabs and long-polls <bridge>/tabs/poll for per-tab commands. One
 * instance per process, across all windows. Off when the pref is empty. */
const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  clearInterval: "resource://gre/modules/Timer.sys.mjs",
  setInterval: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
});

// Tests point this elsewhere, so a test browser never shows up on the real bridge.
const PREF_URL = "zen.media.bridge.url";
const SCAN_MS = 1000;
const HEARTBEAT_MS = 15000;

export const TelaMediaBridge = {
  _started: false,
  _watched: new WeakSet(),
  _page: new Map(), // browserId -> zen-media-frame.js state {volume, muted, rate, source}
  _last: "",
  _lastSent: 0,

  get _base() {
    return Services.prefs.getStringPref(PREF_URL, "").replace(/\/$/, "");
  },

  init() {
    if (this._started || !this._base) {
      return;
    }
    this._started = true;
    // Volume and speed live in the page; zen-media-frame.js (the media card's
    // ⋯ panel) reports them, and handles YouTube's and YT Music's own sliders.
    Services.mm.addMessageListener("ZenMedia:State", (msg) => {
      const id = msg.target?.browserId;
      if (id != null) {
        // The playhead moves every reply; only volume, speed or a jump is news.
        const was = this._page.get(id);
        this._page.set(id, msg.data);
        const jumped = was?.position != null && msg.data?.position != null &&
          Math.abs(msg.data.position - was.position) > 2.5;
        if (was?.volume !== msg.data?.volume || was?.rate !== msg.data?.rate || jumped) {
          this._report(true);
        }
      }
    });
    this._scan = lazy.setInterval(() => this._report(), SCAN_MS);
    Services.obs.addObserver(() => this._stop(), "quit-application-granted");
    this._poll(-1);
  },

  _stop() {
    this._quitting = true;
    lazy.clearInterval(this._scan);
    // Best effort: the bridge also drops a browser that stops reporting.
    this._post("/tabs", { tabs: [] }).catch(() => {});
  },

  *_tabs() {
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      if (win.closed || !win.gBrowser) {
        continue;
      }
      for (const tab of win.gBrowser.tabs) {
        const browser = tab.linkedBrowser;
        const controller = browser?.browsingContext?.mediaController;
        if (controller?.isActive) {
          yield { win, tab, browser, controller };
        }
      }
    }
  },

  _watch(controller) {
    if (this._watched.has(controller)) {
      return;
    }
    this._watched.add(controller);
    const now = () => this._report(true);
    for (const type of ["playbackstatechange", "metadatachange", "supportedkeyschange", "deactivated"]) {
      controller.addEventListener(type, now);
    }
  },

  _describe({ win, tab, browser, controller }) {
    this._watch(controller);
    let md = {};
    try {
      md = controller.getMetadata();
    } catch {
      // No metadata yet: the page has not set any and has no title.
    }
    const art = md.artwork?.length ? md.artwork[md.artwork.length - 1].src : null;
    let pos = null;
    try {
      pos = controller.getPositionState(); // throws while the page has set none
    } catch {}
    const page = this._page.get(browser.browserId);
    const uri = browser.currentURI;
    return {
      id: String(browser.browserId),
      site: uri?.host || null,
      url: uri?.spec || null,
      tabTitle: tab.label,
      title: md.title || null,
      artist: md.artist || null,
      album: md.album || null,
      artUrl: art,
      playing: controller.isPlaying,
      audible: controller.isAudible,
      muted: controller.isMuted,
      selected: tab.selected && win === Services.wm.getMostRecentBrowserWindow(),
      position: page?.position ?? pos?.position ?? null,
      duration: page?.duration ?? pos?.duration ?? null,
      keys: controller.supportedKeys,
      volume: page?.volume ?? null,
      rate: page?.rate ?? null,
    };
  },

  _report(force = false) {
    if (this._quitting) {
      return;
    }
    let tabs;
    try {
      const found = [...this._tabs()];
      for (const { browser } of found) {
        browser.messageManager?.sendAsyncMessage("ZenMedia:Query");
      }
      tabs = found.map((t) => this._describe(t));
    } catch (e) {
      console.error("TelaMediaBridge scan", e);
      return;
    }
    const key = JSON.stringify(tabs.map((t) => ({ ...t, position: null })));
    if (!force && key === this._last && Date.now() - this._lastSent < HEARTBEAT_MS) {
      return;
    }
    this._last = key;
    this._lastSent = Date.now();
    this._post("/tabs", { tabs }).catch(() => {});
  },

  async _post(path, body) {
    const r = await fetch(this._base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return r.json();
  },

  async _poll(after) {
    while (!this._quitting) {
      try {
        const r = await fetch(`${this._base}/tabs/poll?after=${after}`);
        const json = await r.json();
        after = json.after;
        for (const c of json.commands) {
          try {
            this._run(c);
          } catch (e) {
            console.error("TelaMediaBridge command", c, e);
          }
        }
      } catch {
        // Bridge down: retry quietly, and only take commands queued after reconnecting.
        after = -1;
        await new Promise((r) => lazy.setTimeout(r, 5000));
      }
    }
  },

  _find(id) {
    for (const t of this._tabs()) {
      if (String(t.browser.browserId) === String(id)) {
        return t;
      }
    }
    return null;
  },

  _run({ tab: id, cmd, arg }) {
    const t = this._find(id);
    if (!t) {
      return;
    }
    const c = t.controller;
    switch (cmd) {
      case "toggle":
        c.isPlaying ? c.pause("user") : c.play();
        break;
      case "play":
        c.play();
        break;
      case "pause":
        c.pause("user");
        break;
      case "stop":
        c.stop();
        break;
      case "next":
        c.nextTrack();
        break;
      case "prev":
        c.prevTrack();
        break;
      // A site's seek handler may pause (YT Music's does); the media card
      // resumes after seekTo for the same reason.
      case "seek":
      case "forward":
      case "back": {
        const was = c.isPlaying;
        if (cmd === "seek") {
          c.seekTo(Number(arg));
        } else if (cmd === "forward") {
          c.seekForward(Number(arg) || 10);
        } else {
          c.seekBackward(Number(arg) || 10);
        }
        if (was) {
          c.play();
        }
        break;
      }
      case "volume":
        t.browser.messageManager.sendAsyncMessage("ZenMedia:SetVolume", { volume: Number(arg) });
        break;
      case "rate":
        t.browser.messageManager.sendAsyncMessage("ZenMedia:SetRate", { rate: Number(arg) });
        break;
      case "mute":
        c.isMuted ? c.unmute() : c.mute();
        break;
    }
    lazy.setTimeout(() => this._report(true), 300);
  },
};

/* "Open in another app": hands a tab's video to reel, mpv or a command of the
 * user's, through the media helper (`media external`, ~/.scripts/media), which
 * resolves site players with yt-dlp. The cookies and referrer go along when
 * allowed: most streaming hosters refuse a request without them. */
const EXT = "zen.media.external.";

export const TelaExternalPlayer = {
  /* Streams each tab actually fetched: browserId -> { url, referer, at }.
     Players built on hls.js / dash.js play a blob: and keep the real address
     to themselves, and many hosters are unknown to yt-dlp, so the manifest the
     network saw is the one address that works outside the page. */
  _streams: new Map(),
  _watching: false,

  watch() {
    if (this._watching) {
      return;
    }
    this._watching = true;
    // every frame's playing video, for its exact time (TelaMediaSourceChild below)
    try {
      ChromeUtils.registerWindowActor("TelaMediaSource", {
        parent: { esModuleURI: "resource:///modules/zen/TelaMediaBridge.sys.mjs" },
        // play starts a site's "always" rule; loadedmetadata tells the urlbar icon a video is here
        child: {
          esModuleURI: "resource:///modules/zen/TelaMediaBridge.sys.mjs",
          events: { play: { capture: true }, loadedmetadata: { capture: true } },
        },
        allFrames: true,
        matches: ["http://*/*", "https://*/*"],
        // it only reads a video's time and address back to the parent, which trusts none of it
        // beyond handing it to the player
        safeForUntrustedWebProcess: true,
      });
    } catch (ex) {
      // registered already (another window got here first)
      void ex;
    }
    const MANIFEST = /\.(m3u8|mpd)(\?|$)/i;
    const TYPES = /mpegurl|dash\+xml|^video\//i;
    Services.obs.addObserver((subject) => {
      try {
        const ch = subject.QueryInterface(Ci.nsIHttpChannel);
        const url = ch.URI.spec;
        let type = "";
        try {
          type = ch.contentType || "";
        } catch {}
        const manifest = MANIFEST.test(ch.URI.filePath) || /mpegurl|dash\+xml/i.test(type);
        // a whole video file, not a segment of a stream already noted
        const file = !manifest && TYPES.test(type) && !/\.(ts|m4s|aac)(\?|$)/i.test(ch.URI.filePath);
        if (!manifest && !file) {
          return;
        }
        const bc = BrowsingContext.get(ch.loadInfo?.browsingContextID);
        const id = bc?.top?.browserId;
        if (!id) {
          return;
        }
        let referer = "";
        try {
          referer = ch.getRequestHeader("Referer");
        } catch {}
        const prev = this._streams.get(id);
        // the master playlist comes first; variant playlists after it are its children
        if (prev && manifest && prev.manifest && Date.now() - prev.at < 20000 && url !== prev.url) {
          return;
        }
        this._streams.set(id, { url, referer, manifest, at: Date.now() });
      } catch {}
    }, "http-on-examine-response");
  },

  get player() {
    return Services.prefs.getStringPref(EXT + "player", "reel");
  },

  /* The address worth handing over: the video's own when it is a real file
     or stream, else the deepest embedded player page (a hoster's iframe),
     else the page itself. */
  async source(browser, hint = {}) {
    const reply = await new Promise((resolve) => {
      const mm = browser.messageManager;
      if (!mm) {
        resolve({});
        return;
      }
      const done = (msg) => {
        mm.removeMessageListener("ZenMedia:SourceReply", done);
        resolve(msg.data || {});
      };
      mm.addMessageListener("ZenMedia:SourceReply", done);
      mm.sendAsyncMessage("ZenMedia:Source");
      lazy.setTimeout(() => done({}), 800);
    });
    const page = browser.currentURI?.spec || "";
    // sites yt-dlp reads from the page itself: their players stream from blob: URLs, and their
    // frames are extensions and chat (Twitch's video_overlay.html), never the video
    if (/^https?:\/\/([^/]+\.)?(twitch\.tv|youtube\.com|youtu\.be|kick\.com|vimeo\.com|dailymotion\.com|soundcloud\.com)\//.test(page)) {
      const live = await this.playingFrame(browser);
      // a live channel has no position to start at; its recordings (/videos/) do
      const isLive = /twitch\.tv\/(?!videos\/)[^/?#]+\/?([?#]|$)/.test(page) || /kick\.com\/[^/?#]+\/?([?#]|$)/.test(page);
      return { url: page, referer: page, position: isLive ? null : live?.time ?? hint.position ?? reply.position ?? null };
    }
    let url = /^https?:/.test(hint.src || "") ? hint.src : reply.src;
    let referer = hint.frame || page;
    // the frame that is really playing: its video's time, and its page as the referrer
    const live = await this.playingFrame(browser);
    if (live) {
      hint = Object.assign({}, hint, { position: live.time ?? hint.position });
      if (!url && /^https?:/.test(live.src)) {
        url = live.src;
        referer = live.frame;
      }
    }
    // what the tab's player actually streamed (see watch): better than any page address
    const seen = this._streams.get(browser.browserId);
    if (!url && seen && Date.now() - seen.at < 6 * 3600 * 1000) {
      return { url: seen.url, referer: seen.referer || hint.frame || page, position: hint.position ?? reply.position ?? null };
    }
    // a player streaming from a blob: URL (x.com and most sites with their own player): only the
    // browser can read that, but yt-dlp finds the video from the page (or the frame) it plays in.
    // Before the frame scan below, which would pick whatever iframe came last (an ad, a widget).
    if (!url && (/^blob:/.test(hint.src || "") || /^blob:/.test(reply.src || "") || /^blob:/.test(live?.src || ""))) {
      return { url: hint.frame || page, referer: page, position: hint.position ?? reply.position ?? null };
    }
    if (!url && hint.frame && hint.frame !== page) {
      url = hint.frame;
      referer = page;
    }
    if (!url) {
      const frames = browser.browsingContext
        .getAllBrowsingContextsInSubtree()
        .slice(1)
        .map((bc) => bc.currentWindowGlobal?.documentURI?.spec || "")
        .filter((u) => /^https?:/.test(u) && !/ads?[.\/]|doubleclick|googlesyndication|recaptcha|disqus/.test(u));
      url = frames.at(-1) || reply.page || page;
      referer = page;
    }
    return { url, referer, position: hint.position ?? reply.position ?? null };
  },

  /* Asks every frame of the tab for its video; the playing one wins, else the
     longest. { time, src, frame } or null. */
  async playingFrame(browser) {
    const frames = browser.browsingContext?.getAllBrowsingContextsInSubtree() || [];
    const answers = await Promise.all(frames.map(async (bc) => {
      try {
        const actor = bc.currentWindowGlobal?.getActor("TelaMediaSource");
        const r = await Promise.race([actor.sendQuery("Query"), new Promise((res) => lazy.setTimeout(() => res(null), 600))]);
        return r && { ...r, frame: bc.currentWindowGlobal.documentURI?.spec || "" };
      } catch {
        return null;
      }
    }));
    const found = answers.filter((a) => a && Number.isFinite(a.time));
    found.sort((a, b) => (b.playing - a.playing) || (b.duration || 0) - (a.duration || 0));
    return found[0] || null;
  },

  // Netscape cookies.txt for the hosts involved, readable by yt-dlp and mpv.
  async cookieFile(browser, urls) {
    const attrs = browser.contentPrincipal?.originAttributes || {};
    const hosts = new Set();
    for (const u of urls) {
      try {
        const h = new URL(u).hostname;
        hosts.add(h);
        hosts.add(h.split(".").slice(-2).join("."));
      } catch {}
    }
    const lines = ["# Netscape HTTP Cookie File"];
    for (const h of hosts) {
      for (const c of Services.cookies.getCookiesFromHost(h, attrs)) {
        const exp = c.isSession ? 0 : Math.floor(c.expiry / 1000) || 0;
        lines.push([c.isDomain ? "." + c.rawHost : c.host, c.isDomain ? "TRUE" : "FALSE", c.path,
          c.isSecure ? "TRUE" : "FALSE", exp, c.name, c.value].join("\t"));
      }
    }
    if (lines.length === 1) {
      return "";
    }
    const file = PathUtils.join(PathUtils.tempDir, `tela-cookies-${Date.now()}.txt`);
    await IOUtils.writeUTF8(file, lines.join("\n") + "\n", { mode: "create" });
    await IOUtils.setPermissions(file, 0o600);
    return file;
  },

  async helper() {
    const name = Services.prefs.getStringPref(EXT + "helper", "media");
    if (name.startsWith("/")) {
      return name;
    }
    try {
      return await lazy.Subprocess.pathSearch(name);
    } catch {
      return PathUtils.join(Services.dirsvc.get("Home", Ci.nsIFile).path, ".scripts", name);
    }
  },

  /* Returns false when nothing could be launched, so the caller leaves the
     browser's copy playing. */
  async open(browser, hint = {}) {
    const { url, referer, position } = await this.source(browser, hint);
    if (!url) {
      return false;
    }
    const args = ["external", "--player", this.player, "--referer", referer];
    if (this.player === "custom") {
      args.push("--command", Services.prefs.getStringPref(EXT + "command", ""));
    }
    if (Number.isFinite(position) && position > 5) {
      args.push("--start", String(Math.floor(position)));
    }
    if (Services.prefs.getBoolPref(EXT + "send-cookies", true)) {
      const file = await this.cookieFile(browser, [url, referer]);
      if (file) {
        args.push("--cookies", file);
      }
    }
    args.push(url);
    try {
      await lazy.Subprocess.call({ command: await this.helper(), arguments: args, stderr: "stdout" });
    } catch (ex) {
      console.error("TelaExternalPlayer: could not start the media helper", ex);
      return false;
    }
    return true;
  },

  get pauseInBrowser() {
    return Services.prefs.getBoolPref(EXT + "pause-in-browser", true);
  },

  /* Per-site rules: host -> { always, after }, kept as JSON in zen.media.external.sites. */
  get sites() {
    try {
      const v = JSON.parse(Services.prefs.getStringPref(EXT + "sites", "{}"));
      return v && typeof v === "object" ? v : {};
    } catch {
      return {};
    }
  },

  // The rule for a page: its host's, else the nearest parent domain's.
  ruleFor(url) {
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      return null;
    }
    const sites = this.sites;
    for (let h = host; h; ) {
      if (sites[h]) {
        return sites[h];
      }
      const i = h.indexOf(".");
      if (i < 0) {
        break;
      }
      h = h.slice(i + 1);
    }
    return null;
  },

  // patch is { always?, after? }; null removes the host.
  setRule(host, patch) {
    const sites = this.sites;
    if (patch === null) {
      delete sites[host];
    } else {
      sites[host] = { always: false, after: "pause", ...sites[host], ...patch };
    }
    Services.prefs.setStringPref(EXT + "sites", JSON.stringify(sites));
  },

  // browser -> true while its page holds a video (the urlbar icon follows it)
  _videos: new WeakMap(),
  hasVideo(browser) {
    return this._videos.get(browser) === true;
  },
  noteVideo(browser) {
    if (!this._videos.get(browser)) {
      this._videos.set(browser, true);
      this.onVideo?.(browser);
    }
  },
  forgetVideos(browser) {
    this._videos.delete(browser);
  },
  // set by the browser window: onVideo(browser), onMenu(browser, x, y)
  onVideo: null,
  onMenu: null,

  /* One way to hand a video to reel, for every control: open it, then do what the
     site's rule says to the tab: pause (the default), close it, or keep playing. */
  async handoff(browser, hint = {}) {
    const rule = this.ruleFor(browser.currentURI?.spec || "");
    const after = rule?.after || (this.pauseInBrowser ? "pause" : "keep");
    if (!(await this.open(browser, hint))) {
      return false;
    }
    if (after === "pause") {
      browser.browsingContext?.mediaController?.pause("user");
    } else if (after === "close") {
      const win = browser.ownerGlobal;
      const tab = win?.gBrowser?.getTabForBrowser(browser);
      if (tab) {
        win.gBrowser.removeTab(tab);
      }
    }
    return true;
  },
};

/* The frame side: the video this frame plays (or holds), for "Open in another app". */
export class TelaMediaSourceChild extends JSWindowActorChild {
  handleEvent(event) {
    const v = event.target;
    if (v?.localName !== "video") {
      return;
    }
    if (event.type === "loadedmetadata") {
      this.sendAsyncMessage("TelaMedia:HasVideo");
    } else if (event.type === "play") {
      this.sendAsyncMessage("TelaMedia:Playing", {
        src: v.currentSrc || "",
        position: v.currentTime,
        frame: this.document?.documentURI || "",
      });
    }
  }

  receiveMessage(msg) {
    if (msg.name !== "Query") {
      return null;
    }
    const videos = [...(this.document?.querySelectorAll("video") || [])];
    if (!videos.length) {
      return null;
    }
    const v = videos.find((x) => !x.paused) || videos.sort((a, b) => (b.duration || 0) - (a.duration || 0))[0];
    const duration = Number.isFinite(v.duration) ? v.duration : 0;
    return { time: v.currentTime, duration, playing: v.paused ? 0 : 1, src: v.currentSrc || "" };
  }
}

export class TelaMediaSourceParent extends JSWindowActorParent {
  // the sources each document already handed over on its own ("always" rule): once per page load
  #handed = new WeakMap();

  receiveMessage(msg) {
    const browser = this.browsingContext?.top?.embedderElement;
    if (!browser) {
      return;
    }
    const { src = "", position, frame = "" } = msg.data || {};
    switch (msg.name) {
      case "TelaMedia:HasVideo":
        TelaExternalPlayer.noteVideo(browser);
        break;
      case "TelaMedia:Reel":
        TelaExternalPlayer.handoff(browser, { src, frame, position });
        break;
      case "TelaMedia:Menu":
        TelaExternalPlayer.onMenu?.(browser, msg.data.x, msg.data.y);
        break;
      case "TelaMedia:Playing": {
        if (!TelaExternalPlayer.ruleFor(browser.currentURI?.spec || "")?.always) {
          break;
        }
        const seen = this.#handed.get(this.manager) || new Set();
        this.#handed.set(this.manager, seen);
        if (!seen.has(src || frame)) {
          seen.add(src || frame);
          TelaExternalPlayer.handoff(browser, { src, frame, position });
        }
        break;
      }
    }
  }
}
