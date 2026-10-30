// ==UserScript==
// @name         media-ytm
// @namespace    tela
// @version      1.2.1
// @description  YouTube Music adapter for the media bridge (127.0.0.1:8788): play/pause/next/open, lyrics, Song/Video - from the desktop, tab in the background.
// @match        https://music.youtube.com/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      music.youtube.com
// @run-at       document-idle
// @noframes
// @downloadURL  http://127.0.0.1:8788/media-ytm.user.js
// @updateURL    http://127.0.0.1:8788/media-ytm.user.js
// ==/UserScript==

(() => {
  "use strict";
  const BASE = "http://127.0.0.1:8788";
  const page = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;

  // GM_xmlhttpRequest: YTM's CSP would block a plain fetch to loopback.
  function http(method, path, body, timeout = 30000) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method, url: BASE + path, timeout,
        headers: { "Content-Type": "application/json" },
        data: body ? JSON.stringify(body) : undefined,
        onload: r => { try { resolve(JSON.parse(r.responseText)); } catch (e) { reject(e); } },
        onerror: reject, ontimeout: reject,
      });
    });
  }

  const $ = s => document.querySelector(s);
  const unwrap = el => el && (el.wrappedJSObject || el);
  const player = () => unwrap(document.getElementById("movie_player"));
  const playing = () => player()?.getPlayerState?.() === 1;

  function navigate(path) {
    const u = new URL(path, location.origin);
    const v = u.searchParams.get("v"), list = u.searchParams.get("list");
    const endpoint = v
      ? { watchEndpoint: { videoId: v, ...(list ? { playlistId: list } : {}) } }
      : list ? { browseEndpoint: { browseId: "VL" + list } } : null;
    const app = unwrap($("ytmusic-app"));
    if (endpoint && app) {
      // The SPA's own navigation keeps the queue and works in a background
      // tab; a reload would wait for the tab to be foregrounded to play.
      const detail = typeof cloneInto === "function" ? cloneInto({ endpoint }, page) : { endpoint };
      app.dispatchEvent(new page.CustomEvent("yt-navigate", { bubbles: true, composed: true, detail }));
      if (v) setTimeout(() => {
        const p = player();
        if (p?.getVideoData?.().video_id !== v) p?.loadVideoById?.(v);
      }, 2500);
      return;
    }
    location.assign(u.href);
  }

  // YT Music's own Song / Video switch: only shown for tracks that have a video.
  function avToggle() {
    const t = $("ytmusic-av-toggle");
    return t && !t.hidden && t.offsetParent !== null ? t : null;
  }
  function mode() {
    const t = avToggle();
    if (!t) return null;
    const v = t.querySelector(".video-button");
    const on = v && (v.getAttribute("aria-pressed") === "true" || v.classList.contains("selected") ||
                     v.hasAttribute("active"));
    return on || t.getAttribute("playback-mode") === "OMV_PREFERRED" ? "video" : "song";
  }
  function setMode(want) {
    const t = avToggle();
    if (!t || (want !== "song" && want !== "video") || mode() === want) return;
    t.querySelector(want === "video" ? ".video-button" : ".song-button")?.click();
  }

  function run({ cmd, arg }) {
    const p = player();
    switch (cmd) {
      case "toggle": playing() ? p?.pauseVideo() : p?.playVideo(); break;
      case "play": p?.playVideo(); break;
      case "pause": p?.pauseVideo(); break;
      case "next": $("ytmusic-player-bar .next-button")?.click() ?? p?.nextVideo?.(); break;
      case "prev": $("ytmusic-player-bar .previous-button")?.click() ?? p?.previousVideo?.(); break;
      case "volume": p?.setVolume?.(arg); break;
      case "open": navigate(arg); break;
      case "mode": setMode(arg); break;
      case "seek": {
        // Seconds; the player's own seekTo moves YT Music's bar too. Playing stays playing.
        const t = Math.max(0, Number(arg) || 0);
        p?.seekTo?.(t, true);
        break;
      }
    }
    // Report at once (the dock refetches right after the command), then once the
    // player has settled - play/pause and track changes take a moment.
    last = "";
    report();
    setTimeout(() => { last = ""; report(); }, 350);
    setTimeout(report, 1200);
  }

  // Lyrics from YTM's own InnerTube API: next -> lyrics browseId -> browse.
  // ANDROID_MUSIC carries cue times when signed in; WEB_REMIX the plain text.
  const lyricsCache = new Map();
  let lyricsError = null;
  function find(o, key) {
    if (!o || typeof o !== "object") return undefined;
    if (key in o) return o[key];
    for (const v of Object.values(o)) { const r = find(v, key); if (r !== undefined) return r; }
  }
  async function authHeader() {
    const sid = document.cookie.match(/(?:^|; )(?:__Secure-3PAPISID|SAPISID)=([^;]+)/)?.[1];
    if (!sid) return {};
    const ts = Math.floor(Date.now() / 1000), origin = location.origin;
    const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(`${ts} ${sid} ${origin}`));
    const hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
    return { Authorization: `SAPISIDHASH ${ts}_${hex}`, "X-Origin": origin };
  }
  function post(endpoint, context, body, headers, anonymous) {
    return new Promise((resolve, reject) => GM_xmlhttpRequest({
      method: "POST", url: `${location.origin}/youtubei/v1/${endpoint}?prettyPrint=false`,
      headers, anonymous, data: JSON.stringify({ context, ...body }), timeout: 15000,
      onload: r => {
        try { resolve(JSON.parse(r.responseText)); }
        catch { reject(new Error(`${endpoint} ${r.status}: ${String(r.responseText).slice(0, 80)}`)); }
      },
      onerror: () => reject(new Error(`${endpoint}: network error`)),
      ontimeout: () => reject(new Error(`${endpoint}: timeout`)),
    }));
  }
  async function innertube(endpoint, client, body) {
    // A fixed client: the page's ytcfg is unreliable to read across the sandbox.
    const hl = document.documentElement.lang || "en";
    const context = { client: { clientName: "WEB_REMIX", clientVersion: "1.20241023.01.00", hl, ...client } };
    const json = { "Content-Type": "application/json" };
    try {
      return await post(endpoint, context, body, { ...json, ...(await authHeader()) }, false);
    } catch (e) {
      // Signed-in request refused: anonymous still gets plain lyrics.
      try { return await post(endpoint, context, body, json, true); }
      catch (e2) { throw new Error(`${e.message} | anon: ${e2.message}`); }
    }
  }
  async function fetchLyrics(videoId) {
    const next = await innertube("next", null, { videoId });
    const browseId = JSON.stringify(next).match(/"browseId":"(MPLY[^"]+)"/)?.[1];
    if (!browseId) return null;
    try {
      const a = await innertube("browse", { clientName: "ANDROID_MUSIC", clientVersion: "7.27.52" }, { browseId });
      const timed = find(a, "timedLyricsData");
      if (Array.isArray(timed) && timed.length && timed[0].cueRange?.startTimeMilliseconds != null)
        return timed.map(e => ({ t: Number(e.cueRange.startTimeMilliseconds) / 1000, line: e.lyricLine || "" }));
    } catch {}
    const b = await innertube("browse", null, { browseId });
    return find(b, "musicDescriptionShelfRenderer")?.description?.runs?.map(r => r.text).join("") || null;
  }
  function lyricsFor(videoId) {
    if (!videoId) return null;
    if (!lyricsCache.has(videoId)) {
      lyricsCache.set(videoId, undefined); // in flight
      fetchLyrics(videoId).then(l => { lyricsError = null; lyricsCache.set(videoId, l); },
        e => { lyricsError = String(e?.message || e?.statusText || e); lyricsCache.set(videoId, null); })
        .then(report);
    }
    return lyricsCache.get(videoId) ?? null;
  }

  function snapshot() {
    const p = player(), d = p?.getVideoData?.() || {};
    const md = navigator.mediaSession?.metadata;
    const art = md?.artwork?.length ? md.artwork[md.artwork.length - 1].src : null;
    return {
      playing: playing(),
      videoId: d.video_id || null,
      title: md?.title || d.title || $("ytmusic-player-bar .title")?.textContent?.trim() || null,
      artist: md?.artist || d.author || null,
      album: md?.album || null,
      artUrl: art,
      position: p?.getCurrentTime?.() ?? null,
      duration: p?.getDuration?.() ?? null,
      volume: p?.getVolume?.() ?? null,
      lyrics: lyricsFor(d.video_id),
      hasVideo: !!avToggle(),
      mode: mode(),
      lyricsError,
      script: typeof GM_info !== "undefined" ? GM_info.script.version : null,
      url: d.video_id ? `https://music.youtube.com/watch?v=${d.video_id}` : location.href,
    };
  }

  let last = "", lastSent = 0, lastPos = null, lastPlaying = false;
  function report() {
    const s = snapshot();
    const key = JSON.stringify({ ...s, position: null });
    // Readers move the position on from the last report, so a seek, skip or
    // stall must be reported at once or synced lyrics sit on the wrong line.
    const expected = lastPos == null ? null : lastPos + (lastPlaying ? (Date.now() - lastSent) / 1000 : 0);
    const drift = expected != null && s.position != null && Math.abs(s.position - expected) > 1;
    if (key === last && !drift && Date.now() - lastSent < 15000) return;
    last = key; lastSent = Date.now(); lastPos = s.position; lastPlaying = s.playing;
    http("POST", "/state", s, 5000).catch(() => {});
  }

  async function loop() {
    let after = -1;
    for (;;) {
      try {
        const r = await http("GET", `/poll?after=${after}`);
        after = r.after;
        r.commands.forEach(c => { try { run(c); } catch (e) { console.error("media-ytm", e); } });
      } catch {
        after = -1;
        await new Promise(r => setTimeout(r, 5000)); // bridge down; retry quietly
      }
    }
  }

  setInterval(report, 500);
  report();
  loop();
})();
