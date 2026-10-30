// ==UserScript==
// @name         Scribd: reader
// @namespace    tela-zen
// @version      1.1.1
// @description  Scribd's document page as a clean reader of our own: no header, sidebars, banners or suggestions, just the pages on a calm background with a slim bar (title, page n / N, zoom, width, light / dark). Alt+R switches back to Scribd's page. Selecting is a rectangle you drag (Scribd's text is scattered, scrambled pieces, so the browser's own selection jumps): what is inside is copied as you see it. Shows only the pages Scribd itself delivers.
// @match        *://*.scribd.com/document/*
// @match        *://*.scribd.com/doc/*
// @match        *://*.scribd.com/presentation/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @connect      127.0.0.1
// @updateURL    http://127.0.0.1:8788/scribd-reader.user.js
// @downloadURL  http://127.0.0.1:8788/scribd-reader.user.js
// ==/UserScript==

(() => {
  // a web address split by the page's text pieces ("…/mono . m3u8"): the spaces inside it closed up
  function joinUrls(text) {
    let prev;
    do {
      prev = text;
      text = text.replace(/\b(https?)\s*:\s*\/\s*\/\s*/gi, "$1://")
        .replace(/(https?:\/\/\S*?)[ \t]+([./?=&#:_-])[ \t]*(?=\S)/gi, "$1$2")
        .replace(/(https?:\/\/\S*[./?=&#:_-])[ \t]+(?=[\w%~])/gi, "$1");
    } while (text !== prev);
    return text;
  }
  // Scribd lazy-loads each page as its own viewer scrolls, so the pages stay where they are:
  // everything around them is hidden and they are restyled in place.
  const PAGE = '.outer_page, [class*="outer_page"], [data-page], .newpage';
  const KEY = "tela-scribd-reader";
  const prefs = (() => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } })();
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch {} };
  prefs.on ??= true; prefs.dark ??= true; prefs.width ??= 860; prefs.zoom ??= 1;

  const pages = () => [...document.querySelectorAll(PAGE)].filter(p => !p.parentElement.closest(PAGE) && p.offsetWidth > 100);
  // the box that scrolls the pages: Scribd's own scroller, else the window
  function scroller() {
    for (let el = pages()[0]?.parentElement; el && el !== document.body; el = el.parentElement) {
      const o = getComputedStyle(el).overflowY;
      if ((o === "auto" || o === "scroll") && el.scrollHeight > el.clientHeight + 10) return el;
    }
    return document.scrollingElement;
  }

  const css = document.createElement("style");
  css.id = "tsr-css";
  function paint() {
    const bg = prefs.dark ? "#141218" : "#ece6f0", fg = prefs.dark ? "#e6e0e9" : "#1d1b20";
    const bar = prefs.dark ? "#211f26ee" : "#f7f2faee";
    css.textContent = `
      html.tsr body { background: ${bg} !important; }
      /* everything that is not a page, an ancestor of one, or ours: gone */
      html.tsr body *:not(.tsr-keep):not(.tsr-keep *):not(#tsr-bar):not(#tsr-bar *) { visibility: hidden !important; }
      html.tsr .tsr-path { visibility: visible !important; background: transparent !important; box-shadow: none !important;
        border: 0 !important; margin-left: 0 !important; margin-right: 0 !important; max-width: none !important; }
      html.tsr .tsr-scroll { position: fixed !important; inset: 56px 0 0 0 !important; width: auto !important; height: auto !important;
        overflow-y: auto !important; z-index: 2147483000 !important; background: ${bg} !important; padding: 24px 0 80px !important; }
      html.tsr .tsr-keep { visibility: visible !important; margin: 0 auto 22px !important; float: none !important;
        max-width: ${prefs.width}px !important; border-radius: 10px !important; overflow: hidden !important;
        box-shadow: 0 6px 28px #0007 !important; background: #fff !important; }
      html.tsr .tsr-keep [class*="blur"], html.tsr .tsr-keep [class*="promo"], html.tsr .tsr-keep [class*="upsell"] { visibility: hidden !important; }
      html.tsr .tsr-keep, html.tsr .tsr-keep * { user-select: none !important; cursor: crosshair !important; }
      #tsr-rect { position: fixed; z-index: 2147483646; border: 2px solid #d0bcff; background: #d0bcff2e; border-radius: 6px; pointer-events: none; }
      #tsr-note { position: fixed; z-index: 2147483647; bottom: 24px; left: 50%; transform: translateX(-50%); padding: 9px 16px; border-radius: 18px;
        background: #1d1b20f0; color: #fff; font: 600 13px system-ui, sans-serif; box-shadow: 0 6px 20px #0008; }
      #tsr-bar { position: fixed; z-index: 2147483647; top: 0; left: 0; right: 0; height: 56px; display: none; align-items: center; gap: 10px;
        padding: 0 16px; background: ${bar}; backdrop-filter: blur(14px); color: ${fg}; font: 500 13px system-ui, sans-serif;
        box-shadow: 0 1px 0 ${prefs.dark ? "#ffffff14" : "#0000001a"}; }
      html.tsr #tsr-bar { display: flex; }
      #tsr-bar .t { flex: 1; min-width: 0; font-weight: 650; font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #tsr-bar .pill { display: flex; align-items: center; gap: 2px; height: 34px; padding: 0 4px; border-radius: 17px;
        background: ${prefs.dark ? "#ffffff10" : "#0000000a"}; }
      #tsr-bar button { all: unset; cursor: pointer; min-width: 30px; height: 30px; padding: 0 8px; border-radius: 15px; text-align: center;
        box-sizing: border-box; line-height: 30px; color: inherit; }
      #tsr-bar button:hover { background: ${prefs.dark ? "#ffffff1a" : "#00000012"}; }
      #tsr-bar .n { min-width: 64px; text-align: center; opacity: .75; font-variant-numeric: tabular-nums; }
    `;
  }

  const bar = document.createElement("div");
  bar.id = "tsr-bar";
  const btn = (label, title, fn) => { const b = document.createElement("button"); b.textContent = label; b.title = title; b.onclick = fn; return b; };
  const title = document.createElement("div");
  title.className = "t";
  const count = document.createElement("span");
  count.className = "n";
  const zoomTxt = document.createElement("span");
  zoomTxt.className = "n";
  const pill = (...kids) => { const p = document.createElement("div"); p.className = "pill"; p.append(...kids); return p; };
  bar.append(
    title,
    pill(btn("‹", "Previous page", () => jump(-1)), count, btn("›", "Next page", () => jump(1))),
    pill(btn("−", "Smaller", () => zoom(-0.1)), zoomTxt, btn("+", "Larger", () => zoom(0.1))),   // the page's own scale, via the browser zoom
    pill(btn("↔", "Wide / narrow", () => { prefs.width = prefs.width > 900 ? 860 : 1200; apply(); })),
    pill(btn("◐", "Light / dark", () => { prefs.dark = !prefs.dark; apply(); })),
    pill(btn("Scribd", "Back to Scribd's page (Alt+R)", () => toggle(false))));

  // the pages are fixed-size boxes: a wider column is the zoom (css zoom breaks where the pointer lands)
  function zoom(d) { prefs.zoom = Math.max(0.6, Math.min(2.5, Math.round((prefs.zoom + d) * 10) / 10)); prefs.width = Math.round(860 * prefs.zoom); apply(); }
  function current() {
    const ps = pages(), mid = innerHeight / 2;
    const i = ps.findIndex(p => { const r = p.getBoundingClientRect(); return r.top <= mid && r.bottom >= mid; });
    return { i: i < 0 ? 0 : i, n: ps.length, ps };
  }
  function jump(d) {
    const { i, ps } = current();
    ps[Math.max(0, Math.min(ps.length - 1, i + d))]?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // mark the pages, the boxes holding them (made transparent) and the scroller
  function mark() {
    const ps = pages();
    if (!ps.length) return false;
    for (const p of ps) {
      p.classList.add("tsr-keep");
      for (let el = p.parentElement; el && el !== document.body; el = el.parentElement) el.classList.add("tsr-path");
    }
    // its own scroller goes full window under the bar; a page that scrolls itself keeps its layout
    const sc = scroller();
    if (sc && sc !== document.documentElement && sc !== document.body) sc.classList.add("tsr-scroll");
    return true;
  }
  function apply() {
    save();
    paint();
    document.documentElement.classList.toggle("tsr", prefs.on);
    zoomTxt.textContent = Math.round(prefs.zoom * 100) + " %";
    title.textContent = (document.querySelector("h1")?.textContent || document.title).replace(/\s*\|\s*PDF.*$|\s*\|\s*Scribd.*$/i, "").trim();
  }
  function toggle(on = !prefs.on) { prefs.on = on; apply(); }

  // ── selection: a rectangle over the pages, its text pieces in reading order ──
  function note(text) {
    document.getElementById("tsr-note")?.remove();
    const n = document.createElement("div");
    n.id = "tsr-note"; n.textContent = text;
    document.documentElement.append(n);
    setTimeout(() => n.remove(), 2200);
  }
  // every visible text piece inside the rectangle, as lines of [text, css font]
  function piecesIn(box) {
    const got = [];
    for (const p of pages()) {
      const pr = p.getBoundingClientRect();
      if (pr.bottom < box.top || pr.top > box.bottom) continue;
      const walk = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const t = n.data.replace(/[\u00ad\u200b-\u200f\u2060-\u2064\ufeff]/g, "");
        if (!t.trim()) continue;
        const el = n.parentElement, cs = getComputedStyle(el);
        if (cs.visibility === "hidden" && !el.closest(".tsr-keep") || parseFloat(cs.opacity) < 0.05) continue;
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        if (cx < box.left || cx > box.right || cy < box.top || cy > box.bottom) continue;
        got.push({ t, x: r.left, y: cy, h: r.height, font: `${cs.fontStyle} ${cs.fontWeight} 44px ${cs.fontFamily}` });
      }
    }
    // reading order: lines by height on the page, then left to right
    got.sort((a, b) => a.y - b.y || a.x - b.x);
    const lines = [];
    for (const g of got) {
      const line = lines.at(-1);
      if (line && Math.abs(line.y - g.y) < Math.max(4, g.h * 0.45)) line.items.push(g);
      else lines.push({ y: g.y, items: [g] });
    }
    return lines.map(l => l.items.sort((a, b) => a.x - b.x).map(g => [g.t, g.font]));
  }
  // drawn in the page's own fonts (the characters underneath are scrambled), read back by tesseract
  function copyAsSeen(lines) {
    const c = document.createElement("canvas"), g = c.getContext("2d"), pad = 24, lh = 60;
    let w = 0;
    for (const l of lines) { let x = 0; for (const [t, f] of l) { g.font = f; x += g.measureText(t + " ").width; } w = Math.max(w, x); }
    c.width = Math.min(16000, Math.ceil(w) + pad * 2); c.height = lines.length * lh + pad * 2;
    g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.fillStyle = "#000"; g.textBaseline = "middle";
    lines.forEach((l, i) => { let x = pad; for (const [t, f] of l) { g.font = f; g.fillText(t, x, pad + i * lh + lh / 2); x += g.measureText(t + " ").width; } });
    note("Reading the text…");
    GM_xmlhttpRequest({
      method: "POST", url: "http://127.0.0.1:8788/ocr", headers: { "Content-Type": "application/json" },
      data: JSON.stringify({ png: c.toDataURL("image/png").split(",")[1] }), timeout: 30000,
      onload: r => {
        let text = "";
        try { text = JSON.parse(r.responseText).text || ""; } catch {}
        if (!text) return note("Could not read it (is the media bridge running?)");
        text = joinUrls(text);
        GM_setClipboard(text, "text");
        note(`Copied ${text.split("\n").length} line${text.includes("\n") ? "s" : ""}`);
      },
      onerror: () => note("Media bridge not reachable"),
    });
  }
  let drag = null, rect = null;
  addEventListener("mousedown", e => {
    if (!prefs.on || e.button !== 0 || !e.target.closest?.(".tsr-keep")) return;
    e.preventDefault(); e.stopPropagation();
    drag = { x: e.clientX, y: e.clientY };
    rect = document.createElement("div"); rect.id = "tsr-rect";
    document.documentElement.append(rect);
  }, true);
  addEventListener("mousemove", e => {
    if (!drag) return;
    const l = Math.min(drag.x, e.clientX), t = Math.min(drag.y, e.clientY);
    Object.assign(rect.style, { left: l + "px", top: t + "px", width: Math.abs(e.clientX - drag.x) + "px", height: Math.abs(e.clientY - drag.y) + "px" });
  }, true);
  addEventListener("mouseup", e => {
    if (!drag) return;
    const box = { left: Math.min(drag.x, e.clientX), right: Math.max(drag.x, e.clientX), top: Math.min(drag.y, e.clientY), bottom: Math.max(drag.y, e.clientY) };
    drag = null;
    setTimeout(() => rect?.remove(), 350);
    if (box.right - box.left < 8 || box.bottom - box.top < 8) return;   // a click, not a selection
    const lines = piecesIn(box);
    if (!lines.length) return note("No text in that area");
    copyAsSeen(lines);
  }, true);

  addEventListener("keydown", e => {
    if (e.altKey && e.code === "KeyR") { e.preventDefault(); toggle(); }
  }, true);

  // pages arrive late and more load while reading: marked as they come
  let tries = 0;
  const start = setInterval(() => {
    if (mark() || ++tries > 40) {
      clearInterval(start);
      if (!pages().length) return;   // no pages found: Scribd's page stays as it is
      document.head.append(css);
      document.documentElement.append(bar);
      apply();
      new MutationObserver(() => { clearTimeout(start.t); start.t = setTimeout(mark, 200); })
        .observe(document.body, { childList: true, subtree: true });
      setInterval(() => { const { i, n } = current(); count.textContent = `${i + 1} / ${n}`; }, 500);
    }
  }, 500);
})();
