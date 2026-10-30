// ==UserScript==
// @name         chess.com: games into my chess app
// @namespace    tela-zen
// @version      1.0.0
// @description  When a game of yours ends on chess.com, your new finished games are fetched (chess.com's public API, through the local media bridge) into the arcade chess app's library, for replay and analysis there. Menu: set your user name, sync now.
// @match        *://www.chess.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      127.0.0.1
// @updateURL    http://127.0.0.1:8788/chesscom-to-arcade.user.js
// @downloadURL  http://127.0.0.1:8788/chesscom-to-arcade.user.js
// ==/UserScript==

(() => {
  const BRIDGE = "http://127.0.0.1:8788/chess/sync";

  // your user name: set once from the menu, else read from the page's own user link
  function userName() {
    const set = GM_getValue("user", "");
    if (set) return set;
    const link = document.querySelector('a[href*="/member/"][class*="user"], a[href*="/member/"][data-user]');
    const m = link && link.getAttribute("href").match(/\/member\/([A-Za-z0-9_-]+)/);
    return m ? m[1].toLowerCase() : "";
  }

  function note(text) {
    const n = document.createElement("div");
    n.textContent = text;
    n.style.cssText = "position:fixed;z-index:2147483647;bottom:22px;left:22px;padding:9px 14px;border-radius:10px;background:#26252b;color:#f2efe8;font:600 13px system-ui,sans-serif;box-shadow:0 6px 20px #0008";
    document.documentElement.append(n);
    setTimeout(() => n.remove(), 3500);
  }

  function sync(quiet) {
    const user = userName();
    if (!user) { if (!quiet) note("Chess app: set your chess.com name in the userscript menu first"); return; }
    GM_xmlhttpRequest({
      method: "POST", url: BRIDGE, headers: { "Content-Type": "application/json" },
      data: JSON.stringify({ user, months: 2 }), timeout: 60000,
      onload: r => {
        let d = {};
        try { d = JSON.parse(r.responseText); } catch {}
        if (!d.ok) { if (!quiet) note("Chess app: " + (d.error || "sync failed")); return; }
        if (d.added || !quiet) note(d.added ? `Chess app: ${d.added} new game${d.added > 1 ? "s" : ""} in your library` : "Chess app: library up to date");
      },
      onerror: () => { if (!quiet) note("Chess app: the media bridge is not running"); },
    });
  }

  GM_registerMenuCommand("Set my chess.com user name", () => {
    const v = (prompt("Your chess.com user name:", userName()) || "").trim().toLowerCase();
    if (v) { GM_setValue("user", v); note("Chess app: games of " + v + " will be synced"); }
  });
  GM_registerMenuCommand("Sync my games now", () => sync(false));

  // a game ending: chess.com shows its game-over panel; the API lists the game a little later,
  // so the sync runs twice (after ~15 s and ~70 s). One per game page.
  let synced = "";
  const isOver = () => !!document.querySelector('[class*="game-over"], [class*="gameOver"], [data-cy*="game-over"]');
  new MutationObserver(() => {
    const page = location.pathname;
    if (!/\/game\//.test(page) || synced === page || !isOver()) return;
    synced = page;
    setTimeout(() => sync(true), 15000);
    setTimeout(() => sync(true), 70000);
  }).observe(document.body, { childList: true, subtree: true });
})();
