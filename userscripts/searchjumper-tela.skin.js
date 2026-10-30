// ==UserScript==
// @name         Tela - SearchJumper skin
// @namespace    tela.zen
// @version      1.3.0
// @description  Zen-matched restyle, vector icons and per-site placement for SearchJumper
// @match        *://*/*
// @run-at       document-start
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @noframes
// ==/UserScript==

/* Companion to hoothin's SearchJumper (Greasy Fork 445274), not a fork: it
   restyles and re-icons the real bar from outside, so the 95-engine config
   survives and a SearchJumper update cannot wipe this. */

(function () {
  "use strict";

  /* One engine group for the movie script (watch-tracker) and the YT Music one
     (media-ytm), added to the user's own SearchJumper config once - their
     engines are never touched. "Watched" opens watch-tracker's list filtered
     by the selection (#wt-search=, which that script reads). */
  (function addMoviesGroup() {
    const GROUP = "Movies & music";
    const sites = [
      { name: "moflix", url: "https://moflix-stream.xyz/search/%s", match: "^https://moflix-stream\\.xyz/", keywords: "/search/([^/?#]+)" },
      { name: "megakino", url: "https://megakino25.com/index.php?do=search&subaction=search&story=%s", keywords: "story=(.*?)(&|$)" },
      { name: "kinoger", url: "https://kinoger.com/index.php?do=search&subaction=search&story=%s", keywords: "story=(.*?)(&|$)" },
      { name: "s.to", url: "https://s.to/search?q=%s", keywords: "[?&]q=(.*?)(&|$)" },
      { name: "filmpalast", url: "https://filmpalast.to/search/title/%s", keywords: "/search/title/([^/?#]+)" },
      { name: "Watched", url: "https://moflix-stream.xyz/#wt-search=%s", description: "watch-tracker: your history, filtered" },
      { name: "YT Music", url: "https://music.youtube.com/search?q=%s", match: "^https://music\\.youtube\\.com/search", keywords: "[?&]q=(.*?)(&|$)" },
      { name: "TMDB", url: "https://www.themoviedb.org/search?query=%s" },
    ];
    try {
      const data = GM_getValue("searchData");
      if (!data || !Array.isArray(data.sitesConfig)) return;
      const have = data.sitesConfig.find(g => g && g.type === GROUP);
      if (have) {
        // Group already there: only add engines that came later, once each.
        const known = GM_getValue("telaGroupSites", have.sites.map(x => x.name));
        const fresh = sites.filter(x => !known.includes(x.name) && !have.sites.some(y => y.name === x.name));
        GM_setValue("telaGroupSites", sites.map(x => x.name));
        if (!fresh.length) return;
        have.sites.splice(2, 0, ...fresh);
      } else data.sitesConfig.push({ type: GROUP, icon: "film", description: "watch-tracker + media-ytm", sites });
      data.lastModified = Date.now();
      GM_setValue("searchData", data);
    } catch (e) { console.warn("Tela skin: could not add the Movies & music group", e); }
  })();

  /* SearchJumper builds its bar inside attachShadow({mode:"closed"}), which no
     page CSS and no querySelector can reach. Forcing the root open before it is
     created is the only way in, and it has to happen in the page realm - a
     userscript sandbox gets its own view of Element.prototype. */
  /* TELA-SHADOW-PATCH-START (the builder strips this: a merged build opens the
     root at the source, so no page-realm patch and no script ordering) */
  (function forceOpenShadow() {
    const code =
      "(function(){var o=Element.prototype.attachShadow;if(o.__tela)return;" +
      "function p(i){var r=o.call(this,Object.assign({},i,{mode:'open'}));" +
      "try{(window.__telaShadows=window.__telaShadows||[]).push(r);}catch(e){}return r;}" +
      "p.__tela=1;Element.prototype.attachShadow=p;})();";
    try {
      const el = document.createElement("script");
      el.textContent = code;
      (document.head || document.documentElement).prepend(el);
      el.remove();
    } catch {}
  })();
  /* TELA-SHADOW-PATCH-END */

  const HOST = "div.search-jumper-shadow";
  const store = {
    get: (k, d) => { try { return GM_getValue(k, d); } catch { return d; } },
    set: (k, v) => { try { GM_setValue(k, v); } catch {} },
  };

  /* ── Icon sets ────────────────────────────────────────────────────────
     Two families, deliberately. Action entries (copy, paste, preview, ...)
     have no favicon at all - those are the tiles that fall back to clipped
     text like "Chea" - so they get drawn glyphs. Search engines get brand
     marks because their own favicons are the low-res ones. Everything else
     keeps its favicon, upgraded to a real resolution. */

  const s = (body, opts = {}) =>
    `<svg viewBox="0 0 24 24" fill="${opts.fill || "none"}" stroke="${opts.stroke || "currentColor"}"` +
    ` stroke-width="${opts.w || 1.7}" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

  // Monochrome line glyphs; they inherit the tile's colour.
  const GLYPH = {
    search:    s('<circle cx="11" cy="11" r="7"/><path d="M16.5 16.5 21 21"/>'),
    image:     s('<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="8.5" cy="9.5" r="1.8"/><path d="m3.5 17 4.8-4.6a2 2 0 0 1 2.7 0L20.5 21"/>'),
    sitemap:   s('<rect x="9" y="2.5" width="6" height="5" rx="1.5"/><rect x="2.5" y="16.5" width="6" height="5" rx="1.5"/><rect x="15.5" y="16.5" width="6" height="5" rx="1.5"/><path d="M12 7.5v4M5.5 16.5v-2.5h13v2.5"/>'),
    list:      s('<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.3"/><circle cx="4.5" cy="12" r="1.3"/><circle cx="4.5" cy="18" r="1.3"/>'),
    eye:       s('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>'),
    robot:     s('<rect x="3.5" y="8" width="17" height="12" rx="3.5"/><path d="M12 8V4.5"/><circle cx="12" cy="3.2" r="1.4"/><circle cx="9" cy="14" r="1.4"/><circle cx="15" cy="14" r="1.4"/>'),
    listAlt:   s('<rect x="3" y="3.5" width="18" height="17" rx="3"/><path d="M7.5 9h9M7.5 13h9M7.5 17h5"/>'),

    copy:      s('<rect x="8.5" y="8.5" width="12" height="12" rx="2.5"/><path d="M15.5 5.5h-9a2.5 2.5 0 0 0-2.5 2.5v9"/>'),
    paste:     s('<rect x="5" y="4.5" width="14" height="16" rx="2.5"/><path d="M9 4.5V3.2A1.2 1.2 0 0 1 10.2 2h3.6A1.2 1.2 0 0 1 15 3.2v1.3Z"/><path d="M8.5 12h7M8.5 16h4"/>'),
    find:      s('<path d="M19 10.5V6a2.5 2.5 0 0 0-2.5-2.5h-10A2.5 2.5 0 0 0 4 6v12a2.5 2.5 0 0 0 2.5 2.5h4"/><circle cx="16.5" cy="16.5" r="3.6"/><path d="m19.4 19.4 2.1 2.1"/>'),
    link:      s('<path d="M10 13.8a4 4 0 0 0 5.7 0l2.9-2.9a4 4 0 0 0-5.7-5.7l-1.5 1.5"/><path d="M14 10.2a4 4 0 0 0-5.7 0l-2.9 2.9a4 4 0 0 0 5.7 5.7l1.5-1.5"/>'),
    qr:        s('<rect x="3" y="3" width="7" height="7" rx="1.6"/><rect x="14" y="3" width="7" height="7" rx="1.6"/><rect x="3" y="14" width="7" height="7" rx="1.6"/><path d="M14 14h3v3h-3zM19.5 14v.01M14 19.5v.01M19.5 19.5v.01"/>'),
    batch:     s('<rect x="3" y="6.5" width="12" height="12" rx="2.5"/><path d="M7.5 3.5h10A3 3 0 0 1 20.5 6.5v10"/><path d="M9 12.5h4M11 10.5v4"/>'),
    shortlink: s('<path d="M20 11a8 8 0 1 0-2.4 5.7"/><path d="M20 5.5V11h-5.5"/>'),
    decode:    s('<path d="m8.5 8.5-4 3.5 4 3.5M15.5 8.5l4 3.5-4 3.5"/><path d="M13.2 5.5 10.8 18.5"/>'),
    encode:    s('<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>'),
    replace:   s('<path d="M4 8h11.5a3.5 3.5 0 0 1 0 7H4"/><path d="m7 5 -3 3 3 3M17 12l3 3-3 3"/>'),
    video:     s('<rect x="2.5" y="5" width="19" height="14" rx="3"/><path d="m10.5 9.5 4.5 2.5-4.5 2.5z" fill="currentColor" stroke="none"/>'),
    audio:     s('<path d="M4 12v0M7.5 8.5v7M11 5.5v13M14.5 8.5v7M18 10.5v3M21 12v0"/>'),
    picture:   s('<rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="8.5" cy="10" r="1.7"/><path d="m4 16.5 4.3-4a2 2 0 0 1 2.7 0L20 20"/>'),
    archive:   s('<rect x="3" y="7.5" width="18" height="13" rx="2.5"/><path d="M2 4.5h20v3H2z"/><path d="M10 12h4"/>'),
    edit:      s('<path d="M4 20h4l10-10a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>'),
    openUrl:   s('<path d="M13 4h7v7"/><path d="M20 4 10.5 13.5"/><path d="M18 14v4.5A2.5 2.5 0 0 1 15.5 21h-9A2.5 2.5 0 0 1 4 18.5v-9A2.5 2.5 0 0 1 6.5 7H11"/>'),
    server:    s('<rect x="3" y="3.5" width="18" height="6.5" rx="2"/><rect x="3" y="14" width="18" height="6.5" rx="2"/><path d="M7 6.75v.01M7 17.25v.01"/>'),
    domain:    s('<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18"/>'),
    code:      s('<rect x="3" y="4.5" width="18" height="15" rx="3"/><path d="m9.5 10-2 2 2 2M14.5 10l2 2-2 2"/>'),
    lens:      s('<circle cx="12" cy="12" r="4"/><path d="M3.5 8V5.5A2 2 0 0 1 5.5 3.5H8M16 3.5h2.5a2 2 0 0 1 2 2V8M20.5 16v2.5a2 2 0 0 1-2 2H16M8 20.5H5.5a2 2 0 0 1-2-2V16"/>'),
    calc:      s('<rect x="4" y="2.5" width="16" height="19" rx="3"/><path d="M8 7h8"/><path d="M8.5 12h.01M12 12h.01M15.5 12h.01M8.5 16.5h.01M12 16.5h.01M15.5 16.5h.01"/>'),
    clock:     s('<circle cx="12" cy="12" r="9"/><path d="M12 7v5.2l3.2 2"/>'),
    clip:      s('<path d="M3 8V5.5A2.5 2.5 0 0 1 5.5 3H8M16 3h2.5A2.5 2.5 0 0 1 21 5.5V8M21 16v2.5a2.5 2.5 0 0 1-2.5 2.5H16M8 21H5.5A2.5 2.5 0 0 1 3 18.5V16"/><rect x="8" y="8" width="8" height="8" rx="1.5"/>'),
    todo:      s('<rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="m8 12.2 2.8 2.8L16.5 9.3"/>'),
    phone:     s('<rect x="6.5" y="2.5" width="11" height="19" rx="3"/><path d="M10.5 18.5h3"/>'),
    markdown:  s('<rect x="2.5" y="5.5" width="19" height="13" rx="2.5"/><path d="M6 15.5v-7l3 3.5 3-3.5v7"/><path d="M16.5 8.5v5m0 0 -1.8-2m1.8 2 1.8-2"/>'),
    removebg:  s('<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 9h6V3M15 3v6h6M3 15h6v6M15 21v-6h6"/>'),
    translate: s('<path d="M3.5 6h8M7.5 4v2c0 4-2 7-4 8.5"/><path d="M5 10.5c1 2 3 3.8 5 4.5"/><path d="m12.5 20 4-10 4 10M14 16.8h5"/>'),
    cache:     s('<ellipse cx="12" cy="6" rx="8" ry="3.2"/><path d="M4 6v12c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2V6"/><path d="M4 12c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2"/>'),
    star:      s('<path d="m12 3.5 2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 10l6.1-.9z"/>'),
    book:      s('<path d="M4 4.5A2 2 0 0 1 6 2.5h12a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H6a2 2 0 0 0-2 2z"/><path d="M4 18.5A2 2 0 0 1 6 16.5h13"/>'),
    share:     s('<circle cx="18" cy="5.5" r="2.8"/><circle cx="6" cy="12" r="2.8"/><circle cx="18" cy="18.5" r="2.8"/><path d="m8.5 10.7 7-3.9M8.5 13.3l7 3.9"/>'),
    mail:      s('<rect x="2.5" y="5" width="19" height="14" rx="3"/><path d="m3.5 7 7.3 5.2a2 2 0 0 0 2.4 0L20.5 7"/>'),
    everything:s('<circle cx="11" cy="11" r="7"/><path d="M16.5 16.5 21 21"/><path d="M8.5 11h5M11 8.5v5"/>'),
  };

  /* Brand marks, in the site's own colour. Simplified to one or two shapes
     so they stay legible at 26px - a traced logo turns to mud at this size. */
  const brand = (body, vb = "0 0 24 24") =>
    `<svg viewBox="${vb}" fill="none">${body}</svg>`;

  const BRAND = {
    google: brand('<path d="M21.6 12.2c0-.7-.06-1.35-.18-2H12v3.8h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.75 3-4.3 3-7.3z" fill="#4285F4"/><path d="M12 22c2.7 0 4.96-.9 6.6-2.4l-3.2-2.5c-.9.6-2.05.95-3.4.95-2.6 0-4.8-1.75-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22z" fill="#34A853"/><path d="M6.4 13.95a6 6 0 0 1 0-3.85V7.5H3.1a10 10 0 0 0 0 9l3.3-2.55z" fill="#FBBC05"/><path d="M12 5.95c1.47 0 2.79.5 3.83 1.5l2.84-2.84C16.95 2.99 14.7 2 12 2A10 10 0 0 0 3.1 7.5l3.3 2.6C7.2 7.7 9.4 5.95 12 5.95z" fill="#EA4335"/>'),
    bing: brand('<path d="M5.5 2.5 10 4.1v12.2l5.2-3-2.6-1.2-1.6-4 8.5 3v4.2L10 21.5l-4.5-2.5z" fill="#00897B"/>'),
    duckduckgo: brand('<circle cx="12" cy="12" r="10" fill="#DE5833"/><path d="M12.8 18.5c-.4-2.6-1.5-5.6-1.2-7 .2-.9 1-.9 1.4-1.4-1-.7-2.2-.5-2.9.2-.5-1.6-.2-3.3.6-4.3-1.6.2-2.9 1.6-3.2 3.3-.2 1.4.2 2.6.6 3.9.5 1.7 1 3.6 1.2 5.3z" fill="#fff"/><path d="M13 13.5c1.6-.7 3.6-1 5.3-.6-.2.6-.4 1-.7 1.4-1.4-.3-3-.2-4.3.3z" fill="#FC3"/>'),
    yahoo: brand('<path d="M2.5 5.5h4.2L10 11.4l3.3-5.9h4.1L11.9 15v4.5H8.1V15z" fill="#6001D2"/><circle cx="19.8" cy="16.6" r="2.1" fill="#6001D2"/>'),
    yandex: brand('<circle cx="12" cy="12" r="10" fill="#FC3F1D"/><path d="M13.1 6.6h-1c-1.9 0-2.9 1-2.9 2.5 0 1.7.7 2.5 2.2 3.5l1.2.8-3.5 5.2H6.6l3.2-4.7c-1.8-1.3-2.8-2.5-2.8-4.6C7 6.6 8.9 5 12.1 5h3.3v13.6h-2.3z" fill="#fff"/>'),
    baidu: brand('<ellipse cx="6.6" cy="7.4" rx="2.2" ry="2.9" fill="#2932E1"/><ellipse cx="12.4" cy="5.8" rx="2.4" ry="3.2" fill="#2932E1"/><ellipse cx="18" cy="9.4" rx="2.5" ry="2.2" fill="#2932E1"/><path d="M12 11.5c2.6 0 4.2 2 5.6 3.5 1.6 1.7.6 4.4-1.9 4.4H8.3c-2.5 0-3.5-2.7-1.9-4.4C7.8 13.5 9.4 11.5 12 11.5z" fill="#2932E1"/>'),
    brave: brand('<path d="M12 2.5 17.8 5l2.2 3.4-1 1.2 1 6-3 4.3-5 2.6-5-2.6-3-4.3 1-6-1-1.2L6.2 5z" fill="#FB542B"/><path d="M12 8.4 14.6 13l-2.6 4.4L9.4 13z" fill="#fff"/>'),
    ecosia: brand('<circle cx="12" cy="12" r="10" fill="#008009"/><path d="M12.5 5.5c3.3 0 5.8 2.4 5.8 5.6 0 4.4-4 7.4-8.6 7.4-1.3 0-2.4-.2-3.4-.7 3.4-.9 5.6-3 6.6-5.6-1.4 1.3-3 2-4.8 2.1 2.3-1.6 3.7-4 4.4-8.8z" fill="#fff"/>'),
    startpage: brand('<circle cx="12" cy="12" r="10" fill="#6C57E7"/><path d="M12 6.2c2.4 0 4 1.3 4.3 3.3h-2.5c-.2-.8-.9-1.2-1.8-1.2-1 0-1.6.4-1.6 1 0 .8.9 1 2.3 1.3 2.1.4 3.8 1.1 3.8 3.3 0 2.2-1.8 3.6-4.4 3.6-2.7 0-4.4-1.4-4.6-3.5h2.5c.2.9 1 1.4 2.1 1.4 1.1 0 1.8-.4 1.8-1.2 0-.8-.9-1-2.4-1.3-2-.4-3.7-1.1-3.7-3.2 0-2.1 1.8-3.5 4.2-3.5z" fill="#fff"/>'),
    qwant: brand('<circle cx="12" cy="12" r="9" fill="#F81942"/><path d="M12 6.5a5.5 5.5 0 1 1-3.3 9.9l-2.6.9.9-2.6A5.5 5.5 0 0 1 12 6.5z" fill="#fff"/>'),
    searx: brand('<circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="#3050FF" stroke-width="2.4"/><path d="m15.5 15.5 5 5" stroke="#3050FF" stroke-width="2.6" stroke-linecap="round"/>'),
    chatgpt: brand('<path d="M12 2.6a5 5 0 0 1 4.6 3 5 5 0 0 1 3 7.6 5 5 0 0 1-4.6 7.2 5 5 0 0 1-7.5-1.2 5 5 0 0 1-3-7.6 5 5 0 0 1 4.6-7.2 5 5 0 0 1 2.9-1.8z" fill="#10A37F"/><path d="M12 8.2 15.6 10v4L12 15.8 8.4 14v-4z" fill="#fff"/>'),
    gemini: brand('<path d="M12 2c.6 4.9 4.5 8.8 9.4 9.4-4.9.6-8.8 4.5-9.4 9.4-.6-4.9-4.5-8.8-9.4-9.4C7.5 10.8 11.4 6.9 12 2z" fill="#4285F4"/>'),
    poe: brand('<circle cx="12" cy="12" r="10" fill="#5D5CDE"/><path d="M8.5 7.5h4.8a3.6 3.6 0 0 1 0 7.2H11v3.3H8.5z" fill="#fff"/>'),
    twitter: brand('<path d="M3.5 3h4.6l4.3 5.9L17.6 3h2.9l-6.6 7.6L21 21h-4.6l-4.7-6.4L6.2 21H3.3l7-8.1z" fill="#e7e7ea"/>'),
    facebook: brand('<circle cx="12" cy="12" r="10" fill="#1877F2"/><path d="M13.4 21.9V14h2.7l.5-3.4h-3.2V8.5c0-1 .3-1.6 1.7-1.6h1.6V3.9c-.3 0-1.3-.1-2.4-.1-2.4 0-4 1.5-4 4.2v2.6H7.4V14h2.9v7.9z" fill="#fff"/>'),
    firefox: brand('<circle cx="12" cy="12.5" r="9" fill="#FF7139"/><path d="M12 5.5c3.4 0 6 2.3 6 5.6 0 3.6-3 6.4-6.6 6.4-2.8 0-5-1.6-5.7-3.9 1 1.2 2.4 1.9 4.1 1.9 2.6 0 4.4-1.6 4.4-3.6 0-1.6-1-2.7-2.6-2.7-1.2 0-2 .6-2 1.5 0 .6.4 1 1 1 .4 0 .7-.2.9-.5.2 1-.6 1.8-1.7 1.8-1.3 0-2.2-1-2.2-2.5 0-2.9 2.3-5 4.4-5z" fill="#FFF44F"/>'),
    imdb: brand('<rect x="2" y="5.5" width="20" height="13" rx="2.5" fill="#F5C518"/><path d="M4.6 8.4h1.7v7.2H4.6zM7.4 8.4h2.3l.7 3.6.8-3.6h2.2v7.2h-1.5v-4.6l-.9 4.6h-1.1l-.9-4.6v4.6H7.4zM14.6 8.4h2.5c1.4 0 2.1.6 2.1 2v3.2c0 1.4-.7 2-2.1 2h-2.5zm1.7 1.3v4.6h.4c.4 0 .6-.2.6-.7v-3.2c0-.5-.2-.7-.6-.7z" fill="#000"/>'),
    metacritic: brand('<circle cx="12" cy="12" r="10" fill="#FFCC33"/><path d="M12 5.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13z" fill="#fff"/><path d="M9 9.5h1.6l1.4 3.4 1.4-3.4H15v5h-1.3v-3l-1.2 3h-1l-1.2-3v3H9z" fill="#000"/>'),
    douban: brand('<rect x="3" y="3" width="18" height="18" rx="3" fill="#2CAB5B"/><path d="M6.5 6.5h11v2h-11zM8 10h8v4.5H8zM6 16.5h12v2H6z" fill="#fff"/>'),
    pinterest: brand('<circle cx="12" cy="12" r="10" fill="#E60023"/><path d="M12.3 5.5c-3.7 0-5.6 2.5-5.6 4.7 0 1.3.5 2.5 1.6 2.9.2.1.3 0 .4-.2l.2-.7c0-.2 0-.3-.1-.5a2.9 2.9 0 0 1-.7-2c0-2 1.5-3.8 4-3.8 2.2 0 3.4 1.3 3.4 3.1 0 2.3-1 4.3-2.6 4.3-.9 0-1.5-.7-1.3-1.6.3-1.1.8-2.2.8-3 0-.7-.4-1.3-1.2-1.3-.9 0-1.7 1-1.7 2.3 0 .8.3 1.4.3 1.4l-1.1 4.6c-.3 1.4-.1 3.1 0 3.3 0 .1.2.1.2 0 .1-.1 1.3-1.6 1.7-3.1l.6-2.4c.3.6 1.2 1.1 2.2 1.1 2.9 0 4.9-2.6 4.9-6.1 0-2.6-2.2-5-5.6-5z" fill="#fff"/>'),
    wikipedia: brand('<path d="M2.2 6.2h5.2v1.1l-1.1.2c-.3.1-.4.3-.2.7l3 7 1.6-3.9-1.2-3c-.2-.5-.4-.7-.8-.8L8 7.3V6.2h4.8v1.1l-1 .2c-.4.1-.4.3-.3.7l2.8 6.8 2.6-6.6c.2-.5.1-.8-.3-.9l-1-.2V6.2h4v1.1l-.8.2c-.5.1-.7.4-1 1l-4.4 10.9h-1.2l-2.6-6-2.6 6H6L1.7 8.6c-.3-.6-.4-.9-.9-1l-.6-.2V6.2z" fill="#e7e7ea"/>'),
    tineye: brand('<circle cx="11" cy="11" r="7" fill="none" stroke="#C0272D" stroke-width="2.2"/><path d="m16 16 5 5" stroke="#C0272D" stroke-width="2.6" stroke-linecap="round"/><circle cx="11" cy="11" r="2.6" fill="#C0272D"/>'),
    vscode: brand('<path d="M17.5 2.5 21.5 4.4v15.2l-4 1.9-8.2-7.6-4.3 3.3-2-1V8.8l2-1 4.3 3.3z" fill="#0098FF"/><path d="M17.5 6.6v10.8L11 12z" fill="#fff"/>'),
    onenote: brand('<rect x="3" y="3.5" width="18" height="17" rx="2.5" fill="#7719AA"/><path d="M7.5 7.5h1.9l2.6 4.6V7.5h1.8v9h-1.8l-2.7-4.8v4.8H7.5z" fill="#fff"/>'),
    gmail: brand('<rect x="2" y="5" width="20" height="14" rx="2.5" fill="#fff"/><path d="M2 7.5 12 14 22 7.5V5.8L12 12.3 2 5.8z" fill="#EA4335"/><path d="M2 5.8 12 12.3 22 5.8V5H2z" fill="#C5221F"/>'),
  };

  /* Name -> icon. First match wins, so put the specific ones first. */
  const RULES = [
    // Actions with no favicon at all - the tiles that show clipped text.
    [/copy to markdown/i,                    GLYPH.markdown],
    [/copy target svg/i,                     GLYPH.code],
    [/copy selected|📄\s*copy|^copy\b/i,     GLYPH.copy],
    [/paste/i,                               GLYPH.paste],
    [/find in page/i,                        GLYPH.find],
    [/open text link|open the link inside/i, GLYPH.link],
    [/preview link|🔗\s*preview/i,           GLYPH.link],
    [/qrcode detection/i,                    GLYPH.lens],
    [/qr\s*code|words to qrcode/i,           GLYPH.qr],
    [/batch open/i,                          GLYPH.batch],
    [/short link|shortlink/i,                GLYPH.shortlink],
    [/decode base64/i,                       GLYPH.decode],
    [/encode base64/i,                       GLYPH.encode],
    [/batch replace/i,                       GLYPH.replace],
    [/preview video/i,                       GLYPH.video],
    [/preview audio/i,                       GLYPH.audio],
    [/preview image/i,                       GLYPH.picture],
    [/preview wikipedia/i,                   BRAND.wikipedia],
    [/save archive|web archive/i,            GLYPH.archive],
    [/search cache/i,                        GLYPH.cache],
    [/edit current page/i,                   GLYPH.edit],
    [/open url/i,                            GLYPH.openUrl],
    [/cheap vps/i,                           GLYPH.server],
    [/cheap domain/i,                        GLYPH.domain],
    [/mainonly/i,                            GLYPH.book],
    [/remove bg/i,                           GLYPH.removebg],
    [/translate/i,                           GLYPH.translate],
    [/calculator|🧮/i,                       GLYPH.calc],
    [/everything|🔎/i,                       GLYPH.everything],
    [/clock|⏰/i,                            GLYPH.clock],
    [/screenclip|✂️/i,                       GLYPH.clip],
    [/todo|☑️/i,                             GLYPH.todo],
    [/send to phone|📱/i,                    GLYPH.phone],
    [/send by gmail/i,                       BRAND.gmail],
    [/share to twitter/i,                    BRAND.twitter],
    [/share to facebook/i,                   BRAND.facebook],
    [/show all engines/i,                    GLYPH.listAlt],
    [/usd to rmb|💲/i,                       GLYPH.calc],
    [/lunapic|editor/i,                      GLYPH.picture],

    // Search engines - their own favicons are the low-res ones.
    [/google lens/i,                         GLYPH.lens],
    [/google image|google search by image/i, BRAND.google],
    [/^google|google advanced|google search in site/i, BRAND.google],
    [/duckduckgo/i,                          BRAND.duckduckgo],
    [/startpage/i,                           BRAND.startpage],
    [/ecosia/i,                              BRAND.ecosia],
    [/qwant/i,                               BRAND.qwant],
    [/searx/i,                               BRAND.searx],
    [/brave/i,                               BRAND.brave],
    [/yandex/i,                              BRAND.yandex],
    [/baidu/i,                               BRAND.baidu],
    [/yahoo/i,                               BRAND.yahoo],
    [/bing/i,                                BRAND.bing],
    [/chatgpt|search gif by chatgpt/i,       BRAND.chatgpt],
    [/gemini|bard/i,                         BRAND.gemini],
    [/poe\b/i,                               BRAND.poe],
    [/futurepedia/i,                         GLYPH.robot],
    [/imdb/i,                                BRAND.imdb],
    [/metacritic/i,                          BRAND.metacritic],
    [/douban/i,                              BRAND.douban],
    [/pinterest/i,                           BRAND.pinterest],
    [/tineye/i,                              BRAND.tineye],
    [/firefox|🦊/i,                          BRAND.firefox],
    [/vscode|⌨️/i,                           BRAND.vscode],
    [/onenote|📓/i,                          BRAND.onenote],
    // Last: only for a "... rating" entry with no brand of its own above.
    [/rating/i,                              GLYPH.star],
  ];

  // Group buttons carry the group name in dataset.type.
  const GROUP = [
    [/^search in page$/i, GLYPH.sitemap],
    [/^search by image$/i, GLYPH.eye],
    [/^search$/i,   GLYPH.search],
    [/^image$/i,    GLYPH.image],
    [/^page$/i,     GLYPH.list],
    [/^ai$/i,       GLYPH.robot],
    [/^assit|assist$/i, GLYPH.listAlt],
  ];

  const pick = (rules, name) => {
    for (const [re, svg] of rules) if (re.test(name)) return svg;
    return null;
  };

  /* ── Favicon upgrade ──────────────────────────────────────────────────
     SearchJumper asks for <origin>/favicon.ico, which is usually 16 or 32px
     and looks soft the moment it is scaled to a 26px tile on a HiDPI screen.
     Try genuinely larger sources first and only accept one that is bigger. */

  const iconCache = new Map();

  function bestIcon(host) {
    if (iconCache.has(host)) return iconCache.get(host);
    const candidates = [
      `https://${host}/apple-touch-icon.png`,
      `https://${host}/apple-touch-icon-precomposed.png`,
      `https://www.google.com/s2/favicons?sz=128&domain=${host}`,
    ];
    const p = new Promise((resolve) => {
      let i = 0;
      const tryNext = () => {
        if (i >= candidates.length) return resolve(null);
        const url = candidates[i++];
        const probe = new Image();
        probe.referrerPolicy = "no-referrer";
        probe.onload = () => (probe.naturalWidth >= 48 ? resolve(url) : tryNext());
        probe.onerror = tryNext;
        probe.src = url;
      };
      tryNext();
    });
    iconCache.set(host, p);
    return p;
  }

  async function upgrade(img) {
    const src = img.src || img.dataset.src || "";
    if (!/\/favicon\.ico(\?|$)/i.test(src)) return;
    let host;
    try { host = new URL(src).hostname; } catch { return; }
    const better = await bestIcon(host);
    if (better) {
      img.src = better;
      img.dataset.telaUpgraded = "1";
    }
  }

  /* ── Applying icons to tiles ─────────────────────────────────────────── */

  function skinTile(a) {
    if (a.dataset.telaSkinned) return;
    const name = a.dataset.name || a.title || "";
    if (!name) return;
    a.dataset.telaSkinned = "1";

    const cfg = siteCfg();
    // Preferred engines float to the front via CSS order, never by moving nodes.
    if (cfg.prefer && cfg.prefer.some(n => n.toLowerCase() === name.toLowerCase())) {
      a.dataset.telaPrefer = "1";
    }

    // A per-site icon override wins over the global rules.
    const over = cfg.icons && cfg.icons[name];
    const svg = (over && (GLYPH[over] || BRAND[over] || over)) || pick(RULES, name);
    if (svg) {
      const holder = document.createElement("span");
      holder.className = "tela-sj-icon";
      holder.innerHTML = svg;
      a.dataset.telaGlyph = "1";
      a.classList.remove("search-jumper-word");
      a.prepend(holder);
      return;
    }

    const img = a.querySelector("img");
    if (img) { upgrade(img); return; }

    // Nothing drawn and no favicon: a real lettermark beats clipped text.
    const letter = (name.replace(/[^\p{L}\p{N}]/gu, "")[0] || "?").toUpperCase();
    const holder = document.createElement("span");
    holder.className = "tela-sj-icon tela-sj-letter";
    holder.textContent = letter;
    a.classList.remove("search-jumper-word");
    a.prepend(holder);
  }

  function skinGroup(t) {
    if (t.dataset.telaSkinned) return;
    const type = t.dataset.type || t.dataset.title || "";
    const svg = pick(GROUP, type);
    if (!svg) return;
    t.dataset.telaSkinned = "1";
    const first = t.querySelector(".search-jumper-btn");
    if (!first) return;
    const holder = document.createElement("span");
    holder.className = "tela-sj-icon";
    holder.innerHTML = svg;
    first.dataset.telaGlyph = "1";
    first.classList.remove("search-jumper-word");
    first.prepend(holder);
  }

  function sweep(root) {
    root.querySelectorAll("a.search-jumper-btn").forEach(skinTile);
    root.querySelectorAll(".search-jumper-type").forEach(skinGroup);
  }

  /* ── Placement ────────────────────────────────────────────────────────
     SearchJumper keeps ONE global position for every site. Three layers here,
     strongest first: a position you dragged and it remembered for this host, a
     per-site preset, then live collision avoidance when the page covers it. */

  const posKey = "telaPos:" + location.hostname;

  /* Per-site config, first match wins. side/y = where the free gutter is;
     accent = bar tint; prefer = engines pulled to the front; icons = per-site
     glyph overrides (a GLYPH/BRAND key, or raw SVG). Dragging still wins. */
  const SITE_POSITIONS = [
    // The movie sites and YT Music pull their own group (Movies & music) forward.
    [/(^|\.)moflix-stream\.xyz$/i,           { side: "right", y: "middle", prefer: ["moflix", "megakino", "Watched"] }],
    [/(^|\.)megakino\d*\.[a-z]+$/i,          { side: "right", y: "middle", prefer: ["megakino", "moflix", "Watched"] }],
    [/(^|\.)kinoger\.com$/i,                { side: "right", y: "middle", prefer: ["kinoger", "moflix", "Watched"] }],
    [/(^|\.)s\.to$/i,                      { side: "right", y: "middle", prefer: ["s.to", "moflix", "Watched"] }],
    [/(^|\.)filmpalast\.to$/i,             { side: "right", y: "middle", prefer: ["filmpalast", "moflix", "Watched"] }],
    [/^music\.youtube\.com$/i,               { side: "right", y: "middle", accent: "#ff0033", prefer: ["YT Music", "YouTube"] }],
    [/(^|\.)youtube\.com$/i,                 { side: "right", y: "middle", accent: "#ff0033" }],
    [/(^|\.)twitch\.tv$/i,                   { side: "right", y: "middle", accent: "#9147ff" }],
    [/(^|\.)netflix\.com$/i,                 { side: "right", y: "top" }],
    [/(^|\.)google\.[a-z.]+$/i,              { side: "right", y: "middle" }],
    [/(^|\.)(mail|drive|docs)\.google\.com$/i, { side: "right", y: "bottom" }],
    [/(^|\.)github\.com$/i,                  { side: "right", y: "middle", accent: "#8b949e",
                                               prefer: ["Google", "SearX", "DuckDuckGo"] }],
    [/(^|\.)stackoverflow\.com$/i,           { side: "left",  y: "middle", accent: "#f48024",
                                               prefer: ["Google", "SearX"] }],
    [/(^|\.)reddit\.com$/i,                  { side: "right", y: "middle", accent: "#ff4500" }],
    [/(^|\.)(x|twitter)\.com$/i,             { side: "left",  y: "bottom" }],
    [/(^|\.)wikipedia\.org$/i,               { side: "right", y: "middle", accent: "#a2a9b1" }],
    [/(^|\.)amazon\.[a-z.]+$/i,              { side: "right", y: "middle" }],
    [/(^|\.)linkedin\.com$/i,                { side: "right", y: "middle" }],
    [/(^|\.)instagram\.com$/i,               { side: "right", y: "middle", accent: "#e1306c",
                                               prefer: ["Google Search by image", "TinEye", "Yandex image"] }],
    // Image sites: reverse-image lookups first.
    [/(^|\.)(pixiv\.net|deviantart\.com|flickr\.com|500px\.com|unsplash\.com)$/i,
                                             { side: "right", y: "middle", accent: "#8a4ae0",
                                               prefer: ["Google Search by image", "TinEye", "WhatAnime", "Yandex image"] }],
    // AI sites put a composer along the bottom and a rail on the left.
    [/(^|\.)(chatgpt\.com|chat\.openai\.com)$/i, { side: "right", y: "middle", accent: "#10a37f",
                                               prefer: ["Bard", "Poe - Sage AI Chat"] }],
    [/(^|\.)claude\.ai$/i,                   { side: "right", y: "middle", accent: "#d97757",
                                               prefer: ["ChatGPT", "Bard", "Poe - Sage AI Chat"] }],
    [/(^|\.)gemini\.google\.com$/i,          { side: "right", y: "middle" }],
    [/(^|\.)(grok\.com|grok\.x\.ai)$/i,      { side: "right", y: "middle" }],
    [/(^|\.)chat\.deepseek\.com$/i,          { side: "right", y: "middle" }],
    [/(^|\.)perplexity\.ai$/i,               { side: "right", y: "middle" }],
  ];

  const GAP = 8;
  // Tried in order when the chosen spot turns out to be covered.
  const FALLBACKS = [
    { side: "right", y: "middle" }, { side: "left", y: "middle" },
    { side: "right", y: "bottom" }, { side: "left", y: "bottom" },
    { side: "right", y: "top" },    { side: "left", y: "top" },
  ];

  function presetFor() {
    for (const [re, place] of SITE_POSITIONS) {
      if (re.test(location.hostname)) return place;
    }
    return null;
  }

  // Hoisted and memoised: skinTile reads this before the table is declared.
  let _siteCfg;
  function siteCfg() {
    if (_siteCfg === undefined) _siteCfg = presetFor() || {};
    return _siteCfg;
  }

  function applySiteLook(root) {
    const cfg = siteCfg();
    if (!cfg.accent) return;
    const host = root.querySelector("#search-jumper") || root;
    host.style.setProperty("--tela-accent", cfg.accent);
  }

  function applyPlacement(bar, place) {
    const st = bar.style;
    st.setProperty("position", "fixed", "important");
    if (place.side === "right") {
      st.setProperty("right", GAP + "px", "important");
      st.setProperty("left", "auto", "important");
    } else {
      st.setProperty("left", GAP + "px", "important");
      st.setProperty("right", "auto", "important");
    }
    if (place.y === "middle") {
      st.setProperty("top", "50%", "important");
      st.setProperty("bottom", "auto", "important");
      st.setProperty("transform", "translateY(-50%)", "important");
    } else if (place.y === "bottom") {
      st.setProperty("bottom", GAP + "px", "important");
      st.setProperty("top", "auto", "important");
      st.setProperty("transform", "none", "important");
    } else {
      st.setProperty("top", GAP + "px", "important");
      st.setProperty("bottom", "auto", "important");
      st.setProperty("transform", "none", "important");
    }
  }

  /* The bar sits in a shadow host, so elementFromPoint returns that host when
     nothing covers it - anything else on top means the site is in the way. */
  function occluded(bar, host) {
    const r = bar.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const pts = [
      [r.left + 5, r.top + 6],
      [r.left + r.width / 2, r.top + r.height / 2],
      [r.left + 5, r.bottom - 6],
      [r.right - 5, r.top + r.height / 2],
    ];
    let covered = 0;
    for (const [x, y] of pts) {
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) { covered++; continue; }
      const top = document.elementFromPoint(x, y);
      if (top && top !== host && !host.contains(top)) covered++;
    }
    return covered >= 2;
  }

  function reposition(bar, host) {
    if (!bar || bar.classList.contains("grabbing")) return;
    const saved = store.get(posKey, null);
    if (saved && !saved.auto) {
      for (const [k, v] of Object.entries(saved)) {
        if (k !== "auto") bar.style.setProperty(k, v, "important");
      }
      if (!occluded(bar, host)) return;
    }
    const first = presetFor();
    for (const place of first ? [first, ...FALLBACKS] : FALLBACKS) {
      applyPlacement(bar, place);
      if (!occluded(bar, host)) return;
    }
  }

  function watchPosition(bar) {
    let timer = null;
    const save = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const st = bar.style;
        const keep = {};
        for (const k of ["top", "left", "right", "bottom", "transform"]) {
          if (st[k]) keep[k] = st[k];
        }
        // Only a real drag counts as a choice worth remembering.
        if (Object.keys(keep).length) store.set(posKey, keep);
      }, 400);
    };
    bar.addEventListener("mouseup", save);
  }

  /* React to the page moving under the bar: layout shifts, panels opening,
     route changes in single-page apps. Debounced so busy sites stay cheap. */
  function watchPage(bar, host) {
    let timer = null;
    const ping = (why) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        reposition(bar, host);
        try {
          window.dispatchEvent(new CustomEvent("tela-sj-page-changed", { detail: { why } }));
        } catch {}
      }, 200);
    };

    if (document.body) {
      new MutationObserver(() => ping("dom")).observe(document.body, {
        childList: true, subtree: true,
        attributes: true, attributeFilter: ["style", "class", "hidden"],
      });
    }
    try { new ResizeObserver(() => ping("resize")).observe(document.documentElement); } catch {}
    addEventListener("resize", () => ping("viewport"), { passive: true });
    addEventListener("scroll", () => ping("scroll"), { passive: true });

    // SPA route changes never fire a navigation event.
    let href = location.href;
    setInterval(() => {
      if (location.href !== href) { href = location.href; ping("route"); }
    }, 700);

    // Extension point: telaSJ.onPageChange(fn) to react to page motion.
    try {
      window.telaSJ = {
        onPageChange: (fn) => addEventListener("tela-sj-page-changed", fn),
        reposition: () => reposition(bar, host),
        place: (side, y) => applyPlacement(bar, { side, y }),
        isCovered: () => occluded(bar, host),
      };
    } catch {}
  }


  /* ── AI sites ─────────────────────────────────────────────────────────
     Nothing below runs anywhere else: aiSite() returns null and initAI exits
     before it touches the DOM, binds a listener or fetches anything. Selectors
     on these sites change often, so each has a generic fallback. */

  const AI_SITES = [
    [/(^|\.)(chatgpt\.com|chat\.openai\.com)$/i, {
      name: "ChatGPT",
      composer: "#prompt-textarea, form div[contenteditable='true']",
      message: "[data-message-author-role]",
      answer: "[data-message-author-role='assistant']",
      roleAttr: "data-message-author-role",
    }],
    [/(^|\.)claude\.ai$/i, {
      name: "Claude",
      composer: "div[contenteditable='true'].ProseMirror, div[contenteditable='true']",
      message: "[data-testid='user-message'], .font-claude-message, .font-claude-response",
      answer: ".font-claude-message, .font-claude-response",
    }],
    [/(^|\.)gemini\.google\.com$/i, {
      name: "Gemini",
      composer: "rich-textarea div[contenteditable='true'], div[contenteditable='true']",
      message: "user-query, model-response",
      answer: "model-response",
    }],
    [/(^|\.)(grok\.com|grok\.x\.ai)$/i, {
      name: "Grok",
      composer: "textarea, div[contenteditable='true']",
      message: "[class*='message']",
      answer: "[class*='response'], [class*='assistant']",
    }],
    [/(^|\.)chat\.deepseek\.com$/i, {
      name: "DeepSeek",
      composer: "textarea#chat-input, textarea",
      message: "[class*='message'], .ds-markdown",
      answer: ".ds-markdown",
    }],
    [/(^|\.)perplexity\.ai$/i, {
      name: "Perplexity",
      composer: "textarea, div[contenteditable='true']",
      message: ".prose",
      answer: ".prose",
    }],
  ];

  function aiSite() {
    for (const [re, cfg] of AI_SITES) if (re.test(location.hostname)) return cfg;
    return null;
  }

  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 30 && r.height > 10;
  };

  function findComposer(cfg) {
    for (const el of document.querySelectorAll(cfg.composer)) if (visible(el)) return el;
    // Fallback: the biggest visible editable box on the page.
    let best = null, area = 0;
    for (const el of document.querySelectorAll("textarea, div[contenteditable='true']")) {
      const r = el.getBoundingClientRect();
      if (r.width * r.height > area && visible(el)) { area = r.width * r.height; best = el; }
    }
    return best;
  }

  const copy = (text) => {
    try { return navigator.clipboard.writeText(text); } catch {}
    try { if (typeof GM_setClipboard === "function") GM_setClipboard(text); } catch {}
  };

  function answers(cfg) {
    return [...document.querySelectorAll(cfg.answer)].filter(visible);
  }

  function chatAsMarkdown(cfg) {
    const out = [];
    for (const el of document.querySelectorAll(cfg.message)) {
      if (!visible(el)) continue;
      const role = cfg.roleAttr ? el.getAttribute(cfg.roleAttr) : null;
      const who = role ? (role === "user" ? "You" : "Assistant")
                       : (el.matches(cfg.answer) ? "Assistant" : "You");
      const text = (el.innerText || "").trim();
      if (text) out.push("## " + who + "\n\n" + text);
    }
    return out.join("\n\n---\n\n");
  }

  function insertIntoComposer(cfg, text) {
    const box = findComposer(cfg);
    if (!box || !text) return false;
    box.focus();
    if (box.tagName === "TEXTAREA") {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(box, (box.value ? box.value + "\n" : "") + text);
      box.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      // React-backed contenteditable only trusts a real paste.
      document.execCommand("insertText", false, text);
    }
    return true;
  }

  const AI_ACTIONS = [
    { key: "insert", title: "Insert selection into the prompt", glyph: GLYPH.paste,
      run: (cfg) => insertIntoComposer(cfg, String(getSelection() || "").trim()) },
    { key: "answer", title: "Copy the last answer", glyph: GLYPH.copy,
      run: (cfg) => { const a = answers(cfg).pop(); if (a) copy((a.innerText || "").trim()); } },
    { key: "chat", title: "Copy the whole chat as Markdown", glyph: GLYPH.markdown,
      run: (cfg) => copy(chatAsMarkdown(cfg)) },
    { key: "latest", title: "Jump to the latest answer", glyph: GLYPH.openUrl,
      run: (cfg) => { const a = answers(cfg).pop();
                      if (a) a.scrollIntoView({ behavior: "smooth", block: "center" }); } },
  ];

  /* Our own classes throughout: SearchJumper queries a.search-jumper-btn for
     its own logic, so reusing that class would feed it elements it did not
     build. These are styled to match instead. */
  function buildAIGroup(bar, cfg) {
    if (bar.querySelector(".tela-sj-ai-group")) return;
    const group = document.createElement("div");
    group.className = "tela-sj-ai-group";
    group.title = cfg.name;
    for (const act of AI_ACTIONS) {
      const b = document.createElement("button");
      b.className = "tela-sj-ai-btn";
      b.title = act.title;
      b.innerHTML = '<span class="tela-sj-icon">' + act.glyph + "</span>";
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        try { act.run(cfg); } catch (ex) { console.warn("[tela ai] " + act.key, ex); }
      });
      group.append(b);
    }
    bar.append(group);
  }

  /* Streaming detection: the last answer keeps growing while the model writes,
     then stops. Reported as events so you can react to it. */
  function watchAI(cfg) {
    let last = "";
    let busy = false;
    let idle = null;
    const emit = (phase) => {
      try {
        window.dispatchEvent(new CustomEvent("tela-sj-ai", {
          detail: { phase, site: cfg.name },
        }));
      } catch {}
    };
    setInterval(() => {
      const a = answers(cfg).pop();
      const text = a ? (a.innerText || "") : "";
      if (text !== last) {
        last = text;
        if (!busy) { busy = true; emit("streaming"); }
        clearTimeout(idle);
        idle = setTimeout(() => { busy = false; emit("idle"); }, 900);
      }
    }, 500);
  }

  function initAI(bar) {
    const cfg = aiSite();
    if (!cfg) return null;
    buildAIGroup(bar, cfg);
    watchAI(cfg);
    return {
      site: cfg.name,
      composer: () => findComposer(cfg),
      insert: (t) => insertIntoComposer(cfg, t),
      lastAnswer: () => { const a = answers(cfg).pop(); return a ? a.innerText.trim() : null; },
      copyChat: () => copy(chatAsMarkdown(cfg)),
      onEvent: (fn) => addEventListener("tela-sj-ai", fn),
    };
  }


  /* ── Wire up ──────────────────────────────────────────────────────────── */

  /* Everything lives in the shadow root, so both the stylesheet and the icon
     sweep have to go in there - nothing on the page reaches it. */
  function shadowRoot() {
    const host = document.querySelector(HOST);
    if (host && host.shadowRoot) return host.shadowRoot;
    const list = (window.wrappedJSObject || window).__telaShadows;
    if (list) {
      for (const r of list) {
        try { if (r.querySelector("#search-jumper-root")) return r; } catch {}
      }
    }
    return null;
  }

  function styleShadow(root) {
    if (root.querySelector("style[data-tela-skin]")) return;
    const st = document.createElement("style");
    st.setAttribute("data-tela-skin", "1");
    st.textContent = css;
    root.appendChild(st);
  }

  let bound = false;
  let warned = false;
  function bind() {
    const root = shadowRoot();
    if (!root) return;
    styleShadow(root);
    applySiteLook(root);
    sweep(root);
    if (bound) return;
    /* Mutations inside a shadow root do not reach an observer on the document,
       so the root needs its own or later tiles never get skinned. */
    new MutationObserver(() => sweep(root)).observe(root, {
      childList: true, subtree: true,
    });
    const bar = root.querySelector(".search-jumper-searchBar");
    const host = document.querySelector(HOST);
    if (bar && host) {
      reposition(bar, host);
      watchPosition(bar);
      watchPage(bar, host);
      // Returns null off an AI site, having done nothing at all.
      const ai = initAI(bar);
      if (ai) { try { window.telaSJ.ai = ai; } catch {} }
    }
    bound = true;
  }

  new MutationObserver(() => bind()).observe(document.documentElement, {
    childList: true, subtree: true,
  });
  document.addEventListener("DOMContentLoaded", bind);
  const poll = setInterval(bind, 500);
  setTimeout(() => {
    clearInterval(poll);
    if (!shadowRoot() && !warned) {
      warned = true;
      console.warn(
        "[tela skin] SearchJumper's shadow root stayed closed - this script " +
        "must run BEFORE SearchJumper. Move it above SearchJumper in the " +
        "MonkeyStyles dashboard, or the page's CSP blocked the inline patch."
      );
    }
  }, 15000);

  /* ── Styling ──────────────────────────────────────────────────────────
     Matches the Zen tab pill: one radius, one surface, one stroke weight.
     SearchJumper sets several of these inline or with !important, so the
     overrides have to be at least as loud. */

  const css = `
    /* The pale strip behind the tiles is the container and the per-group
       boxes, not the bar - all three need flattening or the bar stays light. */
    #search-jumper,
    #search-jumper .search-jumper-type {
      background: transparent !important;
      background-image: none !important;
      box-shadow: none !important;
      border: none !important;
    }
    #search-jumper .search-jumper-type {
      border-radius: 13px !important;
    }

    /* On the root, not the bar: the engine-list panel is a sibling of the bar. */
    #search-jumper-root, #search-jumper {
      --tela-bg: rgba(28, 28, 32, 0.86);
      --tela-el: rgba(255, 255, 255, 0.07);
      --tela-el-hover: rgba(255, 255, 255, 0.14);
      --tela-fg: #e7e7ea;
      --tela-accent: #7aa2f7;
      --tela-radius: 11px;
    }

    #search-jumper .search-jumper-searchBar {
      background: var(--tela-bg) !important;
      border: 1px solid rgba(255, 255, 255, 0.08) !important;
      border-radius: 16px !important;
      backdrop-filter: blur(18px) saturate(1.2);
      box-shadow: 0 8px 28px rgba(0, 0, 0, 0.42) !important;
      padding: 5px !important;
    }

    /* One tile shape for everything - the mix of black circles, white
       circles and blue squares was most of why this read as unfinished. */
    /* No padding or margin overrides here: SearchJumper sizes tiles with
       box-sizing:content-box and computes the bar around 32px, so extra
       padding is ADDED and pushes icons off-centre into the bar edge. */
    /* Dock-style magnification: on mousemove SearchJumper sets --scale inline
       up to 1.2 on the hovered tile and two neighbours each side, and the tile
       is width:calc(32px * var(--scale)) - so the bar itself grows. An author
       !important custom property outranks their inline one. */
    #search-jumper .search-jumper-btn {
      --scale: 1 !important;
      background: var(--tela-el) !important;
      background-image: none !important;
      border-radius: var(--tela-radius) !important;
      border: 1px solid transparent !important;
      box-shadow: none !important;
      filter: none !important;
      color: var(--tela-fg) !important;
      place-items: center !important;
      overflow: visible !important;
      transition: background-color 0.15s ease-in-out, border-color 0.15s ease-in-out !important;
    }

    /* Every child shares one grid cell, so a hidden label cannot shift the
       icon, and margin:auto centres whatever is visible. */
    #search-jumper .search-jumper-btn > img,
    #search-jumper .search-jumper-btn > span,
    #search-jumper .search-jumper-btn > div {
      grid-area: 1 / 1 !important;
      margin: auto !important;
    }

    /* The label is a bare <span> holding name.substr(0,4) - the "Chea"/"Main"
       text and the colour emoji. Hidden, never removed: SearchJumper keeps
       live references to these nodes and deleting them breaks its icon cache. */
    #search-jumper .search-jumper-btn[data-tela-glyph] > span:not(.tela-sj-icon),
    #search-jumper .search-jumper-btn[data-tela-glyph] > img,
    #search-jumper .search-jumper-btn[data-tela-glyph] > font {
      display: none !important;
    }
    #search-jumper .search-jumper-btn:hover {
      background: var(--tela-el-hover) !important;
      border-color: rgba(255, 255, 255, 0.14) !important;
    }

    /* Nothing grows, ever. SearchJumper magnifies tiles two separate ways:
       --scale written inline on mousemove (dock style, spreading to
       neighbours) and transform:scale(1.1) on :hover and :active. */
    #search-jumper .search-jumper-btn,
    #search-jumper .search-jumper-btn:hover,
    #search-jumper .search-jumper-btn:active,
    #search-jumper .search-jumper-btn:focus,
    #search-jumper .search-jumper-type:hover > .search-jumper-btn {
      --scale: 1 !important;
      transform: none !important;
      -webkit-transform: none !important;
      scale: 1 !important;
      zoom: 1 !important;
    }

    #search-jumper .search-jumper-btn:hover > img,
    #search-jumper .search-jumper-btn:active > img,
    #search-jumper .search-jumper-btn:hover > div > img,
    #search-jumper .search-jumper-btn:hover > .tela-sj-icon > svg {
      transform: none !important;
      -webkit-transform: none !important;
      scale: 1 !important;
    }
    #search-jumper .search-jumper-btn[data-current] {
      background: color-mix(in srgb, var(--tela-accent) 26%, transparent) !important;
      border-color: color-mix(in srgb, var(--tela-accent) 45%, transparent) !important;
    }

    #search-jumper .tela-sj-icon {
      display: grid;
      place-items: center;
      width: 100%;
      height: 100%;
      color: var(--tela-fg);
    }
    #search-jumper .tela-sj-icon > svg {
      width: 74%;
      height: 74%;
      display: block;
      /* Vectors, so no drop-shadow smearing them at 26px. */
      shape-rendering: geometricPrecision;
    }
    #search-jumper .tela-sj-letter {
      font: 600 13px/1 system-ui, sans-serif;
      letter-spacing: 0.02em;
      opacity: 0.85;
    }

    /* Upgraded favicons: rounded, padded and lifted so bitmaps sit at the
       same visual weight as the vectors beside them. */
    #search-jumper .search-jumper-btn > img,
    #search-jumper .search-jumper-btn > div > img {
      border-radius: 6px !important;
      width: 72% !important;
      height: 72% !important;
      max-width: 72% !important;
      max-height: 72% !important;
      object-fit: contain;
      filter: contrast(1.06) saturate(1.05) !important;
    }

    /* Kill the blinking overlay (changeOpacity, 3 x 2s) and the size-jump
       transition; both are what read as dated motion. */
    #search-jumper .search-jumper-btn > div,
    #search-jumper .search-jumper-btn::before,
    #search-jumper .search-jumper-btn::after {
      animation: none !important;
    }
    #search-jumper .search-jumper-type,
    #search-jumper .search-jumper-type > a.search-jumper-btn {
      transition: background-color 0.15s ease-in-out !important;
    }

    /* AI group: our own elements, styled to match SearchJumper's tiles. */
    #search-jumper .tela-sj-ai-group {
      display: flex;
      flex-wrap: wrap;
      align-content: flex-start;
      justify-content: center;
      gap: 3px;
      margin-top: 6px;
      padding-top: 6px;
      border-top: 1px solid rgba(255, 255, 255, 0.1);
    }
    #search-jumper .tela-sj-ai-btn {
      appearance: none;
      background: var(--tela-el, rgba(255, 255, 255, 0.07));
      border: 1px solid transparent;
      border-radius: var(--tela-radius, 11px);
      color: var(--tela-fg, #e7e7ea);
      cursor: pointer;
      display: grid;
      place-items: center;
      height: 30px;
      width: 30px;
      padding: 0;
      transition: background-color 0.15s ease-in-out, border-color 0.15s ease-in-out;
    }
    #search-jumper .tela-sj-ai-btn:hover {
      background: var(--tela-el-hover, rgba(255, 255, 255, 0.14));
      border-color: rgba(255, 255, 255, 0.14);
    }
    #search-jumper .tela-sj-ai-btn > .tela-sj-icon > svg {
      width: 17px;
      height: 17px;
    }

    /* Preferred engines for this site: pulled forward, ringed in the accent. */
    #search-jumper .search-jumper-btn[data-tela-prefer] {
      order: -1 !important;
      border-color: color-mix(in srgb, var(--tela-accent) 55%, transparent) !important;
    }

    /* Engine list, given the same surface as the bar. */
    #search-jumper .sitelist {
      background: var(--tela-bg) !important;
      border: 1px solid rgba(255, 255, 255, 0.09) !important;
      border-radius: 14px !important;
      box-shadow: 0 12px 34px rgba(0, 0, 0, 0.5) !important;
      backdrop-filter: blur(20px) saturate(1.2);
      padding: 5px !important;
    }

    /* Section heading, not a centred bold title. */
    #search-jumper .sitelist > .sitelistCon > p {
      font: 600 10.5px/1 system-ui, sans-serif !important;
      letter-spacing: 0.14em !important;
      text-transform: uppercase !important;
      opacity: 0.5 !important;
      margin: 0 !important;
      padding: 7px 9px 5px !important;
      text-align: left !important;
    }

    #search-jumper .sitelist .sitelistCon > div {
      border-radius: 9px !important;
      margin: 1px 0 !important;
      padding: 0 !important;
      transition: background-color 0.13s ease-in-out !important;
    }

    #search-jumper .sitelist .sitelistCon > div:hover {
      background: var(--tela-el-hover) !important;
      transform: none !important;
    }

    #search-jumper .sitelist .sitelistCon a {
      align-items: center !important;
      display: flex !important;
      gap: 10px !important;
      padding: 5px 9px !important;
      border-radius: 9px !important;
      text-decoration: none !important;
    }

    #search-jumper .sitelist .sitelistCon a > div,
    #search-jumper .sitelist .sitelistCon a > div > img,
    #search-jumper .sitelist .sitelistCon a > img {
      border-radius: 5px !important;
      flex: 0 0 auto !important;
      height: 19px !important;
      width: 19px !important;
      margin: 0 !important;
      object-fit: contain;
      transform: none !important;
    }

    #search-jumper .sitelist .sitelistCon a > p,
    #search-jumper .sitelist .sitelistCon > div > p {
      color: var(--tela-fg) !important;
      font: 500 13px/1.25 system-ui, sans-serif !important;
      margin: 0 !important;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* Tooltip, matched to the bar rather than a floating white slab. */
    #search-jumper .search-jumper-tips {
      background: var(--tela-bg, rgba(28, 28, 32, 0.94)) !important;
      color: #e7e7ea !important;
      border: 1px solid rgba(255, 255, 255, 0.1) !important;
      border-radius: 9px !important;
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4) !important;
      font: 500 12px/1.35 system-ui, sans-serif !important;
      padding: 6px 9px !important;
      text-shadow: none !important;
      animation: none !important;
    }

    @media (prefers-color-scheme: light) {
      #search-jumper-root, #search-jumper {
        --tela-bg: rgba(250, 250, 252, 0.9);
        --tela-el: rgba(0, 0, 0, 0.05);
        --tela-el-hover: rgba(0, 0, 0, 0.1);
        --tela-fg: #26262b;
      }
    }
  `;

  try { GM_addStyle(css); }
  catch {
    const el = document.createElement("style");
    el.textContent = css;
    (document.head || document.documentElement).append(el);
  }
})();
