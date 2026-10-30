// ==UserScript==
// @name         Twitch: claim bonus points
// @namespace    tela-zen
// @version      1.0.0
// @description  Clicks Twitch's channel points bonus chest as soon as it appears, in any twitch.tv tab (a muted one in the background is enough). Twitch only lets its own page claim, so this is the way that works.
// @match        *://www.twitch.tv/*
// @run-at       document-idle
// @grant        none
// @updateURL    http://127.0.0.1:8788/twitch-autoclaim.user.js
// @downloadURL  http://127.0.0.1:8788/twitch-autoclaim.user.js
// ==/UserScript==

(() => {
  // the chest sits in the chat's footer; its label is in the page's language
  const CHEST = [
    'button[aria-label="Claim Bonus"]',
    'button[aria-label="Bonus abholen"]',
    '[data-test-selector="community-points-summary"] button[class*="claimable"]',
    '.claimable-bonus__icon',
  ].join(",");
  let claimed = 0;

  function tryClaim() {
    const el = document.querySelector(CHEST);
    const btn = el?.closest("button") || el;
    if (!btn) return;
    btn.click();
    claimed++;
    document.title = document.title.replace(/^(\(\+\d+\) )?/, `(+${claimed}) `);
    setTimeout(() => { document.title = document.title.replace(/^\(\+\d+\) /, ""); }, 4000);
  }

  // the chest comes and goes with the chat's markup: watched, and checked now and then as well
  new MutationObserver(() => { clearTimeout(tryClaim.t); tryClaim.t = setTimeout(tryClaim, 400); })
    .observe(document.body, { childList: true, subtree: true });
  setInterval(tryClaim, 15000);
})();
