// ==UserScript==
// @name         Autoscroll
// @namespace    tela-zen
// @version      1.0.0
// @description  Reading autoscroll (Alt+A; Alt+Up/Down or the wheel for speed, Space pause, Esc stop) and Windows-style middle-click scrolling, on any page.
// @match        *://*/*
// @run-at       document-idle
// @grant        none
// @updateURL    http://127.0.0.1:8788/autoscroll.user.js
// @downloadURL  http://127.0.0.1:8788/autoscroll.user.js
// ==/UserScript==

(() => {
  if (window.top !== window && innerHeight < 200) return;   // tiny frames (ads, widgets) are left alone

  // ── where to scroll: the scrollable box under the pointer, else the page ──
  let pointer = { x: innerWidth / 2, y: innerHeight / 2 };
  addEventListener("mousemove", e => { pointer = { x: e.clientX, y: e.clientY }; }, { passive: true, capture: true });
  function scroller(x = pointer.x, y = pointer.y) {
    for (let el = document.elementFromPoint(x, y); el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      const cs = getComputedStyle(el);
      if (/(auto|scroll|overlay)/.test(cs.overflowY + cs.overflowX) && (el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2)) return el;
    }
    return document.scrollingElement || document.documentElement;
  }

  // ── a small display ──
  const hud = document.createElement("div");
  hud.style.cssText = "position:fixed;z-index:2147483647;right:18px;bottom:18px;padding:7px 12px;border-radius:12px;background:#1d1b20e6;color:#e6e0e9;font:600 12px system-ui,sans-serif;box-shadow:0 4px 18px #0006;pointer-events:none;opacity:0;transition:opacity .2s";
  let hudTimer;
  function show(text, stay = false) {
    if (!hud.isConnected) document.documentElement.append(hud);
    hud.textContent = text;
    hud.style.opacity = "1";
    clearTimeout(hudTimer);
    if (!stay) hudTimer = setTimeout(() => { hud.style.opacity = "0"; }, 1400);
  }

  // ── reading autoscroll: a steady speed in px per second ──
  const KEY = "tela-autoscroll-speed";
  let speed = Number(localStorage.getItem(KEY)) || 60;
  let reading = false, paused = false, target = null, last = 0, carry = 0;
  function readFrame(t) {
    if (!reading) return;
    const dt = last ? (t - last) / 1000 : 0;
    last = t;
    if (!paused) {
      carry += speed * dt;
      const step = Math.trunc(carry);
      if (step) {
        carry -= step;
        const before = target.scrollTop;
        target.scrollTop += step;
        if (target.scrollTop === before && step > 0) { stopReading("Autoscroll: reached the end"); return; }
      }
    }
    requestAnimationFrame(readFrame);
  }
  function startReading() {
    target = scroller();
    reading = true; paused = false; last = 0; carry = 0;
    show(`Autoscroll ${speed} px/s · Alt+↑↓ speed · Space pause · Esc stop`, true);
    requestAnimationFrame(readFrame);
  }
  function stopReading(why = "Autoscroll off") { reading = false; show(why); }
  function setSpeed(v) {
    speed = Math.max(5, Math.min(2000, Math.round(v)));
    try { localStorage.setItem(KEY, String(speed)); } catch {}
    show(`Autoscroll ${speed} px/s${paused ? " · paused" : ""}`, true);
  }

  // ── middle click: scroll toward the pointer, faster the further it is from where you clicked ──
  let anchor = null, mark = null, aFrame = 0, aTarget = null, aLast = 0;
  function anchorFrame(t) {
    if (!anchor) return;
    const dt = aLast ? (t - aLast) / 1000 : 0;
    aLast = t;
    const dx = pointer.x - anchor.x, dy = pointer.y - anchor.y;
    const speedOf = d => Math.sign(d) * Math.max(0, Math.abs(d) - 12) ** 1.4 * 6;   // a dead zone, then growing
    aTarget.scrollBy(speedOf(dx) * dt, speedOf(dy) * dt);
    aFrame = requestAnimationFrame(anchorFrame);
  }
  function startAnchor(x, y) {
    aTarget = scroller(x, y);
    anchor = { x, y }; aLast = 0;
    mark = document.createElement("div");
    mark.style.cssText = `position:fixed;z-index:2147483647;left:${x - 14}px;top:${y - 14}px;width:28px;height:28px;border-radius:50%;background:#1d1b20cc;border:2px solid #d0bcff;box-shadow:0 2px 10px #0006;pointer-events:none`;
    document.documentElement.append(mark);
    aFrame = requestAnimationFrame(anchorFrame);
  }
  function stopAnchor() {
    anchor = null;
    cancelAnimationFrame(aFrame);
    mark?.remove(); mark = null;
  }
  addEventListener("mousedown", e => {
    if (anchor) { e.preventDefault(); e.stopPropagation(); stopAnchor(); return; }
    if (e.button !== 1) return;
    // a middle click on a link still opens it in a new tab; on inputs it pastes
    if (e.target.closest?.("a[href], input, textarea, [contenteditable=''], [contenteditable='true'], select, button")) return;
    e.preventDefault();
    e.stopPropagation();
    startAnchor(e.clientX, e.clientY);
  }, true);
  // the browser's own middle-click actions (paste on Linux, autoscroll) stay off while ours runs
  addEventListener("auxclick", e => { if (e.button === 1 && (anchor || mark)) e.preventDefault(); }, true);

  // ── keys and wheel ──
  addEventListener("keydown", e => {
    const typing = e.target.closest?.("input, textarea, select, [contenteditable=''], [contenteditable='true']");
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === "KeyA") {
      e.preventDefault();
      reading ? stopReading() : startReading();
      return;
    }
    if (anchor && e.key === "Escape") { e.preventDefault(); stopAnchor(); return; }
    if (!reading || typing) return;
    if (e.key === "Escape") { e.preventDefault(); stopReading(); }
    else if (e.key === " ") { e.preventDefault(); paused = !paused; last = 0; show(paused ? "Autoscroll paused · Space go on" : `Autoscroll ${speed} px/s`, paused); }
    else if (e.altKey && e.key === "ArrowUp") { e.preventDefault(); setSpeed(speed * 1.25); }
    else if (e.altKey && e.key === "ArrowDown") { e.preventDefault(); setSpeed(speed / 1.25); }
  }, true);
  // while reading, the wheel sets the speed instead of jumping
  addEventListener("wheel", e => {
    if (!reading) return;
    e.preventDefault();
    setSpeed(speed * (e.deltaY > 0 ? 1.15 : 1 / 1.15));   // down: faster
  }, { capture: true, passive: false });
})();
