// ==UserScript==
// @name         watch-tracker
// @namespace    tela
// @version      2.12.0
// @description  What you watched, on any site you switch it on for: progress, episodes, continue, autoplay of the next episode. Alt+W.
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @run-at       document-idle
// @downloadURL  http://127.0.0.1:8788/watch-tracker.user.js
// @updateURL    http://127.0.0.1:8788/watch-tracker.user.js
// ==/UserScript==

(() => {
  "use strict";
  const MSG = "watch-tracker";

  // ---- inside a frame: report the frame's <video> to the page that embeds it.
  // Embedded players (moflix's hosts) are cross-origin, so only a copy of this
  // script running in the frame can see their time and their end.
  // a trace of each step to the media bridge (~/.cache/watch-tracker.log), for chasing autoplay on a site
  const DEBUG = false;   // true: trace to ~/.cache/watch-tracker.log
  const dbg = (...m) => { if (!DEBUG) return; try { GM_xmlhttpRequest({ method: "POST", url: "http://127.0.0.1:8788/wtlog",
    headers: { "Content-Type": "application/json" }, data: JSON.stringify({ where: (window.top === window.self ? "page " : "frame ") + location.hostname,
    msg: m.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" ") }) }); } catch {} };
  if (window.top !== window.self) {
    let lastEnded = false;
    setInterval(() => {
      const v = [...document.querySelectorAll("video")].find(x => x.duration > 30) ;
      if (!v) return;
      const ended = v.ended || (v.duration - v.currentTime < 0.5 && v.paused);
      if (ended && lastEnded) return;
      if (ended) dbg("video ended", { t: Math.round(v.currentTime), dur: Math.round(v.duration) });
      lastEnded = ended;
      try {
        window.top.postMessage({ [MSG]: { pos: v.currentTime, dur: v.duration, paused: v.paused, ended } }, "*");
      } catch {}
    }, 2000);
    // Starting the next episode in a fresh frame: Firefox lets an unclicked frame play only muted, and pauses
    // it again if a script unmutes it. So: click through the start screen, play with sound if allowed, else
    // muted with a "sound on" button (one click). Allowing autoplay for the hoster makes it fully hands-free.
    // kinoger's devideosrc player: its own episode list (._ep) and a cover (#overlay) to click before
    // an episode loads. Which episode is on goes to the page; the page asks for the next one.
    const devideo = /(^|\.)devideosrc\./.test(location.hostname);
    const epInfo = () => {
      const a = document.querySelector("._ep.active");
      if (!a) return null;
      const all = [...document.querySelectorAll("._ep:not(.no-link)")], n = all[all.indexOf(a) + 1];
      const one = x => ({ s: +x.dataset.season, e: +x.dataset.episode, label: x.dataset.label || "" });
      return { ...one(a), next: n ? one(n) : null };
    };
    const cover = () => { const o = document.getElementById("overlay"); return o && o.offsetWidth && getComputedStyle(o).display !== "none" ? o : null; };
    let coverAt = 0;   // a click on the cover (re)loads the episode: once per switch, never every second
    const coverOnce = () => { const o = cover(); if (o && Date.now() - coverAt > 15000) { coverAt = Date.now(); o.click(); return true; } return false; };
    function epGo(s, e) {
      dbg("epGo", s, e, "item:", !!document.querySelector(`._ep[data-season="${s}"][data-episode="${e}"]`));
      document.querySelector(`._ep[data-season="${s}"][data-episode="${e}"]`)?.click();
      coverAt = 0;
      setTimeout(coverOnce, 400);
    }
    if (devideo) {
      let last = "";
      setInterval(() => {
        const x = epInfo(), j = JSON.stringify(x);
        if (!x) return;
        if (j !== last) { last = j; dbg("episode on", x); }
        // every time, not only on a change: the page may start listening after the first one
        try { window.top.postMessage({ [MSG + "-ep"]: x }, "*"); } catch {}
      }, 1000);
    }
    let soundBtn = null;
    function kickPlay() {
      if (devideo) { dbg("play: cover clicked", coverOnce()); return; }   // the list is here too: no blind click in the middle
      const v = [...document.querySelectorAll("video")].sort((a, b) => b.clientWidth - a.clientWidth)[0];
      dbg("play: video", v ? { paused: v.paused, t: Math.round(v.currentTime), ready: v.readyState } : "none");
      if (v && !v.paused && v.currentTime > 0) return;
      const known = document.querySelector([".jw-display-icon-display", ".jw-icon-display", ".plyr__control--overlaid", ".vjs-big-play-button",
        ".play-button", ".play-btn", "[class*=play][class*=big]", "[aria-label=Play]", "[aria-label=Abspielen]"].join(","));
      // the logo or ad layer usually covers the middle of the player: a click there gets past it
      const mid = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
      for (const t of [known, mid]) if (t && t !== document.documentElement && t !== document.body) {
        for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"])
          t.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: innerWidth / 2, clientY: innerHeight / 2 }));
      }
      if (!v) return;
      v.play().then(() => dbg("play: with sound"), err => {
        dbg("play: blocked, muted instead", String(err?.name));
        v.muted = true;
        v.play().then(() => {
          if (soundBtn) return;
          soundBtn = document.createElement("button");
          soundBtn.textContent = "🔇 Sound on";
          soundBtn.style.cssText = "position:fixed;z-index:2147483647;top:14px;right:14px;padding:9px 14px;border:0;border-radius:18px;background:#1d1b20ee;color:#fff;font:600 14px system-ui;cursor:pointer;box-shadow:0 4px 16px #0008";
          soundBtn.onclick = e => { e.stopPropagation(); v.muted = false; v.play(); soundBtn.remove(); soundBtn = null; };
          document.documentElement.append(soundBtn);
        }).catch(() => {});
      });
    }
    // The sleep timer in the page drives this frame's player: volume and pause.
    window.addEventListener("message", ev => {
      const c = ev.data?.[MSG + "-cmd"];
      if (!c) return;
      for (const v of document.querySelectorAll("video")) {
        if (c.op === "volume") v.volume = Math.max(0, Math.min(1, c.v));
        if (c.op === "pause") v.pause();
      }
      // after autoplay picked the next episode: past the hoster's logo / ad layer, and playing
      if (c.op === "play") kickPlay();
      if (devideo && c.op === "goEp") { const x = epInfo(); if (!x || x.s !== c.s || x.e !== c.e) epGo(c.s, c.e); }
      if (devideo && c.op === "nextEp") { const n = epInfo()?.next; dbg("nextEp ->", n); if (n) epGo(n.s, n.e); }
      for (const f of document.querySelectorAll("iframe")) try { f.contentWindow.postMessage(ev.data, "*"); } catch {}
    });
    return;
  }

  // ---- settings -----------------------------------------------------------
  const DEFAULTS = {
    watchedPct: 90,       // % seen that counts as watched
    autoplay: true,       // open the next episode at the end
    countdown: 10,        // s of "next in…" before it opens
    creditsSec: 0,        // start the countdown this many s before the end (skip credits)
    fallbackMin: true,    // no player time at all: use the episode runtime
    button: true,         // the round button bottom right
    toast: true,          // "Tracking: <title>" for 3 s when a page is identified
    sites: ["moflix-stream.xyz", "youtube.com", "megakino25.com", "kinoger.com", "s.to", "filmpalast.to",
      // German streaming list (FMHY), mirrors included
      "serienstream.to", "serien.domains", "movie2k.cx", "kinox.to", "kinos.to", "kinoz.to", "kinoking.cc",
      "flixfilmplus.de", "filmo.to", "aether.ist", "aether.cx", "megakino20.com", "streamkiste.bid",
      "einschalten.in", "haschcon.com", "ardmediathek.de", "zdf.de", "burningseries.ac", "burningseries.cx"],
  };
  // Sites added to DEFAULTS after a user saved settings: add each once, so removing one sticks.
  (() => {
    const known = JSON.parse(GM_getValue("defaultSites", "[]")), fresh = DEFAULTS.sites.filter(x => !known.includes(x));
    if (!fresh.length) return;
    const raw = GM_getValue("settings", null);
    if (raw) { const s = JSON.parse(raw); s.sites = [...new Set([...(s.sites || []), ...fresh])]; GM_setValue("settings", JSON.stringify(s)); }
    GM_setValue("defaultSites", JSON.stringify(DEFAULTS.sites));
  })();
  const settings = () => ({ ...DEFAULTS, ...JSON.parse(GM_getValue("settings", "{}")) });
  const saveSettings = s => GM_setValue("settings", JSON.stringify(s));
  const load = () => { try { return JSON.parse(GM_getValue("history", "{}")); } catch { return {}; } };
  // The media bridge keeps a copy for reel's "From the browser" page; off when it is not running.
  let pushTimer = 0;
  const push = h => {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      try {
        GM_xmlhttpRequest({ method: "POST", url: "http://127.0.0.1:8788/watch", headers: { "Content-Type": "application/json" },
                            data: JSON.stringify({ titles: h }), onerror() {} });
      } catch {}
    }, 2000);
  };
  const save = h => { GM_setValue("history", JSON.stringify(h)); push(h); };
  // Two copies of one history (this browser's, and the bridge's that reel's progress reaches): per episode the
  // higher pct and the newer copy's state; per title the newer last. Only `mine` titles, unless `adopt`.
  const mergeEp = (a, b) => {
    if (!a || !b) return { ...(a || b) };
    const [older, newer] = (b.at || 0) >= (a.at || 0) ? [a, b] : [b, a];
    return { ...older, ...newer, pct: Math.max(a.pct || 0, b.pct || 0) };
  };
  const mergeHistory = (mine, theirs, adopt = false) => {
    const out = { ...mine };
    for (const [key, t] of Object.entries(theirs || {})) {
      const m = mine[key];
      if (!m) { if (adopt) out[key] = t; continue; }
      const eps = { ...m.eps };
      for (const [k, e] of Object.entries(t.eps || {})) eps[k] = mergeEp(eps[k], e);
      out[key] = { ...m, eps, last: (t.last?.at || 0) > (m.last?.at || 0) ? t.last : m.last };
    }
    return out;
  };

  const host = location.hostname.replace(/^www\.|^m\./, "");
  // These sites move domains often (kinoger.com -> kinoger.beer, megakino25 -> megakino26): the
  // site's name counts, without its ending or a number in it; an exact host still matches as before.
  const siteName = h => (h.replace(/^www\./, "").split(".").slice(-2, -1)[0] || "").replace(/\d+$/, "");
  const onSite = s => host === s || host.endsWith("." + s) || (siteName(s).length > 3 && siteName(host) === siteName(s));
  // Elsewhere: no tracking and no button, only the list from the extension menu.
  const tracked = settings().sites.some(onSite);
  if (!tracked) {
    GM_registerMenuCommand(`Track videos on ${host}`, () => {
      const s = settings(); s.sites.push(host); saveSettings(s); location.reload();
    });
  }

  // ---- adapters: which title / season / episode this page is, and what comes next.
  // identify() -> { key, name, poster, series, s, e, epName, runtimeMin, url } | null
  const nextBtnText = /n(ä|ae)chste (folge|episode)|next (episode|video)|weiter/i;
  function clickNextButton() {
    const b = [...document.querySelectorAll("a,button")].find(x => nextBtnText.test(x.textContent || x.title || ""));
    if (b) { b.click(); return true; }
    return false;
  }

  const moflix = {
    match: () => onSite("moflix-stream.xyz"),
    _parse(html) {
      const m = html.match(/window\.bootstrapData\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
      try { return m ? JSON.parse(m[1]).loaders?.watchPage : null; } catch { return null; }
    },
    async _watch(id) {
      const first = (typeof unsafeWindow !== "undefined" ? unsafeWindow : window).bootstrapData?.loaders?.watchPage;
      if (first?.video?.id == id) return JSON.parse(JSON.stringify(first));
      return this._parse(await (await fetch(`/watch/${id}`, { credentials: "same-origin" })).text());
    },
    async identify() {
      const m = location.pathname.match(/^\/watch\/(\d+)/);
      if (!m) return null;
      const w = await this._watch(m[1]);
      if (!w?.title) return null;
      const t = w.title, v = w.video || {}, e = w.episode;
      return {
        key: `moflix:${t.id}`, titleId: t.id, name: t.name, poster: t.poster, series: !!t.is_series,
        s: e?.season_number ?? v.season_num ?? 0, e: e?.episode_number ?? v.episode_num ?? 0,
        epName: e?.name || null, runtimeMin: e?.runtime || t.runtime || null, url: `/watch/${v.id}`,
        seasons: t.seasons_count || null,
      };
    },
    // Episodes of a season with a playable video, from the app's own API.
    async _episodes(titleId, s) {
      const r = await fetch(`/api/v1/titles/${titleId}/seasons/${s}/episodes?perPage=200`,
        { credentials: "same-origin", headers: { Accept: "application/json" } });
      if (!r.ok) return [];
      const found = [];
      (function walk(o) {
        if (Array.isArray(o)) { o.forEach(walk); return; }
        if (!o || typeof o !== "object") return;
        if ("episode_number" in o) {
          const vid = o.primary_video?.id ?? o.videos?.[0]?.id ?? o.video?.id;
          if (vid) found.push({ e: o.episode_number, video: vid });
          return;
        }
        Object.values(o).forEach(walk);
      })(await r.json().catch(() => null));
      return found.sort((a, b) => a.e - b.e);
    },
    async next(it) {
      try {
        const here = await this._episodes(it.titleId, it.s);
        const n = here.find(x => x.e > it.e);
        if (n) return { url: `/watch/${n.video}`, label: `S${it.s}E${n.e}` };
        if (!it.seasons || it.s < it.seasons) {
          const first = (await this._episodes(it.titleId, it.s + 1))[0];
          if (first) return { url: `/watch/${first.video}`, label: `S${it.s + 1}E${first.e}` };
        }
      } catch {}
      return { click: true, label: "next episode" };
    },
  };

  const youtube = {
    match: () => onSite("youtube.com"),
    async identify() {
      const q = new URLSearchParams(location.search), v = q.get("v");
      if (location.pathname !== "/watch" || !v) return null;
      const title = document.title.replace(/^\(\d+\)\s*/, "").replace(/ - YouTube$/, "");
      const list = q.get("list");
      if (list && !/^RD/.test(list)) {
        const pl = document.querySelector("ytd-playlist-panel-renderer #header-description h3, ytd-playlist-panel-renderer .title")
          ?.textContent?.trim();
        return { key: `yt:list:${list}`, name: pl || "Playlist", poster: `https://i.ytimg.com/vi/${v}/hqdefault.jpg`,
                 series: true, s: 1, e: Number(q.get("index")) || 1, epName: title,
                 url: `/watch?v=${v}&list=${list}&index=${q.get("index") || 1}` };
      }
      const channel = document.querySelector("ytd-video-owner-renderer #channel-name a")?.textContent?.trim();
      return { key: `yt:${v}`, name: title, sub: channel, poster: `https://i.ytimg.com/vi/${v}/hqdefault.jpg`,
               series: false, url: `/watch?v=${v}` };
    },
    // YouTube has its own autoplay; in a playlist its next button is the next episode.
    async next(it) { return it.series ? { click: ".ytp-next-button", label: "next in playlist" } : null; },
    resumeUrl: (it, pos) => `${it.url}&t=${Math.floor(pos)}s`,
  };

  // kinoger: one page per season, its episodes in a dropdown (li#serie-<season>_<episode>) that switches
  // the player inside the page, so the address never says which one plays. The episode goes into the
  // address as #s2e5 instead, which also lets a resume open that episode. Its devideosrc player (a frame
  // of another site, shown when kinoger knows the IMDb id) cannot be read or driven, so the episode
  // list's player is shown in its place.
  // Two players. The episode list's (li#serie-<s>_<e>, its hosters as data-link) switches inside the page;
  // the devideosrc frame, shown when kinoger knows the IMDb id, has its own list, which our copy in that
  // frame reports (MSG-ep) and drives (goEp / nextEp). Neither changes the address, so the episode goes
  // into it as #s2e5, which also lets a resume open that episode.
  let kgEp = null;   // the devideosrc frame's latest { s, e, label, next }
  const tellFrames = cmd => { for (const f of document.querySelectorAll("iframe")) try { f.contentWindow.postMessage({ [MSG + "-cmd"]: cmd }, "*"); } catch {} };
  if (siteName(host) === "kinoger") window.addEventListener("message", ev => {
    const d = ev.data?.[MSG + "-ep"];
    if (!d) return;
    const was = kgEp;
    kgEp = d;
    if (was && (was.s !== d.s || was.e !== d.e)) kinoger.switched(d);
    else if (!was && cur && (cur.s !== d.s || cur.e !== d.e)) kinoger.switched(d);
  });
  const kinoger = {
    match: () => siteName(host) === "kinoger",
    eps: () => [...document.querySelectorAll('.ep-menu > li[id^="serie-"]')],
    se: li => { const m = li?.id.match(/^serie-(\d+)_(\d+)$/); return m ? { s: +m[1], e: +m[2] } : null; },
    // the list's player only when it has hosters: on many pages they are all commented out
    listPlays: () => !!document.querySelector(".ep-menu a[data-link]"),
    devideo: () => !!document.getElementById("mc-serial-iframe") && !kinoger.listPlays(),
    want: () => { const m = location.hash.match(/^#s(\d+)e(\d+)$/); return m ? { s: +m[1], e: +m[2] } : null; },
    show() {
      const raw = document.querySelector('meta[property="og:title"]')?.content || document.title;
      return raw.split("»")[0].replace(/\s*-?\s*(staffel|season)\s*\d+.*$/i, "").replace(/\*[^*]*\*/g, "").trim();
    },
    setup() {
      if (this.ready || (!this.eps().length && !document.getElementById("mc-serial-iframe"))) return;
      this.ready = true;
      const want = this.want();
      if (this.listPlays()) {
        const mc = document.getElementById("mc-player-wrap"), dle = document.getElementById("dle-player-wrap");
        if (mc && dle) {
          const swap = () => { mc.remove(); dle.style.display = "block"; };
          swap(); setTimeout(swap, 1500);   // kinoger decides which player to show a moment after load
        }
        if (want) document.querySelector(`#serie-${want.s}_${want.e} > a`)?.click();
        document.addEventListener("click", ev => {
          const se = this.se(ev.target.closest?.('.ep-menu > li[id^="serie-"]'));
          if (se) this.switched(se);
        }, true);
      } else {
        // devideosrc: its episode reports (listened to from the start, below); a resume asks for the episode until it has it
        if (want) { let n = 0; const t = setInterval(() => { if (++n > 20 || (kgEp && kgEp.s === want.s && kgEp.e === want.e)) return clearInterval(t); tellFrames({ op: "goEp", ...want }); }, 1000); }
      }
      if (sessionStorage.getItem("wt-kick")) { sessionStorage.removeItem("wt-kick"); this.kick(); }
    },
    switched(se) {
      dbg("switched to", se);
      switchedAt = Date.now();
      history.replaceState(null, "", `#s${se.s}e${se.e}`);
      cur = null; frame = null; hideCountdown();   // the old player's report is not the new episode's
      setTimeout(route, 300);
    },
    // the new episode's player starts on a logo or cover: told to play every second until it does (20 s)
    kick() {
      let n = 0;
      // the old episode's last report ("playing", at its end) must not count as the new one running
      switchedAt = Date.now(); frame = null;
      const t = setInterval(() => {
        const p = progress();
        if (++n > 25 || (n > 2 && p && !p.paused && p.pos > 1 && p.pos < 120)) { dbg("kick done after", n, p); return clearInterval(t); }
        tellFrames({ op: "play" });
      }, 1000);
    },
    async identify() {
      this.setup();
      const name = this.show(), base = { key: `kinoger:${name.toLowerCase()}`, name, sub: "kinoger", series: true,
        poster: document.querySelector('meta[property="og:image"]')?.content || null };
      if (this.devideo()) {
        const se = kgEp || this.want() || { s: 1, e: 1 };
        return { ...base, s: se.s, e: se.e, epName: kgEp?.label?.replace(/^S\d+ E\d+\s*—\s*/, "") || null, url: `${location.pathname}#s${se.s}e${se.e}` };
      }
      const eps = this.eps();
      if (!eps.length) return null;   // a film: the generic adapter takes it
      const se = this.se(eps.find(x => x.classList.contains("active")) || eps[0]);
      return { ...base, s: se.s, e: se.e, url: `${location.pathname}#s${se.s}e${se.e}` };
    },
    // the next entry of the list; after the last, the next season's page if this one links it
    async next(it) {
      if (this.devideo()) {
        const n = kgEp?.next;
        return n ? { run: () => { tellFrames({ op: "nextEp" }); this.kick(); }, label: n.s !== it.s ? `Season ${n.s}` : `Episode ${n.e}` } : null;
      }
      const eps = this.eps(), i = eps.findIndex(x => { const se = this.se(x); return se.s === it.s && se.e === it.e; });
      const nx = eps[i + 1];
      if (nx) return { run: () => { nx.querySelector("a").click(); this.kick(); }, label: `Episode ${this.se(nx).e}` };
      const re = new RegExp(`staffel\\s*${it.s + 1}\\b`, "i"), name = it.name.toLowerCase();
      const a = [...document.querySelectorAll("a[href][title]")].find(x => re.test(x.title) && x.title.toLowerCase().startsWith(name));
      if (!a) return null;
      return { run: () => { try { sessionStorage.setItem("wt-kick", "1"); } catch {} location.href = a.href.replace(/#.*$/, "") + `#s${it.s + 1}e1`; },
               label: `Season ${it.s + 1}` };
    },
  };

  // Any other site: season and episode from the address (/staffel-2/episode-5, /season/2/episode/5, s02e05, 2x05),
  // the title from the page minus the site's name. Without either, only a page with a video counts.
  const SE = [
    /(?:staffel|season)[-/_]?(\d+)\D{0,3}(?:episode|folge)[-/_]?(\d+)/i,
    /\bs(\d{1,2})[ ._-]?e(\d{1,3})\b/i,
    /(?:^|[^\d])(\d{1,2})x(\d{1,3})(?!\d)/i,
  ];
  const seIn = path => {
    for (const re of SE) { const m = path.match(re); if (m) return { s: +m[1], e: +m[2], at: m.index }; }
    return null;
  };
  const siteWord = host.split(".")[0].toLowerCase();
  function pageTitle() {
    const raw = document.querySelector('meta[property="og:title"]')?.content || document.title || "";
    const parts = raw.split(/\s+[|–—-]\s+/);
    const name = parts.find(p => p.trim() && !(siteWord.length > 3 && p.toLowerCase().includes(siteWord))) || parts[0] || host;
    return name.replace(/\s*\b(staffel|season)\s*\d+.*$/i, "").replace(/\s*\b(folge|episode)\s*\d+.*$/i, "").trim() || host;
  }
  const generic = {
    match: () => true,
    async identify() {
      const path = location.pathname, se = seIn(path);
      if (!se && !document.querySelector("video") && !frameSeen) return null;
      const show = se ? path.slice(0, se.at).replace(/[-/_]+$/, "") || "/" : path;
      return { key: `${host}${show}`, name: pageTitle(), sub: host, epName: null,
               poster: document.querySelector('meta[property="og:image"]')?.content || null,
               series: !!se, s: se?.s ?? 0, e: se?.e ?? 0, url: path + location.search };
    },
    async next() { return { click: true, label: "next" }; },
  };
  // "Tracking: <title> S02E05" for a few seconds, when a page is identified.
  function toastTrack(it) {
    // media-view's button says it instead, in the same corner: one thing there, not two
    if (document.getElementById("mv-root")) return;
    const ep = it.series ? ` S${String(it.s).padStart(2, "0")}E${String(it.e).padStart(2, "0")}` : "";
    document.getElementById("wt-toast")?.remove();
    const t = el("div", { id: "wt-toast", textContent: `Tracking: ${it.name}${ep}` });
    document.body.append(t);
    setTimeout(() => t.remove(), 3000);
  }
  const adapter = [moflix, youtube, kinoger].find(a => a.match()) || generic;

  // ---- progress: the page's own <video>, else what an embedded frame reports.
  let frame = null, frameSeen = false;
  let switchedAt = 0;   // an episode switch inside the page: the old player's last reports arrive after it
  window.addEventListener("message", ev => {
    const d = ev.data?.[MSG];
    if (d && typeof d.pos === "number") {
      if (Date.now() - switchedAt < 20000 && d.pos > 30) return;   // still the old episode's player
      frame = { ...d, at: Date.now() }; frameSeen = true;
    }
  });
  function progress() {
    const v = [...document.querySelectorAll("video")].find(x => x.duration > 30);
    if (v) return { pos: v.currentTime, dur: v.duration, paused: v.paused, ended: v.ended, src: "page" };
    if (frame && Date.now() - frame.at < 8000) return { ...frame, src: "frame" };
    return null;
  }

  // ---- tracking -----------------------------------------------------------
  let cur = null;          // the identified item on screen
  let visibleSecs = 0, lastTick = Date.now();
  async function route() {
    // the old player's last report ("ended") would otherwise count for the new episode for 8 s
    cur = null; visibleSecs = 0; hideCountdown(); nextCache = undefined; frame = null;
    let it = null;
    try { it = await adapter.identify(); } catch {}
    if (!it && adapter !== generic) try { it = await generic.identify(); } catch {}
    if (!it) return;
    cur = it;
    announce();
    const h = load();
    const t = h[it.key] ||= { name: it.name, poster: it.poster, series: it.series, site: host, eps: {} };
    Object.assign(t, { name: it.name, sub: it.sub ?? t.sub, poster: it.poster || t.poster, series: it.series, site: host,
                       titleId: it.titleId, seasons: it.seasons });
    const k = it.series ? `${it.s}:${it.e}` : "main";
    const prev = t.eps[k] || {};
    // stored whole ("https://site/watch/1"): reel and other readers have no page to resolve it against
    const url = new URL(it.url, location.origin).href;
    t.eps[k] = { ...prev, url, name: it.epName ?? prev.name ?? null, state: prev.state || "started", at: prev.at ?? Date.now() };
    t.last = { k, url, at: Date.now() };
    save(h);
    if (settings().toast) toastTrack(it);
    if (panel.isConnected) render();
  }

  let nextCache; // undefined = not asked yet

  // ---- media-view: the companion player asks what is on and for the next episode, by window
  // message (the two scripts live in separate sandboxes; a message crosses, an object does not)
  async function announce() {
    if (!cur) return;
    if (nextCache === undefined) nextCache = await adapter.next?.(cur).catch(() => null) ?? null;
    // and to the media bridge, for reel's "Up next" when this page is played there
    // the page on now, for reel: when a hoster will not play there, it opens this page's other mirrors
    try {
      GM_xmlhttpRequest({ method: "POST", url: "http://127.0.0.1:8788/now", headers: { "Content-Type": "application/json" },
        data: JSON.stringify({ page: location.href, name: cur.name }), onerror() {} });
    } catch {}
    if (nextCache?.url) try {
      GM_xmlhttpRequest({ method: "POST", url: "http://127.0.0.1:8788/next", headers: { "Content-Type": "application/json" },
        data: JSON.stringify({ page: location.href, url: new URL(nextCache.url, location.href).href, label: nextCache.label || "Next", name: cur.name }), onerror() {} });
    } catch {}
    window.postMessage({ [MSG + "-item"]: { name: cur.name, sub: cur.sub || host, poster: cur.poster || null, series: !!cur.series,
      s: cur.s, e: cur.e, epName: cur.epName || null, next: nextCache ? (nextCache.label || "Next") : null } }, "*");
  }
  function goNext() {
    const n = nextCache;
    if (!n) return;
    hideCountdown();
    if (n.run) n.run();
    else if (n.url) location.href = n.url;
    else if (typeof n.click === "string") document.querySelector(n.click)?.click();
    else if (n.click) clickNextButton();
  }
  window.addEventListener("message", ev => {
    const a = ev.source === window && ev.data?.[MSG + "-ask"];
    if (a === "item") announce();
    if (a === "next") goNext();
  });
  // ---- sleep timer -------------------------------------------------------------
  // { at: ms, mode: "time" } or { mode: "episode" }; stored, so it survives the
  // page change when autoplay opens the next episode.
  const FADE_S = 30;
  const getSleep = () => { try { return JSON.parse(GM_getValue("sleep", "null")); } catch { return null; } };
  const setSleep = v => { GM_setValue("sleep", JSON.stringify(v)); drawSleep(); };
  let fadeFrom = null;
  function player(op, v) {
    for (const x of document.querySelectorAll("video")) {
      if (op === "volume") x.volume = Math.max(0, Math.min(1, v));
      if (op === "pause") x.pause();
      if (op === "getVolume") return x.volume;
    }
    if (op !== "getVolume") for (const f of document.querySelectorAll("iframe")) try { f.contentWindow.postMessage({ [MSG + "-cmd"]: { op, v } }, "*"); } catch {}
    return null;
  }
  function sleepNow(why) {
    player("pause");
    const vol = fadeFrom ?? 1;
    fadeFrom = null;
    setSleep(null);
    // Back to the old volume, so the next play is not silent.
    setTimeout(() => player("volume", vol), 1500);
    toastSleep(why);
  }
  function sleepTick(p) {
    const sl = getSleep();
    if (!sl) return;
    if (sl.mode === "time") {
      const left = (sl.at - Date.now()) / 1000;
      if (left <= FADE_S && left > 0) {
        if (fadeFrom == null) fadeFrom = player("getVolume") ?? 1;
        player("volume", fadeFrom * (left / FADE_S));
      }
      if (left <= 0) sleepNow("Sleep timer: paused");
    } else if (sl.mode === "episode" && p?.ended) sleepNow("Sleep timer: stopped after this episode");
  }
  function toastSleep(text) {
    const t = el("div", { id: "wt-next", textContent: `☾ ${text}` });
    document.body.append(t);
    setTimeout(() => t.remove(), 6000);
  }

  function tick() {
    const now = Date.now(), dt = (now - lastTick) / 1000;
    lastTick = now;
    sleepTick(progress());
    if (!cur) return;
    if (document.visibilityState === "visible") visibleSecs += dt;
    const p = progress(), s = settings();
    const h = load(), t = h[cur.key];
    if (!t) return;
    const k = cur.series ? `${cur.s}:${cur.e}` : "main", ep = t.eps[k];
    let pct = null, left = null;
    if (p && p.dur > 0 && isFinite(p.dur)) {
      pct = Math.min(100, (p.pos / p.dur) * 100); left = p.dur - p.pos;
      ep.pos = p.pos; ep.dur = p.dur;
    } else if (s.fallbackMin && cur.runtimeMin) {
      pct = Math.min(100, (visibleSecs / (cur.runtimeMin * 60)) * 100); left = cur.runtimeMin * 60 - visibleSecs;
    }
    if (pct != null) {
      ep.pct = Math.max(ep.pct || 0, Math.round(pct));
      if (pct >= s.watchedPct && ep.state !== "watched") { ep.state = "watched"; ep.at = Date.now(); }
    }
    save(h);
    const atEnd = p?.ended || (left != null && left <= Math.max(1, s.creditsSec) && (!p || !p.paused || p.ended));
    if (left != null && left < 40 && Math.round(left) % 10 === 0) dbg("near end", k, { left: Math.round(left), p, atEnd, series: cur.series, autoplay: s.autoplay, cancelled: cancelled.has(k) });
    if (atEnd && s.autoplay && cur.series && !countdownEl.isConnected && !cancelled.has(k) && getSleep()?.mode !== "episode") startCountdown(k);
  }
  if (tracked) setInterval(tick, 1000);

  // A site's own episode links: a ✓ and a dimmed look on each one we have watched (any title of this site).
  let markTimer = 0;
  function markLinks() {
    if (!tracked || onSite("youtube.com")) return;
    const seen = new Map();
    for (const t of Object.values(load())) if (t.site === host)
      for (const e of Object.values(t.eps || {})) {
        try { if (e.url) seen.set(new URL(e.url, location.href).href, e.state); } catch {}
      }
    for (const a of document.querySelectorAll("a[href]")) a.classList.toggle("wt-watched", seen.get(a.href) === "watched");
  }
  if (tracked) {
    new MutationObserver(() => { clearTimeout(markTimer); markTimer = setTimeout(markLinks, 400); })
      .observe(document.body, { childList: true, subtree: true });
    setTimeout(markLinks, 1000);
  }

  let lastUrl = "";
  if (tracked) setInterval(() => { if (location.href !== lastUrl) { lastUrl = location.href; setTimeout(route, 1200); } }, 1000);

  // Reel's progress lives in the bridge's copy: pulled in on tracked sites; an empty history is filled from it.
  // Nothing is posted back, the bridge has these already.
  if (tracked) GM_xmlhttpRequest({ method: "GET", url: "http://127.0.0.1:8788/watch", timeout: 5000,
    onload: r => {
      try {
        const mine = load(), next = mergeHistory(mine, JSON.parse(r.responseText).titles, !Object.keys(mine).length);
        if (JSON.stringify(next) !== JSON.stringify(mine)) { GM_setValue("history", JSON.stringify(next)); if (panel.isConnected) render(); }
      } catch {}
    }, onerror() {}, ontimeout() {} });

  // ---- autoplay countdown ---------------------------------------------------
  const cancelled = new Set();
  const countdownEl = document.createElement("div");
  countdownEl.id = "wt-next";
  let countTimer = null;
  async function startCountdown(k) {
    // "none" is not kept: the next episode may only become known a moment later (a frame's report)
    if (!nextCache) nextCache = await adapter.next?.(cur).catch(() => null) ?? null;
    const n = nextCache;
    dbg("countdown for", k, "next:", n ? n.label : "none", "kgEp:", kgEp);
    if (!n) return;
    let left = settings().countdown;
    const go = () => {
      hideCountdown();
      dbg("go:", n.label);
      if (n.run) n.run();
      else if (n.url) location.href = n.url;
      else if (typeof n.click === "string") document.querySelector(n.click)?.click();
      else if (n.click) clickNextButton();
    };
    const draw = () => {
      countdownEl.innerHTML = "";
      countdownEl.append(
        el("div", { className: "wt-next-t", textContent: `${n.label || "Next"} in ${left} s` }),
        el("button", { textContent: "Play now", onclick: go }),
        el("button", { textContent: "Cancel", onclick: () => { cancelled.add(k); hideCountdown(); } }));
    };
    draw();
    document.body.append(countdownEl);
    countTimer = setInterval(() => { left -= 1; if (left <= 0) go(); else draw(); }, 1000);
  }
  function hideCountdown() { clearInterval(countTimer); countTimer = null; countdownEl.remove(); }

  // ---- UI -----------------------------------------------------------------
  function el(tag, props = {}, ...kids) {
    const n = Object.assign(document.createElement(tag), props);
    n.append(...kids.filter(x => x != null && x !== false));
    return n;
  }
  const ago = t => {
    const d = (Date.now() - t) / 1000;
    return d < 3600 ? `${Math.max(1, Math.round(d / 60))} min ago` : d < 86400 ? `${Math.round(d / 3600)} h ago`
      : new Date(t).toLocaleDateString();
  };
  const clock = s => { s = Math.floor(s || 0); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
    return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(s % 60).padStart(2, "0")}`; };

  const style = el("style", { textContent: `
  #wt-btn{position:fixed;right:20px;bottom:20px;z-index:2147483646;width:46px;height:46px;border-radius:12px;border:0;display:grid;place-items:center;
    background:var(--m3-primary,#1e8bc3);color:var(--m3-on-primary,#fff);font:600 22px system-ui;cursor:pointer;box-shadow:0 6px 20px #0008}
  #wt-panel,#wt-next{font:14px/1.4 system-ui,sans-serif;color:#eef}
  #wt-panel{position:fixed;inset:4vh 4vw;z-index:2147483647;display:flex;flex-direction:column;background:#17171bf5;
    border-radius:20px;box-shadow:0 20px 80px #000c;overflow:hidden}
  #wt-panel header{display:flex;gap:10px;align-items:center;padding:16px 22px;border-bottom:1px solid #fff2}
  #wt-panel h2{margin:0 8px 0 0;font-size:20px}
  #wt-panel .wt-tabs{display:flex;gap:4px;flex:1}
  #wt-panel button,#wt-next button,#wt-panel input,#wt-panel select{background:#fff1;border:1px solid #fff3;border-radius:10px;
    color:inherit;padding:7px 12px;cursor:pointer;font:inherit}
  #wt-panel button:hover,#wt-next button:hover{background:#fff2}
  #wt-panel button.on{background:var(--m3-primary,#1e8bc3);border-color:var(--m3-primary,#1e8bc3);color:var(--m3-on-primary,#fff)}
  #wt-body{overflow:auto;padding:18px 22px}
  .wt-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:16px}
  .wt-card{display:flex;gap:14px;background:#ffffff0d;border-radius:14px;padding:12px}
  .wt-card img{width:96px;height:144px;object-fit:cover;border-radius:10px;flex:none;background:#fff1}
  .wt-card.wide img{width:160px;height:90px}
  .wt-b{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px}
  .wt-b h3{margin:0;font-size:16px;overflow:hidden;text-overflow:ellipsis}
  .wt-meta{opacity:.7;font-size:12px}
  .wt-bar{height:5px;border-radius:3px;background:#fff2;overflow:hidden}.wt-bar i{display:block;height:100%;background:var(--m3-primary,#1e8bc3)}
  .wt-season{display:flex;flex-wrap:wrap;gap:4px;align-items:center}.wt-season b{font-size:11px;opacity:.7;width:26px}
  .wt-ep{width:28px;height:24px;border-radius:6px!important;padding:0!important;font-size:11px!important;background:#fff1}
  .wt-ep[data-state=watched]{background:var(--m3-primary,#1e8bc3)!important;color:var(--m3-on-primary,#fff)}.wt-ep[data-state=started]{background:#a07010!important}
  .wt-ep.last{outline:2px solid #fff}
  .wt-act{margin-top:auto;display:flex;gap:6px;flex-wrap:wrap}
  .wt-empty{opacity:.6;padding:40px;text-align:center}
  .wt-set{display:grid;grid-template-columns:260px 1fr;gap:14px 20px;max-width:760px;align-items:center}
  .wt-set label{opacity:.85}.wt-set input[type=number]{width:90px}
  .wt-sites{display:flex;flex-wrap:wrap;gap:6px}
  #wt-btn[data-sleep]:not([data-sleep=""])::after{content:attr(data-sleep);position:absolute;top:-6px;right:-6px;min-width:22px;height:22px;
    padding:0 6px;border-radius:11px;background:var(--m3-tertiary,#d8bbf2);color:var(--m3-surface,#15121a);font:700 11px/22px system-ui;text-align:center}
  .wt-elsewhere{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0 0 14px;opacity:.9}
  .wt-elsewhere a{padding:5px 12px;border-radius:8px;border:1px solid #fff3;color:inherit;text-decoration:none}
  .wt-elsewhere a:hover{background:#fff1}
  .wt-sleep{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:10px 22px;border-bottom:1px solid #fff2}
  .wt-sleep-t{font-weight:600;margin-right:8px}
  .wt-sleep button{padding:5px 12px!important;border-radius:999px!important}
  .wt-sleep button.on{background:var(--m3-primary,#1e8bc3)!important;color:var(--m3-on-primary,#fff)!important}
  #wt-next{position:fixed;right:24px;bottom:90px;z-index:2147483647;background:#17171bf5;border-radius:16px;padding:14px 16px;
    display:flex;gap:10px;align-items:center;box-shadow:0 10px 40px #000c}
  .wt-next-t{font-weight:600;margin-right:6px}
  .wt-card.link{cursor:pointer}.wt-card.link:hover{background:#ffffff1a}
  .wt-chips{display:flex;gap:6px;flex-wrap:wrap}.wt-chips button{padding:2px 9px!important;font-size:12px!important;border-radius:999px!important}
  a.wt-watched{opacity:.5}a.wt-watched::after{content:" ✓";color:var(--m3-primary,#1e8bc3);font-weight:700}
  #wt-toast{position:fixed;left:24px;bottom:24px;z-index:2147483647;background:#17171bf5;color:#eef;border-radius:12px;padding:10px 14px;
    font:14px/1.4 system-ui,sans-serif;box-shadow:0 10px 40px #000c}
  ` });
  document.head.append(style);

  const btn = el("button", { id: "wt-btn", title: "Watched (Alt+W)", onclick: () => toggle() });
  // A drawn icon (a play mark in a list), not a text glyph.
  {
    const ns = "http://www.w3.org/2000/svg", svg = document.createElementNS(ns, "svg"), path = document.createElementNS(ns, "path");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("width", "22"); svg.setAttribute("height", "22");
    path.setAttribute("d", "M4 6h10M4 12h7M4 18h7M15 11v8l6-4z");
    path.setAttribute("fill", "none"); path.setAttribute("stroke", "currentColor"); path.setAttribute("stroke-width", "2");
    path.setAttribute("stroke-linecap", "round"); path.setAttribute("stroke-linejoin", "round");
    svg.append(path); btn.append(svg);
  }
  // Sleep: a badge on the button, and a row in the panel.
  const sleepRow = el("div", { className: "wt-sleep" });
  function drawSleep() {
    const sl = getSleep();
    const left = sl?.mode === "time" ? Math.max(0, Math.ceil((sl.at - Date.now()) / 60000)) : null;
    btn.dataset.sleep = sl ? (sl.mode === "episode" ? "ep" : `${left}′`) : "";
    const pick = v => {
      if (v === "off") setSleep(null);
      else if (v === "ep") setSleep({ mode: "episode" });
      else setSleep({ mode: "time", at: Date.now() + v * 60000 });
    };
    sleepRow.replaceChildren(
      el("span", { className: "wt-sleep-t", textContent: sl ? (sl.mode === "episode" ? "☾ Stops after this episode" : `☾ Pauses in ${left} min`) : "☾ Sleep timer" }),
      ...[[15, "15"], [30, "30"], [45, "45"], [60, "60"], [90, "90"], ["ep", "After this episode"], ["off", "Off"]].map(([v, t]) =>
        el("button", { textContent: typeof v === "number" ? `${t} min` : t,
          className: (sl && ((v === "ep" && sl.mode === "episode"))) ? "on" : "", onclick: () => pick(v) })));
  }
  setInterval(drawSleep, 15000);
  drawSleep();
  // the button only on movie sites; YouTube is tracked quietly
  if (tracked && settings().button && !onSite("youtube.com")) document.body.append(btn);
  const panel = el("div", { id: "wt-panel" });
  let tab = "history", query = "", siteFilter = "all";

  function toggle(on = !panel.isConnected) {
    if (on) { document.body.append(panel); render(); toggleFocus(); } else panel.remove();
  }
  document.addEventListener("keydown", ev => {
    if (tracked && ev.altKey && !ev.ctrlKey && ev.key.toLowerCase() === "w") { ev.preventDefault(); toggle(); }
    else if (ev.key === "Escape" && panel.isConnected) toggle(false);
  }, true);
  GM_registerMenuCommand("Open watched list", () => toggle(true));
  // #wt-search=<title>: SearchJumper's "Watched" engine lands here.
  const openFromHash = () => {
    const m = location.hash.match(/^#wt-search=(.*)$/);
    if (!m) return;
    query = decodeURIComponent(m[1]);
    tab = "history";
    window.history.replaceState(null, "", location.pathname + location.search);
    toggle(true);
  };
  // After the whole script has run: the list view uses constants defined further down.
  setTimeout(openFromHash, 0);
  window.addEventListener("hashchange", openFromHash);

  function toggleFocus() { panel.querySelector("input[type=search]")?.focus(); }
  function render() {
    const typing = document.activeElement?.type === "search";
    const scroll = panel.querySelector("#wt-body")?.scrollTop || 0;
    panel.replaceChildren(
      el("header", {},
        el("h2", { textContent: "Watched" }),
        el("div", { className: "wt-tabs" },
          el("button", { textContent: "History", className: tab === "history" ? "on" : "", onclick: () => { tab = "history"; render(); } }),
          el("button", { textContent: "Next up", className: tab === "next" ? "on" : "", onclick: () => { tab = "next"; render(); } }),
          el("button", { textContent: "Settings", className: tab === "settings" ? "on" : "", onclick: () => { tab = "settings"; render(); } })),
        tab === "history" && el("input", { type: "search", placeholder: "Search…", value: query, oninput: e => { query = e.target.value; render(); } }),
        tab === "history" && siteSelect(),
        el("button", { textContent: "✕", onclick: () => toggle(false) })),
      sleepRow,
      el("div", { id: "wt-body" }, tab === "history" ? history() : tab === "next" ? nextUp() : settingsView()));
    panel.querySelector("#wt-body").scrollTop = scroll;
    const s = panel.querySelector("input[type=search]");
    if (s && typing) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
  }

  function siteSelect() {
    const sites = [...new Set(Object.values(load()).map(t => t.site))].sort();
    const sel = el("select", { onchange: e => { siteFilter = e.target.value; render(); } },
      el("option", { value: "all", textContent: "All sites" }), ...sites.map(x => el("option", { value: x, textContent: x })));
    sel.value = siteFilter;
    return sel;
  }

  // Search elsewhere: the same query on the movie sites (SearchJumper's group, the other way round).
  const ELSEWHERE = [
    ["moflix", q => `https://moflix-stream.xyz/search/${encodeURIComponent(q)}`],
    ["megakino", q => `https://megakino25.com/index.php?do=search&subaction=search&story=${encodeURIComponent(q)}`],
    ["kinoger", q => `https://kinoger.com/index.php?do=search&subaction=search&story=${encodeURIComponent(q)}`],
    ["s.to", q => `https://s.to/search?q=${encodeURIComponent(q)}`],
    ["filmpalast", q => `https://filmpalast.to/search/title/${encodeURIComponent(q)}`],
    ["YouTube", q => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`],
  ];
  function elsewhere(q) {
    return el("div", { className: "wt-elsewhere" }, el("span", { textContent: `Search “${q}” on` }),
      ...ELSEWHERE.map(([n, u]) => el("a", { href: u(q), textContent: n })));
  }

  function history() {
    const h = load(), q = query.trim().toLowerCase();
    const items = Object.entries(h)
      .filter(([, t]) => (siteFilter === "all" || t.site === siteFilter) && (!q || `${t.name} ${t.sub || ""}`.toLowerCase().includes(q)))
      .sort((a, b) => (b[1].last?.at || 0) - (a[1].last?.at || 0));
    if (!items.length) return el("div", {}, el("div", { className: "wt-empty", textContent: q ? "Nothing in your history matches." : "Nothing watched yet." }),
      q ? elsewhere(query.trim()) : null);
    return el("div", {}, q ? elsewhere(query.trim()) : null,
      el("div", { className: "wt-grid" }, ...groups(items).map(g => card(g[0][0], g[0][1], g))));
  }

  // The same show on several sites is one entry: the newest copy, with a chip per site.
  const showKey = t => (t.name || "").toLowerCase().replace(/\b(staffel|season)\s*\d+\b/g, " ")
    .replace(/\((19|20)\d{2}\)|\b(19|20)\d{2}\b/g, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  // [[key, t], ...] in the order given -> one array per show, newest copy first
  function groups(entries) {
    const m = new Map();
    for (const [k, t] of entries) {
      const g = showKey(t) || k;
      if (!m.has(g)) m.set(g, []);
      m.get(g).push([k, t]);
    }
    return [...m.values()].map(g => g.sort((a, b) => (b[1].last?.at || 0) - (a[1].last?.at || 0)));
  }
  // old entries hold a bare path ("/watch/1"); new ones a whole address
  const whole = (site, url) => /^https?:/.test(url) ? url : `https://${site}${url}`;
  const goTo = (site, url) => { if (url) location.href = onSite(site) ? url : whole(site, url); };

  function card(key, t, group = [[key, t]]) {
    const eps = Object.entries(t.eps), last = t.eps[t.last?.k] || {};
    const watched = eps.filter(([, e]) => e.state === "watched").length;
    const sameSite = onSite(t.site);
    const open = (url, pos) => {
      const u = pos && t.site.includes("youtube") ? `${url}${url.includes("?") ? "&" : "?"}t=${Math.floor(pos)}s` : url;
      location.href = sameSite ? u : whole(t.site, u);
    };
    const b = el("div", { className: "wt-b" },
      el("h3", { textContent: t.name, title: t.name }),
      el("div", { className: "wt-meta", textContent: [
        t.sub, t.site,
        t.series ? `last S${t.last.k.split(":")[0]}E${t.last.k.split(":")[1]} · ${watched}/${eps.length} watched` :
          last.state === "watched" ? "watched" : last.pos ? `at ${clock(last.pos)} of ${clock(last.dur)}` : "started",
        ago(t.last?.at)].filter(Boolean).join(" · ") }));
    if (!t.series && last.pct != null) b.append(el("div", { className: "wt-bar" }, el("i", { style: `width:${last.pct}%` })));
    if (t.series) {
      const seasons = {};
      for (const [k, e] of eps) { const [s, n] = k.split(":").map(Number); (seasons[s] ||= []).push([n, k, e]); }
      for (const s of Object.keys(seasons).sort((a, c) => a - c)) {
        b.append(el("div", { className: "wt-season" }, el("b", { textContent: `S${s}` }),
          ...seasons[s].sort((x, y) => x[0] - y[0]).map(([n, k, e]) => {
            const x = el("button", { className: "wt-ep" + (k === t.last.k ? " last" : ""), textContent: n,
              title: `${e.name || `Episode ${n}`} · ${e.state}${e.pct != null ? ` · ${e.pct}%` : ""}\nclick: open · right-click: watched on/off`,
              onclick: () => open(e.url, e.state === "watched" ? 0 : e.pos),
              oncontextmenu: ev => { ev.preventDefault(); flip(key, k); } });
            x.dataset.state = e.state;
            return x;
          })));
      }
    }
    if (group.length > 1) b.append(el("div", { className: "wt-chips" }, ...group.map(([, x]) => el("button", {
      textContent: x.site, title: `Continue on ${x.site}`, className: x.site === t.site ? "on" : "",
      onclick: () => goTo(x.site, x.last?.url) }))));
    b.append(el("div", { className: "wt-act" },
      el("button", { textContent: last.state === "watched" ? "▶ Again" : "▶ Continue",
        onclick: () => open(t.last.url, last.state === "watched" ? 0 : last.pos) }),
      !t.series && el("button", { textContent: last.state === "watched" ? "Mark unwatched" : "Mark watched", onclick: () => flip(key, t.last.k) }),
      el("button", { textContent: "Remove", onclick: () => {
        if (confirm(`Remove "${t.name}"?`)) { const h = load(); delete h[key]; save(h); render(); } } })));
    return el("div", { className: "wt-card" + (t.site.includes("youtube") ? " wide" : "") },
      el("img", { src: t.poster || "", loading: "lazy", alt: "" }), b);
  }

  // One row per series with a watched episode: the one after the furthest watched, from any copy of the show.
  function nextUp() {
    const rows = groups(Object.entries(load()).filter(([, t]) => t.series)).map(g => {
      const done = g.flatMap(([, x]) => Object.entries(x.eps || {}))
        .filter(([k, e]) => k.includes(":") && e.state === "watched")
        .map(([k]) => k.split(":").map(Number)).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
      if (!done.length) return null;
      const [s, e] = done[0], k = `${s}:${e + 1}`;
      const [, src] = g.find(([, x]) => x.eps?.[k]?.url) ?? [null, g[0][1]];
      return { t: g[0][1], s, e: e + 1, site: src.site, url: src.eps?.[k]?.url || g[0][1].last?.url };
    }).filter(Boolean).sort((a, b) => (b.t.last?.at || 0) - (a.t.last?.at || 0));
    if (!rows.length) return el("div", { className: "wt-empty", textContent: "No series watched yet." });
    return el("div", { className: "wt-grid" }, ...rows.map(({ t, s, e, site, url }) => el("div", {
      className: "wt-card link", onclick: () => goTo(site, url) },
      el("img", { src: t.poster || "", loading: "lazy", alt: "" }),
      el("div", { className: "wt-b" },
        el("h3", { textContent: t.name, title: t.name }),
        el("div", { className: "wt-meta", textContent: [t.sub || t.site, `Next S${s}E${e}`, t.last?.at && ago(t.last.at)]
          .filter(Boolean).join(" · ") })))));
  }

  function flip(key, k) {
    const h = load(), e = h[key]?.eps?.[k];
    if (!e) return;
    e.state = e.state === "watched" ? "started" : "watched";
    e.at = Date.now();
    save(h); render();
  }

  function settingsView() {
    const s = settings();
    const set = (k, v) => { const x = settings(); x[k] = v; saveSettings(x); if (k === "button") v ? document.body.append(btn) : btn.remove(); };
    const num = (k, min, max) => el("input", { type: "number", min, max, value: s[k], onchange: e => set(k, Math.min(max, Math.max(min, Number(e.target.value) || 0))) });
    const chk = k => el("input", { type: "checkbox", checked: s[k], onchange: e => set(k, e.target.checked) });
    const sites = el("div", { className: "wt-sites" },
      ...s.sites.map(x => el("button", { textContent: `${x} ✕`, title: "Stop tracking this site",
        onclick: () => { const y = settings(); y.sites = y.sites.filter(z => z !== x); saveSettings(y); render(); } })),
      !s.sites.includes(host) && el("button", { textContent: `+ ${host}`, onclick: () => { const y = settings(); y.sites.push(host); saveSettings(y); render(); } }));
    return el("div", { className: "wt-set" },
      el("label", { textContent: "Autoplay the next episode" }), chk("autoplay"),
      el("label", { textContent: "Countdown before it opens (s)" }), num("countdown", 0, 60),
      el("label", { textContent: "Skip credits: start this many s before the end" }), num("creditsSec", 0, 600),
      el("label", { textContent: "Counts as watched from (%)" }), num("watchedPct", 50, 100),
      el("label", { textContent: "No player time? Use the episode runtime" }), chk("fallbackMin"),
      el("label", { textContent: "Round button bottom right (Alt+W always works)" }), chk("button"),
      el("label", { textContent: "Toast when a page is tracked" }), chk("toast"),
      el("label", { textContent: "Sites (other sites: MonkeyStyles menu → Track videos on …)" }), sites,
      el("label", { textContent: "Backup" }), el("div", { className: "wt-act" },
        el("button", { textContent: "Export", onclick: exportJson }), el("button", { textContent: "Import", onclick: importJson })));
  }

  function exportJson() {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ history: load(), settings: settings() })], { type: "application/json" }));
    el("a", { href: url, download: "watch-tracker.json" }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function importJson() {
    const f = el("input", { type: "file", accept: "application/json" });
    f.onchange = async () => {
      try {
        const add = JSON.parse(await f.files[0].text());
        save(mergeHistory(load(), add.history || {}, true)); render();
      } catch (e) { alert("Import failed: " + e.message); }
    };
    f.click();
  }
})();
