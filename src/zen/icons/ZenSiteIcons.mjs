// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at http://mozilla.org/MPL/2.0/.

/* One mark per site, drawn by us.
 *
 * Favicons would be a row of mismatched brand marks at four different weights;
 * these are one set in one weight, single-coloured through
 * -moz-context-properties so they take the theme and the card accent.
 *
 * NOTHING HERE TAKES A URL FROM CONTENT. A page can only ever *name* an icon,
 * and a name is looked up in NAMES below - anything unrecognised resolves to
 * nothing and the caller falls back to its plain dot. The only place a real
 * URL enters is the user's own override pref, which is validated to a local
 * file or a data: image before it is handed to anything that renders it. */

import { SITE_RULES } from "chrome://browser/content/zen-components/zen-site-rules.mjs";

const ICON_ROOT = "chrome://browser/skin/zen-icons/sites/";
const OVERRIDE_PREF = "zen.sidebar.site-icons";

/* A pref is a text field somebody can paste into; a megabyte of base64 in one
   would be a bad day for every window that reads it. */
const MAX_SOURCE = 512 * 1024;

// Host -> mark, for the hosts SITE_RULES draws a mark for. Most CI/incident
// rules have none - they get the accent colour and no icon.
const BUILTIN = {};
for (const rule of SITE_RULES) {
  if (!rule.mark) {
    continue;
  }
  for (const host of rule.hosts) {
    BUILTIN[host] = rule.mark;
  }
}

const NAMES = new Set([...Object.values(BUILTIN), "generic"]);

/* Short forms exist because the card's own sanitiser caps `icon` at four
   characters - a page that wants to name a mark has that much room and no
   more. The full names work too, for callers with no such cap. */
const ALIAS = {
  cld: "claude",
  gpt: "chatgpt",
  gem: "gemini",
  aist: "aistudio",
  cplt: "copilot",
  deep: "deepseek",
  mstl: "mistral",
  pplx: "perplexity",
  tgth: "together",
  lcat: "longcat",
  mnmx: "minimax",
  ai: "generic",
};

// name -> the host an override is keyed by, so an override lands on a mark
// however that mark was chosen.
const HOST_FOR_NAME = {};
for (const [host, name] of Object.entries(BUILTIN)) {
  HOST_FOR_NAME[name] = host;
}

const FILE_EXT = /\.(?:svg|png|gif|jpe?g|webp|avif)$/i;
const DATA_IMAGE = /^data:image\/(?:svg\+xml|png|gif|jpeg|webp|avif)[;,]/i;

window.gZenSiteIcons = {
  PREF: OVERRIDE_PREF,

  init() {
    if (this._inited) {
      return;
    }
    this._inited = true;
    // Parsing JSON per row per render would be silly; the observer is what
    // keeps the cache honest when about:config or the UI writes.
    Services.prefs.addObserver(OVERRIDE_PREF, this);
    window.addEventListener("unload", () => {
      Services.prefs.removeObserver(OVERRIDE_PREF, this);
    }, { once: true });
  },

  observe() {
    this._overrides = null;
    window.gZenPageCards?.refresh?.();
  },

  hostKey(host) {
    return typeof host === "string" ? host.replace(/^www\./, "").toLowerCase() : "";
  },

  /* Every read of the pref goes through here, so a hand-edited value that no
     longer parses - or that is a number, or an array - behaves exactly like
     having no overrides at all rather than throwing into a render. */
  get overrides() {
    if (this._overrides) {
      return this._overrides;
    }
    let parsed;
    try {
      parsed = JSON.parse(Services.prefs.getStringPref(OVERRIDE_PREF, "{}"));
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      parsed = {};
    }
    this._overrides = parsed;
    return parsed;
  },

  /* Stored verbatim, so what the editor wrote is what about:config shows and
     what the next read gives back. Validation decides whether a value is
     accepted at all, never what it is rewritten to. */
  setOverride(host, source) {
    const key = this.hostKey(host);
    if (!key) {
      return false;
    }
    const map = { ...this.overrides };
    const value = typeof source === "string" ? source.trim() : "";
    if (!value) {
      delete map[key];
    } else {
      if (!this.sourceToURL(value)) {
        return false;
      }
      map[key] = value;
    }
    Services.prefs.setStringPref(OVERRIDE_PREF, JSON.stringify(map));
    this._overrides = null;
    return true;
  },

  /* A local file or an inline image, and nothing else: no http(s), so a mark
     can never become a request, and no chrome/resource, so the pref cannot
     reach into the browser's own packaging. */
  sourceToURL(source) {
    if (typeof source !== "string") {
      return "";
    }
    const value = source.trim();
    if (!value || value.length > MAX_SOURCE) {
      return "";
    }
    if (DATA_IMAGE.test(value)) {
      return value;
    }
    try {
      if (/^file:\/\//i.test(value)) {
        return FILE_EXT.test(new URL(value).pathname) ? value : "";
      }
      if (value.startsWith("/") || /^[a-z]:[\\/]/i.test(value)) {
        return FILE_EXT.test(value) ? PathUtils.toFileURI(value) : "";
      }
    } catch {
      return "";
    }
    return "";
  },

  // Content names a mark; only a name in the table survives the trip.
  resolveName(name) {
    if (typeof name !== "string") {
      return "";
    }
    const key = name.trim().toLowerCase();
    const resolved = NAMES.has(key) ? key : ALIAS[key] || "";
    return resolved;
  },

  nameForHost(host) {
    return BUILTIN[this.hostKey(host)] || "";
  },

  /* The whole resolution, in one place: the host of the tab decides the mark,
     a name from content is only consulted when the host has none of its own,
     and the user's override for that site outranks both.

     The name is returned alongside the URL because it is what the stylesheet
     animates on - an overridden mark still moves the way its site moves. */
  resolve({ host, name } = {}) {
    const hostKey = this.hostKey(host);
    const mark = this.nameForHost(hostKey) || this.resolveName(name);
    const overrideKey = mark ? HOST_FOR_NAME[mark] || hostKey : hostKey;
    const overridden = this.sourceToURL(overrideKey ? this.overrides[overrideKey] : "");
    if (overridden) {
      const drawn = mark || "generic";
      return { name: drawn, url: overridden, builtin: `${ICON_ROOT}${drawn}.svg` };
    }
    const url = mark ? `${ICON_ROOT}${mark}.svg` : "";
    return { name: mark, url, builtin: url };
  },

  urlFor(request) {
    return this.resolve(request).url;
  },

  /* Paints a mark onto an <img> and answers whether there was one to paint.

     An HTML image, not a XUL one, for two reasons: a XUL <image> fires no
     error event, so a deleted override would leave a hole rather than fall
     back, and this is the element whose GIF and SVG animation is the point. */
  paint(image, request) {
    const mark = this.resolve(request);
    if (!mark.url) {
      image.onerror = null;
      image.removeAttribute("mark");
      image.removeAttribute("wanted");
      image.removeAttribute("src");
      return false;
    }
    // The name is what the stylesheet animates on, so an overridden mark still
    // moves the way its site moves.
    image.setAttribute("mark", mark.name);
    /* `wanted` is what was asked for, which is not always what is shown: a card
       refilled for some other reason must not reassign src and restart a GIF
       mid-loop, nor undo a fallback by asking for the bad file again. */
    if (image.getAttribute("wanted") === mark.url) {
      return true;
    }
    image.setAttribute("wanted", mark.url);
    image.onerror =
      mark.builtin && mark.builtin !== mark.url
        ? () => {
            image.onerror = null;
            image.src = mark.builtin;
          }
        : null;
    image.src = mark.url;
    return true;
  },

  // One <img>, already painted, or null when the site has no mark at all.
  createMark(doc, request, className) {
    const image = doc.createElement("img");
    image.className = className;
    return this.paint(image, request) ? image : null;
  },
};

window.addEventListener("MozAfterPaint", () => gZenSiteIcons.init(), { once: true });
