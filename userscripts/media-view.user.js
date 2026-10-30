// ==UserScript==
// @name         media-view
// @namespace    tela
// @version      1.6.2
// @var          checkbox autoOpen "Open by itself when a video plays" 0
// @var          checkbox button "Show the Media view button" 1
// @var          checkbox recsOpen "Recommendations open" 0
// @var          checkbox wave "Wavy timeline" 1
// @var          checkbox anywhere "Also on pages watch-tracker does not track (a hoster opened directly)" 1
// @var          select   skip "Skip step (s)" 5|10*|15|30
// @description  A custom player view over any site's video, in the desktop's style: wavy timeline, controls, the site's own recommendations below. Pairs with watch-tracker. Alt+M.
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @run-at       document-idle
// @downloadURL  http://127.0.0.1:8788/media-view.user.js
// @updateURL    http://127.0.0.1:8788/media-view.user.js
// ==/UserScript==

(() => {
  "use strict";
  const MV = "media-view", WT = "watch-tracker";

  const bigVideo = () => [...document.querySelectorAll("video")]
    .filter(v => v.duration > 30 || v.clientWidth > 300).sort((a, b) => b.clientWidth - a.clientWidth)[0] || null;

  // ---- inside a frame: report the player's state to the top page, and do what it asks.
  // Hosters embed their player cross-origin, so only a copy of this script inside can touch it.
  if (window.top !== window.self) {
    setInterval(() => {
      const v = bigVideo();
      if (!v || !(v.duration > 0)) return;
      const b = v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0;
      try {
        window.top.postMessage({ [MV + "-state"]: { pos: v.currentTime, dur: v.duration, paused: v.paused, buf: b,
          vol: v.volume, muted: v.muted, rate: v.playbackRate, w: v.videoWidth, h: v.videoHeight } }, "*");
      } catch {}
    }, 250);
    window.addEventListener("message", ev => {
      const c = ev.data?.[MV + "-cmd"];
      if (!c) return;
      const v = bigVideo();
      if (c.op === "where" && v) {
        const url = streamOf(v);
        if (url) try { window.top.postMessage({ [MV + "-src"]: { url, referer: location.href, pos: v.currentTime } }, "*"); } catch {}
      }
      if (v) act(v, c);
      for (const f of document.querySelectorAll("iframe")) try { f.contentWindow.postMessage(ev.data, "*"); } catch {}
    });
    return;
  }

  // the address this player really loaded: its own src when that is a web address, else (a
  // blob: from a streaming player) the last playlist or video file the page fetched
  function streamOf(v) {
    if (/^https?:/.test(v.currentSrc)) return v.currentSrc;
    const got = performance.getEntriesByType("resource").map(e => e.name)
      .filter(u => /\.(m3u8|mpd)(\?|$)|\.(mp4|webm|mkv)(\?|$)/i.test(u));
    return got.find(u => /master|index|playlist/i.test(u) && /\.m3u8/i.test(u)) || got.reverse().find(u => /\.(m3u8|mpd)/i.test(u)) || got[0] || "";
  }
  function act(v, c) {
    if (c.op === "toggle") (v.paused ? v.play() : v.pause())?.catch?.(() => {});
    if (c.op === "play") v.play().catch(() => {});
    if (c.op === "pause") v.pause();
    if (c.op === "seek") v.currentTime = Math.max(0, Math.min(v.duration || 0, c.v));
    if (c.op === "rel") v.currentTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + c.v));
    if (c.op === "volume") { v.volume = Math.max(0, Math.min(1, c.v)); v.muted = c.v === 0; }
    if (c.op === "mute") v.muted = !v.muted;
    if (c.op === "rate") v.playbackRate = c.v;
  }

  // ---- the top page ------------------------------------------------------------------------
  // settings: the @var lines above, edited in MonkeyStyles' popup, read here by name
  const DEF = { autoOpen: false, button: true, recsOpen: false, wave: true, skip: "10", anywhere: true };
  const old = (() => { try { return JSON.parse(GM_getValue("prefs", "{}")); } catch { return {}; } })();
  const prefs = () => Object.fromEntries(Object.keys(DEF).map(k => [k, GM_getValue(k, old[k] ?? DEF[k])]));
  const setPref = (k, v) => GM_setValue(k, v);
  GM_registerMenuCommand("Media view: open (Alt+M)", () => toggle(true));
  GM_registerMenuCommand("Queue this in reel", () => queueInReel());
  GM_registerMenuCommand("Open this video in reel", () => openInReel());
  // "Open in reel": ask the player (here or in its frame) for the address it loaded, then reel plays it
  // from the same moment with the page as referrer, and the browser's copy pauses
  let wantSrc = 0;
  function openInReel() {
    wantSrc = Date.now();
    const v = bigVideo();
    if (v && v.duration > 0) { const url = streamOf(v); if (url) return handOver({ url, referer: location.href, pos: v.currentTime }); }
    for (const f of document.querySelectorAll("iframe")) try { f.contentWindow.postMessage({ [MV + "-cmd"]: { op: "where" } }, "*"); } catch {}
    setTimeout(() => { if (wantSrc) { wantSrc = 0; note("No stream address found on this page"); } }, 2500);
  }
  window.addEventListener("message", ev => {
    const src = ev.data?.[MV + "-src"];
    if (src && wantSrc && Date.now() - wantSrc < 2500) { wantSrc = 0; handOver(src); }
  });
  function handOver(src) {
    GM_xmlhttpRequest({ method: "POST", url: "http://127.0.0.1:8788/reel/open", headers: { "Content-Type": "application/json" },
      data: JSON.stringify({ url: src.url, referer: src.referer, start: Math.floor(src.pos || 0) }),
      onload: r => { if (r.status === 200) { send("pause"); note("Opening in reel…"); if (ui) close(); } else note("reel could not take it"); },
      onerror: () => note("Media bridge not running") });
  }
  // into reel's queue (through the media bridge); the page itself, so reel finds its mirrors
  function queueInReel() {
    const ep = item?.series ? ` · S${String(item.s).padStart(2, "0")}E${String(item.e).padStart(2, "0")}` : "";
    GM_xmlhttpRequest({ method: "POST", url: "http://127.0.0.1:8788/reel/queue", headers: { "Content-Type": "application/json" },
      data: JSON.stringify({ url: location.href, title: (item?.name || document.title) + ep }),
      onload: r => { let j = {}; try { j = JSON.parse(r.responseText); } catch {} note(j.ok ? (/queued/.test(j.said) ? "Queued in reel" : "Playing in reel") : "reel did not answer"); },
      onerror: () => note("Media bridge not running") });
  }
  function note(text) {
    if (!shadow) return;
    const n = Object.assign(document.createElement("div"), { className: "note", textContent: text });
    shadow.append(n); setTimeout(() => n.remove(), 2200);
  }
  GM_registerMenuCommand("Media view: open by itself when a video plays", () => setPref("autoOpen", !prefs().autoOpen));

  // what is playing: the page's own <video>, else the frame that reports one
  let frameState = null, frameSrc = null, item = null;
  window.addEventListener("message", ev => {
    const st = ev.data?.[MV + "-state"];
    if (st) { frameState = { ...st, at: Date.now() }; frameSrc = ev.source; seen(); }
    const it = ev.source === window && ev.data?.[WT + "-item"];
    if (it) { item = it; if (ui) drawHead(); else if (frameState || bigVideo()) seen(); }
  });
  const ask = what => window.postMessage({ [WT + "-ask"]: what }, "*");
  const state = () => {
    const v = bigVideo();
    if (v && v.duration > 0) return { pos: v.currentTime, dur: v.duration, paused: v.paused, vol: v.volume, muted: v.muted, rate: v.playbackRate,
      buf: v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0, w: v.videoWidth, h: v.videoHeight };
    return frameState && Date.now() - frameState.at < 3000 ? frameState : null;
  };
  const send = (op, v) => {
    const pv = bigVideo();
    if (pv && pv.duration > 0) return act(pv, { op, v });
    for (const f of document.querySelectorAll("iframe")) try { f.contentWindow.postMessage({ [MV + "-cmd"]: { op, v } }, "*"); } catch {}
  };
  // the element that shows the picture: the <video>, or the frame that reports (nested: the biggest frame)
  function target() {
    const v = bigVideo();
    if (v && v.duration > 0) return v;
    const frames = [...document.querySelectorAll("iframe")];
    // the player usually sits frames deep (moflix: page > embed > hoster): climb from the window
    // that reported to the one that is a frame of this page
    let w = frameSrc;
    try { for (let i = 0; w && w.parent !== window && i < 6; i++) w = w.parent; } catch { w = null; }
    return frames.find(f => f.contentWindow === w)
      || frames.filter(f => f.clientWidth > 200).sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0] || null;
  }

  // ---- recommendations: the site's own poster links, the biggest group of them on the page,
  // preferring one under a heading like "similar" / "ähnliche" / "empfohlen"
  const recWord = /ähnlich|empfehl|empfohlen|similar|recommend|related|auch interessant|mehr wie|you may|könnte dir/i;
  function recommendations() {
    const here = location.href.split("#")[0];
    const links = [...document.querySelectorAll("a[href]")].filter(a => {
      if (a.closest("header,nav,footer,#mv-root")) return false;
      const img = a.querySelector("img");
      if (!img) return false;
      const w = img.naturalWidth || img.clientWidth;
      if (w && w < 60) return false;
      try { const u = new URL(a.href); return u.origin === location.origin && u.href.split("#")[0] !== here; } catch { return false; }
    });
    const groups = new Map();
    for (const a of links) {
      let box = a.parentElement;
      for (let i = 0; i < 5 && box; i++, box = box.parentElement) if (box.querySelectorAll("a img").length >= 3) break;
      if (!box) continue;
      if (!groups.has(box)) groups.set(box, []);
      groups.get(box).push(a);
    }
    const score = ([box, as]) => {
      let label = "";
      for (let n = box, i = 0; n && i < 3; n = n.parentElement, i++) {
        const h = n.querySelector?.("h1,h2,h3,h4,.title,[class*=head]");
        if (h && recWord.test(h.textContent)) { label = h.textContent.trim(); break; }
        if (n.previousElementSibling && recWord.test(n.previousElementSibling.textContent || "")) { label = n.previousElementSibling.textContent.trim(); break; }
      }
      return { box, as, label, s: as.length + (label ? 100 : 0) };
    };
    const best = [...groups].map(score).sort((a, b) => b.s - a.s)[0];
    if (!best) return { label: "", items: [] };
    const seen = new Set(), items = [];
    for (const a of best.as) {
      if (seen.has(a.href)) continue;
      seen.add(a.href);
      const img = a.querySelector("img");
      const poster = img.dataset.src || img.dataset.original || img.dataset.lazySrc || img.currentSrc || img.src;
      const name = (img.alt || a.title || a.textContent || "").replace(/\s+/g, " ").trim();
      if (name) items.push({ href: a.href, poster, name });
    }
    return { label: best.label.replace(/\s+/g, " ").slice(0, 60), items: items.slice(0, 30) };
  }

  // ---- the view -------------------------------------------------------------------------------
  const ICON = {
    play: "M8 5v14l11-7z", pause: "M6 5h4v14H6zm8 0h4v14h-4z", back: "M11 18V6l-8.5 6zm.5-6 8.5 6V6z",
    fwd: "M4 18l8.5-6L4 6zm9-12v12l8.5-6z", next: "M6 18l8.5-6L6 6zm10-12v12h2V6z",
    vol: "M3 9v6h4l5 5V4L7 9zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z",
    mute: "M16.5 12A4.5 4.5 0 0 0 14 8v2.2l2.5 2.5zM19 12a7 7 0 0 1-.6 2.8l1.5 1.5A9 9 0 0 0 14 3.2v2.1A7 7 0 0 1 19 12zM4.3 3 3 4.3 7.7 9H3v6h4l5 5v-6.7l4.3 4.3a7 7 0 0 1-2.3 1.2v2.1a9 9 0 0 0 3.7-1.8l2 2 1.3-1.3zM12 4 9.9 6.1 12 8.2z",
    full: "M7 14H5v5h5v-2H7zm-2-4h2V7h3V5H5zm12 7h-3v2h5v-5h-2zM14 5v2h3v3h2V5z",
    close: "M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z",
    recs: "M4 6h16v2H4zm0 5h16v2H4zm0 5h10v2H4z",
    more: "M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm0 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
  };
  const svg = d => `<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="${d}"/></svg>`;
  const clock = s => { s = Math.max(0, Math.floor(s || 0)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
    return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(s % 60).padStart(2, "0")}`; };

  const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .root { position: fixed; inset: 0; background: #141218; color: #E6E0E9; font: 14px/1.35 "Inter", "Google Sans", system-ui, sans-serif;
    display: grid; grid-template-rows: 64px 1fr auto auto; pointer-events: none; }
  .root > * { pointer-events: auto; }
  .head { display: flex; align-items: center; gap: 14px; padding: 0 20px; }
  .poster { width: 36px; height: 52px; border-radius: 8px; object-fit: cover; background: #2B2930; }
  .titles { flex: 1; min-width: 0; }
  .t1 { font-size: 18px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .t2 { font-size: 12.5px; color: #CAC4D0; }
  .stage { pointer-events: none; }   /* the site's player sits here, under nothing of ours */
  .bar { margin: 8px 20px 0; padding: 10px 16px 12px; border-radius: 28px; background: #211F26; }
  .tl { position: relative; height: 28px; cursor: pointer; }
  .tl canvas { width: 100%; height: 28px; display: block; }
  .tip { position: absolute; bottom: 30px; transform: translateX(-50%); padding: 3px 9px; border-radius: 12px; background: #49454F;
    font-size: 12px; font-variant-numeric: tabular-nums; display: none; white-space: nowrap; }
  .tl:hover .tip { display: block; }
  .row { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
  .btn { width: 40px; height: 40px; border: 0; border-radius: 20px; background: transparent; color: #E6E0E9; display: grid; place-items: center;
    cursor: pointer; transition: background .15s, transform .12s; }
  .btn:hover { background: #36343B; }
  .btn:active { transform: scale(.92); }
  .btn.main { width: 52px; height: 52px; border-radius: 18px; background: #D0BCFF; color: #381E72; }
  .btn.main:hover { background: #DCCBFF; }
  .btn[disabled] { opacity: .35; pointer-events: none; }
  .time { font-variant-numeric: tabular-nums; color: #CAC4D0; font-size: 13px; margin: 0 8px; }
  .grow { flex: 1; }
  .chip { height: 32px; padding: 0 12px; border: 0; border-radius: 16px; background: #2B2930; color: #E6E0E9; font: 600 12.5px inherit; cursor: pointer; }
  .chip:hover { background: #36343B; }
  .vol { width: 90px; accent-color: #D0BCFF; }
  .sheet { margin: 6px 20px 0; border-radius: 24px 24px 0 0; background: #1D1B20; overflow: hidden; }
  .grab { height: 26px; display: grid; place-items: center; cursor: grab; touch-action: none; }
  .grab:active { cursor: grabbing; }
  .grab i { width: 36px; height: 4px; border-radius: 2px; background: #938F99; transition: width .15s, background .15s; }
  .grab:hover i { width: 48px; background: #CAC4D0; }
  .recs { height: 0; padding: 0 16px; transition: height .28s cubic-bezier(.2,.8,.2,1); overflow: hidden; }
  .sheet.open .recs { height: var(--h, 236px); }
  .sheet.dragging .recs { transition: none; }
  .rh { font-size: 13px; font-weight: 600; color: #CAC4D0; margin: 0 0 8px 4px; }
  .rail { display: flex; gap: 10px; overflow-x: auto; padding-bottom: 6px; scrollbar-width: thin; scrollbar-color: #49454F transparent; }
  .card { flex: 0 0 auto; width: 112px; text-decoration: none; color: #E6E0E9; border-radius: 14px; padding: 4px; transition: background .15s, transform .15s; }
  .card:hover { background: #2B2930; transform: translateY(-2px); }
  .card img { width: 104px; height: 152px; object-fit: cover; border-radius: 10px; background: #2B2930; display: block; }
  .card span { display: block; font-size: 12px; margin-top: 5px; line-height: 1.25; max-height: 2.5em; overflow: hidden; }
  .empty { color: #938F99; font-size: 12.5px; margin-left: 4px; }
  .note { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); z-index: 2147483647; padding: 10px 18px; border-radius: 20px;
    background: #2B2930; color: #E6E0E9; font: 500 13.5px "Inter", system-ui, sans-serif; box-shadow: 0 6px 20px #0007; }
  .head { position: relative; }
  .menu { position: fixed; pointer-events: auto; min-width: 210px; padding: 6px; border-radius: 16px;
    background: #2B2930; box-shadow: 0 8px 24px #0008; display: grid; gap: 2px; }
  .menu[hidden] { display: none; }
  .menu button { display: flex; align-items: center; gap: 10px; height: 38px; padding: 0 12px; border: 0; border-radius: 10px;
    background: transparent; color: #E6E0E9; font: 500 13.5px inherit; cursor: pointer; text-align: left; }
  .menu button:hover { background: #36343B; }
  .menu svg { width: 18px; height: 18px; }
  .pill { position: fixed; left: 16px; bottom: 16px; z-index: 2147483646; height: 40px; padding: 0 16px 0 12px; border: 0; border-radius: 20px;
    background: #D0BCFF; color: #381E72; font: 600 13.5px "Inter", system-ui, sans-serif; display: flex; align-items: center; gap: 6px;
    cursor: pointer; box-shadow: 0 6px 20px #0007; transition: transform .15s; }
  .pill { opacity: 0; transform: translateY(12px); transition: opacity .25s, transform .25s, max-width .4s cubic-bezier(.2,.8,.2,1);
    max-width: 160px; overflow: hidden; white-space: nowrap; }
  .pill.in { opacity: 1; transform: none; }
  .pill.wide { max-width: 420px; }
  .pill.in:hover { transform: translateY(-2px); }
  .pill .tr { font-weight: 500; opacity: .75; margin-right: 2px; }
  .pill b { overflow: hidden; text-overflow: ellipsis; }
  `;

  let host = null, shadow = null, ui = null, pill = null, saved = null, raf = 0, stageObs = null;

  // only where watch-tracker tracks (it answers "item"): not on every page that has a video
  // a page watch-tracker does not track (a hoster opened on its own): after a few seconds of a real
  // video and no answer, the page's own title stands in, so the view works there too
  let firstSeen = 0;
  function seen() {
    if (pill || ui || !document.body) return;
    if (!item) {
      ask("item");
      const st = state();
      firstSeen ||= Date.now();
      if (!prefs().anywhere || !st || !(st.dur > 60) || Date.now() - firstSeen < 3000) return;
      const name = (document.querySelector('meta[property="og:title"]')?.content || document.title || location.hostname)
        .replace(/\s*[-|–]\s*[^-|–]*$/, "").trim() || location.hostname;
      item = { name, sub: location.hostname.replace(/^www\./, ""), series: false, next: null, fallback: true };
    }
    host = document.createElement("div");
    host.id = "mv-root";
    host.style.cssText = "all:initial";
    document.documentElement.append(host);
    shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>${CSS}</style>`;
    pill = Object.assign(document.createElement("button"), { className: "pill", title: "Media view (Alt+M)" });
    pill.onclick = () => toggle(true);
    shadow.append(pill);
    // first it says what is tracked (watch-tracker's toast, which then stays quiet), then it
    // settles to the button. If that toast is already up, the button waits until it is gone.
    const settle = () => { pill.innerHTML = svg(ICON.play) + "Media view"; pill.classList.remove("wide"); };
    const show = () => {
      if (document.getElementById("wt-toast")) return setTimeout(show, 300);
      if (!prefs().button) return;
      pill.classList.add("in");
      if (item?.name) {
        pill.innerHTML = svg(ICON.play) + `<span class="tr">Tracking</span><b></b>`;
        pill.querySelector("b").textContent = item.name;
        pill.classList.add("wide");
        setTimeout(settle, 3000);
      } else settle();
    };
    show();
    ask("item");
    if (prefs().autoOpen || sessionStorage.getItem("mv-open") === "1") toggle(true);
  }
  // a video in the page itself announces itself the same way
  setInterval(() => { const v = bigVideo(); if (v && v.duration > 30) seen(); }, 1000);

  function toggle(on = !ui) {
    if (on && !ui) open(); else if (!on && ui) close();
  }

  function open() {
    if (!shadow) seen();
    if (!shadow) return;
    sessionStorage.setItem("mv-open", "1");
    pill && (pill.style.display = "none");
    ui = document.createElement("div");
    ui.className = "root";
    ui.style.zIndex = "2147483645";
    ui.innerHTML = `
      <div class="head"><img class="poster" alt=""><div class="titles"><div class="t1"></div><div class="t2"></div></div>
        <button class="btn" data-a="more" title="More">${svg(ICON.more)}</button>
        <button class="btn" data-a="recs" title="Recommendations">${svg(ICON.recs)}</button>
        <button class="btn" data-a="full" title="Full screen (F)">${svg(ICON.full)}</button>
        <button class="btn" data-a="close" title="Close (Esc)">${svg(ICON.close)}</button></div>
      <div class="stage"></div>
      <div class="bar">
        <div class="tl"><canvas></canvas><div class="tip"></div></div>
        <div class="row">
          <button class="btn" data-a="back" title="Back (J)">${svg(ICON.back)}</button>
          <button class="btn main" data-a="toggle" title="Play / pause (Space)">${svg(ICON.play)}</button>
          <button class="btn" data-a="fwd" title="Forward (L)">${svg(ICON.fwd)}</button>
          <button class="btn" data-a="next" title="Next episode (N)">${svg(ICON.next)}</button>
          <span class="time">0:00 / 0:00</span>
          <span class="grow"></span>
          <button class="btn" data-a="mute" title="Mute (M)">${svg(ICON.vol)}</button>
          <input class="vol" type="range" min="0" max="1" step="0.02">
          <button class="chip" data-a="rate" title="Speed">1×</button>
        </div>
      </div>
      <div class="sheet"><div class="grab" title="Drag up for more on this site"><i></i></div>
        <div class="recs"><div class="rh"></div><div class="rail"></div></div></div>`;
    shadow.append(ui);
    const q = s => ui.querySelector(s);
    ui.addEventListener("click", ev => {
      const a = ev.target.closest("[data-a]")?.dataset.a;
      if (!a) return;
      if (a !== "more") popMenu(null);
      if (a === "close") close();
      else if (a === "toggle") send("toggle");
      else if (a === "back") send("rel", -Number(prefs().skip));
      else if (a === "fwd") send("rel", Number(prefs().skip));
      else if (a === "next") ask("next");
      else if (a === "more") popMenu(popOpen ? null : ev.target.closest("[data-a]"));
      else if (a === "queue") queueInReel();
      else if (a === "reel") openInReel();
      else if (a === "mute") send("mute");
      else if (a === "rate") { const st = state(), rs = [1, 1.25, 1.5, 2, 0.75], r = rs[(rs.indexOf(st?.rate ?? 1) + 1) % rs.length]; send("rate", r); }
      else if (a === "full") document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => {});
      else if (a === "recs") sheetOpen(!q(".sheet").classList.contains("open"));
    });
    q(".vol").addEventListener("input", ev => send("volume", +ev.target.value));
    // the sheet: closed by default; drag the handle up to open, down to close, or tap it
    const sheet = q(".sheet"), grab = q(".grab"), recs = q(".recs");
    const FULL = 236;
    function sheetOpen(on) {
      sheet.classList.toggle("open", on);
      recs.style.removeProperty("--h");
      setPref("recsOpen", on);

    }
    if (prefs().recsOpen) sheet.classList.add("open");
    let dragY = null, startH = 0, moved = false;
    grab.addEventListener("pointerdown", ev => {
      dragY = ev.clientY; startH = recs.getBoundingClientRect().height; moved = false;
      grab.setPointerCapture(ev.pointerId); sheet.classList.add("dragging");
    });
    grab.addEventListener("pointermove", ev => {
      if (dragY == null) return;
      const d = dragY - ev.clientY;
      if (Math.abs(d) > 4) moved = true;
      const h = Math.max(0, Math.min(FULL, startH + d));
      sheet.classList.add("open");
      recs.style.setProperty("--h", h + "px");
      layout();
    });
    grab.addEventListener("pointerup", ev => {
      if (dragY == null) return;
      sheet.classList.remove("dragging");
      const h = recs.getBoundingClientRect().height;
      dragY = null;
      sheetOpen(moved ? h > FULL / 3 : !(startH > 0));
    });
    timeline(q(".tl"));
    drawHead();
    drawRecs();
    // pin the site's player into the stage
    const t = target();
    if (t) pin(t);
    layout();
    addEventListener("resize", layout);
    // the stage shrinks and grows with the sheet's animation: refit the player on every frame of
    // it, not once at the end (which made it snap)
    stageObs = new ResizeObserver(() => layout());
    stageObs.observe(q(".stage"));
    document.addEventListener("keydown", keys, true);
    document.documentElement.style.overflow = "hidden";
    ask("item");
  }

  // the ⋮ menu: its own layer, last in the page and at the top z-index, so it lands above the
  // player (which is lifted above the view itself and would otherwise cover it)
  let pop = null, popOpen = false;
  function popMenu(anchor) {
    if (!anchor) { if (pop) pop.remove(); pop = null; popOpen = false; return; }
    pop?.remove();
    pop = document.createElement("div");
    pop.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none";
    const sr = pop.attachShadow({ mode: "open" });
    const r = anchor.getBoundingClientRect();
    sr.innerHTML = `<style>${CSS}</style><div class="menu" style="top:${r.bottom + 6}px;right:${innerWidth - r.right}px">
      <button data-a="reel">${svg(ICON.play)}Open in reel</button>
      <button data-a="queue">${svg(ICON.recs)}Add to reel's queue</button></div>`;
    sr.addEventListener("click", ev => {
      const a = ev.target.closest("[data-a]")?.dataset.a;
      popMenu(null);
      if (a === "reel") openInReel(); else if (a === "queue") queueInReel();
    });
    document.documentElement.append(pop);
    popOpen = true;
  }
  function close() {
    popMenu(null);
    sessionStorage.removeItem("mv-open");
    cancelAnimationFrame(raf);
    removeEventListener("resize", layout);
    stageObs?.disconnect(); stageObs = null;
    document.removeEventListener("keydown", keys, true);
    unpin();
    document.documentElement.style.overflow = "";
    ui?.remove(); ui = null;
    if (pill) pill.style.display = "";
  }

  // Lift the player above our overlay. An ancestor with a transform, filter or its own z-index
  // traps a fixed child in its stacking context (under the overlay, or placed against it), so each
  // ancestor is flattened and lifted, and made invisible: only the player itself stays visible.
  let lifted = [];
  const keep = el => ({ el, style: el.getAttribute("style") });
  function pin(t) {
    unpin();
    saved = keep(t);
    for (let a = t.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      lifted.push(keep(a));
      a.style.setProperty("transform", "none", "important");
      a.style.setProperty("filter", "none", "important");
      a.style.setProperty("perspective", "none", "important");
      a.style.setProperty("contain", "none", "important");
      a.style.setProperty("will-change", "auto", "important");
      a.style.setProperty("opacity", "1", "important");
      a.style.setProperty("z-index", "2147483647", "important");
      a.style.setProperty("visibility", "hidden", "important");
      if (getComputedStyle(a).position === "static" && a !== document.body) a.style.setProperty("position", "relative", "important");
    }
  }
  function unpin() {
    for (const x of [saved, ...lifted]) if (x) x.style == null ? x.el.removeAttribute("style") : x.el.setAttribute("style", x.style);
    saved = null; lifted = [];
  }
  // the reporting frame can change (a new episode, a mirror switched): follow it
  setInterval(() => { if (ui) { const t = target(); if (t && t !== saved?.el) pin(t); } }, 1500);

  function layout() {
    if (!ui || !saved) return;
    const r = ui.querySelector(".stage").getBoundingClientRect();
    const st = state();
    const ar = st?.w && st?.h ? st.w / st.h : 16 / 9;
    let w = r.width - 40, h = w / ar;
    if (h > r.height - 8) { h = r.height - 8; w = h * ar; }
    const x = r.left + (r.width - w) / 2, y = r.top + (r.height - h) / 2;
    saved.el.style.cssText = (saved.style || "") + `;position:fixed !important;left:${x}px !important;top:${y}px !important;width:${w}px !important;` +
      `height:${h}px !important;max-width:none !important;max-height:none !important;margin:0 !important;transform:none !important;` +
      `z-index:2147483647 !important;border-radius:20px !important;background:#000 !important;border:0 !important;visibility:visible !important;`;
  }

  function keys(ev) {
    if (!ui || ev.target.closest?.("input,textarea,[contenteditable]")) return;
    const k = ev.key.toLowerCase();
    const map = { " ": () => send("toggle"), k: () => send("toggle"), j: () => send("rel", -Number(prefs().skip)), l: () => send("rel", Number(prefs().skip)),
      arrowleft: () => send("rel", -5), arrowright: () => send("rel", 5), m: () => send("mute"), n: () => ask("next"),
      f: () => ui.querySelector("[data-a=full]").click(), escape: () => { if (!document.fullscreenElement) close(); } };
    if (map[k] && !ev.ctrlKey && !ev.metaKey && !ev.altKey) { ev.preventDefault(); ev.stopPropagation(); map[k](); }
  }
  document.addEventListener("keydown", ev => { if (ev.altKey && ev.key.toLowerCase() === "m") { ev.preventDefault(); toggle(); } });

  function drawHead() {
    if (!ui) return;
    const q = s => ui.querySelector(s);
    const name = item?.name || document.title;
    const ep = item?.series ? `S${String(item.s).padStart(2, "0")} E${String(item.e).padStart(2, "0")}${item.epName ? " · " + item.epName : ""}` : "";
    q(".t1").textContent = name;
    q(".t2").textContent = [ep, item?.sub || location.hostname].filter(Boolean).join("  ·  ");
    const poster = item?.poster || document.querySelector('meta[property="og:image"]')?.content;
    q(".poster").style.display = poster ? "" : "none";
    if (poster) q(".poster").src = poster;
    q("[data-a=next]").disabled = !item?.next;
    q("[data-a=next]").title = item?.next ? `${item.next} (N)` : "No next episode";
  }

  function drawRecs() {
    const { label, items } = recommendations();
    const rh = ui.querySelector(".rh"), rail = ui.querySelector(".rail");
    rh.textContent = label || "More on this site";
    rail.innerHTML = "";
    if (!items.length) { rail.innerHTML = `<div class="empty">Nothing to recommend on this page.</div>`; return; }
    for (const it of items) {
      const a = document.createElement("a");
      a.className = "card"; a.href = it.href; a.title = it.name;
      const img = document.createElement("img"); img.src = it.poster; img.loading = "lazy"; img.alt = "";
      const s = document.createElement("span"); s.textContent = it.name;
      a.append(img, s);
      rail.append(a);
    }
  }

  // ---- the timeline: the played part is a travelling wave (as Android's media bar), its
  // amplitude a spring that settles flat while paused; buffered is a lighter band; drag seeks.
  function timeline(box) {
    const cv = box.querySelector("canvas"), tip = box.querySelector(".tip"), ctx = cv.getContext("2d");
    let amp = 0, ampV = 0, phase = 0, last = performance.now(), drag = null, hoverX = -1;
    const posAt = x => { const st = state(), r = cv.getBoundingClientRect(); return st ? Math.max(0, Math.min(1, (x - r.left) / r.width)) * st.dur : 0; };
    box.addEventListener("pointerdown", ev => { drag = posAt(ev.clientX); box.setPointerCapture(ev.pointerId); });
    box.addEventListener("pointermove", ev => {
      const r = cv.getBoundingClientRect();
      hoverX = ev.clientX - r.left;
      tip.style.left = `${Math.max(24, Math.min(r.width - 24, hoverX))}px`;
      tip.textContent = clock(posAt(ev.clientX));
      if (drag != null) drag = posAt(ev.clientX);
    });
    box.addEventListener("pointerleave", () => { hoverX = -1; });
    box.addEventListener("pointerup", () => { if (drag != null) send("seek", drag); drag = null; });
    const frame = now => {
      if (!ui) return;
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      const dpr = devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
      if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const st = state();
      const playing = st && !st.paused && drag == null;
      // spring toward the wave height (playing) or flat (paused): stable for any dt
      const target = playing && prefs().wave ? 3.2 : 0;
      const n = Math.max(1, Math.ceil(dt / 0.008)), step = dt / n;
      for (let i = 0; i < n; i++) { ampV += (-120 * (amp - target) - 16 * ampV) * step; amp += ampV * step; }
      if (playing) phase += dt * 2 * Math.PI * 0.9;
      const mid = H / 2, pad = 8, w = W - pad * 2;
      const frac = st && st.dur > 0 ? (drag ?? st.pos) / st.dur : 0, bufF = st && st.dur > 0 ? Math.min(1, st.buf / st.dur) : 0;
      const px = pad + w * frac;
      ctx.lineCap = "round"; ctx.lineWidth = 4;
      // track, buffered
      ctx.strokeStyle = "#49454F"; ctx.beginPath(); ctx.moveTo(px + 6, mid); ctx.lineTo(pad + w, mid); ctx.stroke();
      if (bufF > frac) { ctx.strokeStyle = "#625B71"; ctx.beginPath(); ctx.moveTo(px + 6, mid); ctx.lineTo(pad + w * bufF, mid); ctx.stroke(); }
      // played: the wave
      ctx.strokeStyle = "#D0BCFF"; ctx.beginPath();
      for (let x = pad; x <= px; x += 2) {
        const fade = Math.min(1, (px - x) / 18);   // flattens into the thumb
        const y = mid + Math.sin((x - pad) / 40 * 2 * Math.PI - phase) * amp * fade;
        x === pad ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.lineTo(px, mid); ctx.stroke();
      // thumb: a rounded bar, taller while dragging
      ctx.fillStyle = "#D0BCFF";
      const th = drag != null ? 22 : 16;
      ctx.beginPath(); ctx.roundRect(px - 2.5, mid - th / 2, 5, th, 2.5); ctx.fill();
      if (hoverX >= 0) { ctx.fillStyle = "#E6E0E922"; ctx.fillRect(Math.max(pad, Math.min(pad + w, hoverX)) - 1, mid - 8, 2, 16); }
      // the rest of the bar
      const q = s => ui.querySelector(s);
      if (st) {
        q(".time").textContent = `${clock(drag ?? st.pos)} / ${clock(st.dur)}`;
        q("[data-a=toggle]").innerHTML = svg(st.paused ? ICON.play : ICON.pause);
        q("[data-a=mute]").innerHTML = svg(st.muted || st.vol === 0 ? ICON.mute : ICON.vol);
        const vol = q(".vol"); if (shadow.activeElement !== vol) vol.value = st.muted ? 0 : st.vol;
        q("[data-a=rate]").textContent = `${st.rate ?? 1}×`;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
  }
  // the player may change size (a new episode, the stage on resize); keep it fitted
  setInterval(() => { if (ui) layout(); }, 1000);
})();
