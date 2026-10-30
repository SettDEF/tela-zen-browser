/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Urlbar button showing which engine a search will use, and a panel to
   change it. The mark is drawn here rather than taken from the engine's own
   favicon, so every engine reads at the same weight and size. */

const HTML_NS = "http://www.w3.org/1999/xhtml";

/* Firefox 154 dropped @mozilla.org/browser/search-service;1, so Services.search
   is undefined here - the service is an ESM singleton now. */
const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SearchService: "moz-src:///toolkit/components/search/SearchService.sys.mjs",
});

/* Hue per engine, matched loosely on name; anything unknown takes the
   browser accent. Purely a tint for our own glyph. */
const TINTS = [
  [/google/i, "#4a7fe0"],
  [/duckduckgo|ddg/i, "#e8823f"],
  [/bing/i, "#3fc4d4"],
  [/brave/i, "#ff5a3c"],
  [/startpage/i, "#5f5fe0"],
  [/ecosia/i, "#3fd48a"],
  [/yandex/i, "#e74c4c"],
  [/wikipedia/i, "#9aa0aa"],
  [/mojeek|marginalia|searx/i, "#b06cd0"],
];

window.gZenSearchEngine = {
  _button: null,
  _panel: null,

  init() {
    if (this._inited) {
      return;
    }
    this._inited = true;
    this._build();
    this.refresh();
    new MutationObserver(() => this._place()).observe(document.documentElement, {
      attributes: true, attributeFilter: ["zen-layout"],
    });
    this._place();
    Services.obs.addObserver(this, "browser-search-engine-modified");
    Services.obs.addObserver(this, "browser-search-service");
  },

  observe() {
    this.refresh();
  },

  async engine() {
    try {
      return await lazy.SearchService.getDefault();
    } catch {
      return null;
    }
  },

  /* One accent for every engine, taken from the theme, so the chip matches
     whatever colour is chosen in settings instead of a hardcoded hue. */
  tintFor() {
    return "currentColor";
  },

  /* One drawn mark per engine, chosen for what the engine is about rather
     than copying anyone's logo: a shield for the privacy ones, a leaf for
     the tree planter, a book for the encyclopaedia. Stroke-based so they
     stay crisp at 16px and take the tint. */
  glyphFor(name = "") {
    const n = name.toLowerCase();
    if (/duckduckgo|ddg|startpage|mullvad/.test(n)) {
      // shield
      return '<path d="M8 1.9 13 3.6v4.1c0 3-2 5.2-5 6.4-3-1.2-5-3.4-5-6.4V3.6z"/>';
    }
    if (/brave/.test(n)) {
      // shield with a notch
      return '<path d="M8 1.9 13 3.6v4.1c0 3-2 5.2-5 6.4-3-1.2-5-3.4-5-6.4V3.6z"/><path d="M8 5v4"/>';
    }
    if (/ecosia/.test(n)) {
      // leaf
      return '<path d="M13 3c0 5.5-3.2 8.6-7.4 8.6H4C4 6.6 7.6 3 13 3z"/><path d="M4 13c1.6-3 4-5.2 7-6.4"/>';
    }
    if (/wikipedia|wiki/.test(n)) {
      // open book
      return '<path d="M2.4 3.6h4A2 2 0 0 1 8 4.4a2 2 0 0 1 1.6-.8h4v8h-4a2 2 0 0 0-1.6.8 2 2 0 0 0-1.6-.8h-4z"/><path d="M8 4.4v7.2"/>';
    }
    if (/yandex/.test(n)) {
      // compass needle
      return '<circle cx="8" cy="8" r="5.6"/><path d="M10.2 5.8 6.6 7.2 5.8 10.8l3.6-1.4z"/>';
    }
    if (/bing|copilot/.test(n)) {
      // upward swoosh
      return '<path d="M4.6 2.6v9.2l3.2 1.6 4-2.2V8.2L7 6.6"/>';
    }
    if (/google/.test(n)) {
      // ring with an opening, and a bar into the centre
      return '<path d="M12.2 5.4A5.4 5.4 0 1 0 13.4 8H8"/>';
    }
    if (/searx|mojeek|marginalia|stract/.test(n)) {
      // scattered index dots
      return '<circle cx="4.6" cy="4.6" r="1.5"/><circle cx="11.4" cy="4.6" r="1.5"/><circle cx="4.6" cy="11.4" r="1.5"/><circle cx="11.4" cy="11.4" r="1.5"/>';
    }
    if (/perplexity|chatgpt|claude|ai/.test(n)) {
      // spark
      return '<path d="M8 2.2v11.6M2.2 8h11.6M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6"/>';
    }
    // fallback: a lens carrying the engine's initial
    return null;
  },

  /* Parsed, not assigned as innerHTML: the chrome sanitiser strips the svg's
     xmlns and warns every time, which buries real warnings in the log. */
  _paintMark(mark, name) {
    const doc = new DOMParser().parseFromString(this.markFor(name), "image/svg+xml");
    const root = doc.documentElement;
    if (root.nodeName === "parsererror") {
      return;
    }
    mark.replaceChildren(document.importNode(root, true));
  },

  markFor(name = "?") {
    const tint = this.tintFor(name);
    const glyph = this.glyphFor(name);
    const body = glyph
      ? `<g fill="none" stroke="${tint}" stroke-width="1.5" stroke-linejoin="round"
             stroke-linecap="round">${glyph}</g>`
      : `<circle cx="7" cy="7" r="5.1" fill="none" stroke="${tint}" stroke-width="1.5"/>
         <path d="M10.9 10.9 L14 14" stroke="${tint}" stroke-width="1.6" stroke-linecap="round"/>
         <text x="7" y="9.4" text-anchor="middle" font-size="6.4" font-weight="600"
               font-family="system-ui, sans-serif" fill="${tint}">${(name.trim()[0] || "?").toUpperCase()}</text>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">${body}</svg>`;
  },

  /* Left of the input wherever there is room for it. The sidebar urlbar hides
     #page-action-buttons entirely, so parking the chip there left it built,
     present and display:none - which read as the chip never having existed. */
  _container() {
    const root = document.documentElement;
    const inline =
      root.getAttribute("zen-layout") === "horizontal" ||
      root.hasAttribute("zen-urlbar-sidebar");
    return inline
      ? document.querySelector("#urlbar .urlbar-input-container")
      : document.getElementById("page-action-buttons");
  },

  _build() {
    const container = this._container();
    if (!container || document.getElementById("zen-search-engine-button")) {
      return;
    }

    const fragment = window.MozXULElement.parseXULToFragment(`
      <hbox id="zen-search-engine-button"
            class="zen-urlbar-chip"
            role="button"
            data-l10n-id="zen-search-engine-button">
        <html:div class="zen-search-engine-mark"></html:div>
      </hbox>
    `);
    container.prepend(fragment);
    this._button = document.getElementById("zen-search-engine-button");
    this._button.addEventListener("click", (event) => this.openPanel(event));
  },

  /* The layout attribute lands after this module builds, so the chip has to be
     moved when it changes rather than only at build time. */
  _place() {
    if (!this._button) {
      return;
    }
    const target = this._container();
    if (target && this._button.parentElement !== target) {
      target.prepend(this._button);
    }

  },

  async refresh() {
    if (!this._button) {
      return;
    }
    const engine = await this.engine();
    const name = engine?.name || "Search";
    const mark = this._button.querySelector(".zen-search-engine-mark");
    if (mark) {
      this._paintMark(mark, name);
    }
    document.l10n.setAttributes(this._button, "zen-search-engine-current", { engine: name });
  },

  async openPanel() {
    const panel = this._ensurePanel();
    /* Fill after opening, and never let this throw: when the engine list
       failed the panel never opened at all and the button looked dead. */
    let engines = [];
    let current = null;
    try {
      [engines, current] = await Promise.all([
        lazy.SearchService.getVisibleEngines(),
        this.engine(),
      ]);
    } catch (ex) {
      console.error("[zen] search engines unavailable", ex);
    }

    const list = panel.querySelector(".zen-search-engine-list");
    list.textContent = "";
    for (const engine of engines) {
      const row = document.createElementNS(HTML_NS, "button");
      row.className = "zen-search-engine-item";
      row.toggleAttribute("selected", engine.name === current?.name);

      const mark = document.createElementNS(HTML_NS, "span");
      mark.className = "zen-search-engine-mark";
      this._paintMark(mark, engine.name);

      const label = document.createElementNS(HTML_NS, "span");
      label.className = "zen-search-engine-name";
      label.textContent = engine.name;

      row.append(mark, label);
      row.addEventListener("click", async () => {
        await lazy.SearchService.setDefault(
          engine,
          lazy.SearchService.CHANGE_REASON.USER
        );
        panel.hidePopup();
        this.refresh();
      });
      list.append(row);
    }

    // Match the input it belongs to, so the panel reads as part of the bar.
    const urlbar = document.getElementById("urlbar");
    const width = Math.round(urlbar.getBoundingClientRect().width);
    if (width > 0) {
      panel.style.setProperty("--zen-search-engine-width", width + "px");
    }
    panel.openPopup(this._button, "after_end", 0, 6);
  },

  _ensurePanel() {
    if (this._panel) {
      return this._panel;
    }
    const panel = document.createXULElement("panel");
    panel.id = "zen-search-engine-panel";
    panel.setAttribute("noautofocus", "true");

    const head = document.createElementNS(HTML_NS, "div");
    head.className = "zen-search-engine-head";
    document.l10n.setAttributes(head, "zen-search-engine-heading");

    const list = document.createElementNS(HTML_NS, "div");
    list.className = "zen-search-engine-list";

    panel.append(head, list);
    document.getElementById("mainPopupSet").append(panel);
    this._panel = panel;
    return panel;
  },
};

window.addEventListener(
  "MozAfterPaint",
  () => {
    gZenSearchEngine.init();
  },
  { once: true }
);
