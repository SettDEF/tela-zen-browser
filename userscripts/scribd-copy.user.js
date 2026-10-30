// ==UserScript==
// @name         Scribd: copy what you selected
// @namespace    tela-zen
// @version      1.2.2
// @description  Scribd scrambles a document's characters and draws them right with its own font, so a copy pastes junk. This copies the text as you see it: the selection is drawn in that font and read back (tesseract, through the media bridge).
// @match        *://*.scribd.com/*
// @match        *://*.everand.com/*
// @match        *://*.slideshare.net/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @connect      127.0.0.1
// @updateURL    http://127.0.0.1:8788/scribd-copy.user.js
// @downloadURL  http://127.0.0.1:8788/scribd-copy.user.js
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
  // a trace of each copy to the media bridge (~/.cache/watch-tracker.log, the drawn picture beside it)
  const DEBUG = true;
  const dbg = (msg, png) => { if (!DEBUG) return; try { GM_xmlhttpRequest({ method: "POST", url: "http://127.0.0.1:8788/wtlog",
    headers: { "Content-Type": "application/json" }, data: JSON.stringify({ where: "scribd " + location.hostname, msg, png }) }); } catch {} };
  dbg("loaded in " + (window.top === window.self ? "page" : "frame") + " " + location.pathname.slice(0, 60));
  // zero-width spaces and joiners, soft hyphens, direction marks, BOM
  const INVISIBLE = /[­​-‏‪-‮⁠-⁤﻿]/g;
  const BLOCK = /^(P|DIV|LI|H[1-6]|TR|BR|SECTION|ARTICLE|BLOCKQUOTE|PRE|TABLE)$/;

  // text the reader actually sees: not hidden, transparent, tiny or pushed off the page
  const seen = new WeakMap();
  function visible(el) {
    if (!el) return true;
    if (seen.has(el)) return seen.get(el);
    let ok = true;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse") ok = false;
    else if (parseFloat(cs.opacity) < 0.05 || parseFloat(cs.fontSize) < 2) ok = false;
    else if (/rgba\([^)]*,\s*0\)|transparent/.test(cs.color)) ok = false;
    else if (el.getAttribute("aria-hidden") === "true" && !el.textContent.trim()) ok = false;
    else {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || r.right < -1000 || r.bottom < -1000) ok = false;
      if (cs.clip && /rect\(0(px)?,\s*0(px)?,\s*0(px)?,\s*0(px)?\)/.test(cs.clip)) ok = false;
    }
    if (ok && el.parentElement && el.parentElement !== document.body) ok = visible(el.parentElement);
    seen.set(el, ok);
    return ok;
  }

  // the selection as lines of [text, css font] pieces, in the order they are read
  function selectionLines() {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed) return [];
    const lines = [];
    let line = [], lastTop = null;
    for (let i = 0; i < sel.rangeCount; i++) {
      const range = sel.getRangeAt(i);
      const root = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentNode;
      const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node = walk.currentNode.nodeType === 3 ? walk.currentNode : walk.nextNode();
      while (node) {
        if (range.intersectsNode(node) && visible(node.parentElement)) {
          let t = node.data;
          if (node === range.endContainer) t = t.slice(0, range.endOffset);
          if (node === range.startContainer) t = t.slice(range.startOffset);
          t = t.replace(INVISIBLE, "");
          if (t.trim()) {
            const top = Math.round(node.parentElement.getBoundingClientRect().top);
            // a new line when the text moves down by more than half a line
            const cs = getComputedStyle(node.parentElement);
            if (lastTop !== null && Math.abs(top - lastTop) > parseFloat(cs.fontSize) / 2) { lines.push(line); line = []; }
            lastTop = top;
            line.push([t, `${cs.fontStyle} ${cs.fontWeight} 44px ${cs.fontFamily}`]);
          }
        }
        node = walk.nextNode();
      }
    }
    if (line.length) lines.push(line);
    return lines;
  }

  // the lines drawn in the page's own fonts, black on white, large: what the reader sees
  function draw(lines) {
    const c = document.createElement("canvas");
    const g = c.getContext("2d");
    const pad = 24, lh = 60;
    let w = 0;
    for (const l of lines) { let x = 0; for (const [t, f] of l) { g.font = f; x += g.measureText(t).width; } w = Math.max(w, x); }
    c.width = Math.min(16000, Math.ceil(w) + pad * 2);
    c.height = lines.length * lh + pad * 2;
    g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = "#000"; g.textBaseline = "middle";
    lines.forEach((l, i) => {
      let x = pad;
      for (const [t, f] of l) { g.font = f; g.fillText(t, x, pad + i * lh + lh / 2); x += g.measureText(t).width; }
    });
    return c.toDataURL("image/png").split(",")[1];
  }

  function note(text) {
    const n = document.createElement("div");
    n.textContent = text;
    n.style.cssText = "position:fixed;z-index:2147483647;bottom:24px;left:50%;transform:translateX(-50%);background:#222;color:#fff;padding:8px 14px;border-radius:14px;font:13px system-ui;box-shadow:0 4px 16px #0006;transition:opacity .3s";
    document.documentElement.append(n);
    setTimeout(() => { n.style.opacity = "0"; setTimeout(() => n.remove(), 400); }, 1800);
  }

  // the text as seen: drawn, read back by tesseract through the media bridge, onto the clipboard
  function readAsSeen() {
    const lines = selectionLines();
    dbg(`lines: ${lines.length}, fonts: ${JSON.stringify([...new Set(lines.flat().map(x => x[1]))].slice(0, 4))}, text: ${JSON.stringify(lines.map(l => l.map(x => x[0]).join("")).join(" / ").slice(0, 300))}`);
    if (!lines.length) return;
    const png = draw(lines);
    dbg(`drawn ${png.length} b64 chars`, png);
    GM_xmlhttpRequest({
      method: "POST", url: "http://127.0.0.1:8788/ocr",
      headers: { "Content-Type": "application/json" },
      data: JSON.stringify({ png }),
      timeout: 30000,
      onload: r => {
        let text = "";
        try { text = JSON.parse(r.responseText).text || ""; } catch {}
        dbg("ocr: " + JSON.stringify(text.slice(0, 300)) + " status " + r.status);
        if (!text) { note("Could not read the text (is the media bridge running?)"); return; }
        text = joinUrls(text);
        GM_setClipboard(text, "text");
        note("Copied as you see it");
      },
      onerror: e => { dbg("ocr request failed " + JSON.stringify(e?.error || e?.status)); note("Media bridge not reachable: copied as the page has it"); },
    });
  }

  // the selection, rebuilt from its visible text nodes
  function cleanSelection() {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed) return "";
    let out = "";
    for (let i = 0; i < sel.rangeCount; i++) {
      const range = sel.getRangeAt(i);
      const root = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentNode;
      const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
      let node = walk.currentNode;
      while (node) {
        if (range.intersectsNode(node)) {
          if (node.nodeType === 1) {
            if (BLOCK.test(node.tagName) && out && !out.endsWith("\n")) out += "\n";
          } else if (visible(node.parentElement)) {
            let t = node.data;
            if (node === range.endContainer) t = t.slice(0, range.endOffset);
            if (node === range.startContainer) t = t.slice(range.startOffset);
            out += t;
          }
        }
        node = walk.nextNode();
      }
    }
    return out.replace(INVISIBLE, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  // ours first (capture, document-start): the page's own copy handlers never run
  for (const type of ["copy", "cut"]) {
    window.addEventListener(type, e => {
      e.stopImmediatePropagation();
      const text = cleanSelection();
      dbg(`${type}: selection ${JSON.stringify(text.slice(0, 200))}, clipboardData ${!!e.clipboardData}`);
      if (!text || !e.clipboardData) return;   // nothing better to give: the browser's own copy
      e.clipboardData.setData("text/plain", joinUrls(text));
      e.preventDefault();
      // then the text as seen replaces it, a moment later
      readAsSeen();
    }, true);
  }
  for (const type of ["selectstart", "contextmenu", "dragstart"]) {
    window.addEventListener(type, e => e.stopImmediatePropagation(), true);
  }
  // selecting allowed again wherever the page turned it off
  const style = document.createElement("style");
  style.textContent = "*, *::before, *::after { -webkit-user-select: text !important; user-select: text !important; }";
  (document.head || document.documentElement).append(style);
})();
