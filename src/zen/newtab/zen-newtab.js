"use strict";

// Chrome-privileged page: talk to Places directly. If privileges are absent
// the page still renders, just empty - never a broken new tab.
const MAX = 300;
/* Start layouts: what the Start view is built from. The switches in
   Settings hide parts on top of this. */
const LAYOUTS = {
  full: { name: "Full", hint: "Search, sites and recent pages", tiles: 8, recent: 6 },
  minimal: { name: "Minimal", hint: "Only the search, centred", tiles: 0, recent: 0 },
  sites: { name: "Sites", hint: "Two rows of most visited", tiles: 16, recent: 0 },
  recent: { name: "Recent", hint: "Pick up what you were reading", tiles: 0, recent: 12 },
};
const layoutName = () => {
  const v = Services.prefs.getStringPref("zen.newtab.layout", "full");
  return LAYOUTS[v] ? v : "full";
};
const layout = () => LAYOUTS[layoutName()];
// "Unread" = visited once and never returned to, within the last week. A
// stored last-seen marker was tried first and is wrong: it advances on the
// first new tab, so the second one shows everything as read.
const UNREAD_WINDOW_US = 7 * 24 * 60 * 60 * 1000 * 1000;

const el = (id) => document.getElementById(id);
const host = (u) => { try { return new URL(u).host.replace(/^www\./, ""); } catch { return ""; } };

function when(usec) {
  const d = new Date(usec / 1000), now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = (day(now) - day(d)) / 86400000;
  if (diff === 0) {
    const mins = Math.round((now - d) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + " min ago";
    return Math.round(mins / 60) + " hours ago";
  }
  return diff === 1 ? "Yesterday" : d.toLocaleDateString();
}
const bucket = (usec) => {
  const d = new Date(usec / 1000), now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = (day(now) - day(d)) / 86400000;
  if (diff < 2) {
    return diff === 0 ? "Today" : "Yesterday";
  }
  return d.toLocaleDateString(undefined, diff < 7 ? { weekday: "long" }
    : { weekday: "short", day: "numeric", month: "long" });
};

function open_(url, event) {
  if (event && (event.ctrlKey || event.metaKey || event.button === 1)) {
    window.open(url, "_blank");
  } else {
    window.location.href = url;
  }
}

function node(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function meta(entry) {
  return [host(entry.url), when(entry.date)].filter(Boolean).join(" · ");
}

function fav(url) {
  const i = node("img", "fav");
  i.src = "page-icon:" + url;
  i.alt = "";
  i.addEventListener("error", () => (i.style.visibility = "hidden"), { once: true });
  return i;
}

function link(cls, url) {
  const a = node("a", cls);
  a.href = url;
  a.title = url;
  a.addEventListener("click", (e) => {
    e.preventDefault();
    open_(url, e);
  });
  return a;
}

function card(entry) {
  const c = link("card", entry.url);
  const src = node("div", "src");
  src.append(fav(entry.url), node("span", null, host(entry.url)));
  if (entry.unread) {
    src.append(node("span", "dot"));
  }
  c.append(src, node("div", "t", entry.title), node("div", "when", when(entry.date)));
  return c;
}

function listRow(entry) {
  const r = link("row", entry.url);
  r.append(fav(entry.url), node("span", "t", entry.title), node("span", "h", host(entry.url)));
  return r;
}

/* The page sits inside the browser, so it wears the browser's colours and
   shapes rather than its own. A colour token is resolved through a probe,
   since a custom property's computed value is the unresolved text. */
function adoptTheme() {
  let win;
  try {
    win = window.browsingContext.topChromeWindow;
  } catch {}
  if (!win?.document) {
    return;
  }
  const doc = win.document;
  const probe = doc.createElement("div");
  probe.style.display = "none";
  doc.documentElement.append(probe);
  const color = (v) => {
    probe.style.color = "";
    probe.style.color = `var(${v})`;
    const c = win.getComputedStyle(probe).color;
    return c && c !== "rgba(0, 0, 0, 0)" ? c : null;
  };
  const root = document.documentElement.style;
  const set = (name, value) => value && root.setProperty(name, value);
  const bg = color("--zen-main-browser-background");
  const text = color("--toolbox-textcolor");
  set("--bg", bg);
  set("--text", text);
  if (text) {
    root.setProperty("--muted", `color-mix(in srgb, ${text} 62%, transparent)`);
    root.setProperty("--faint", `color-mix(in srgb, ${text} 40%, transparent)`);
  }
  set("--surface", color("--tela-surface"));
  set("--accent", color("--zen-primary-color"));
  const r = win.getComputedStyle(doc.documentElement).getPropertyValue("--tela-radius").trim();
  set("--r", r);
  probe.remove();
}

/* Her search page: type and go, then the categories right under the box.
   Categories exist per engine; an engine we do not know gets none. */
const CATEGORIES = {
  google: { Images: "&udm=2", News: "&tbm=nws", Videos: "&tbm=vid",
    Maps: (q) => "https://www.google.com/maps/search/" + encodeURIComponent(q) },
  duckduckgo: { Images: "&ia=images&iax=images", News: "&ia=news&iar=news",
    Videos: "&ia=videos&iax=videos", Maps: "&ia=web&iaxm=maps" },
  bing: { Images: (q) => "https://www.bing.com/images/search?q=" + encodeURIComponent(q),
    News: (q) => "https://www.bing.com/news/search?q=" + encodeURIComponent(q),
    Videos: (q) => "https://www.bing.com/videos/search?q=" + encodeURIComponent(q),
    Maps: (q) => "https://www.bing.com/maps?q=" + encodeURIComponent(q) },
  brave: { Images: (q) => "https://search.brave.com/images?q=" + encodeURIComponent(q),
    News: (q) => "https://search.brave.com/news?q=" + encodeURIComponent(q),
    Videos: (q) => "https://search.brave.com/videos?q=" + encodeURIComponent(q) },
  startpage: { Images: "&cat=images", News: "&cat=news", Videos: "&cat=video" },
};

async function setupSearch() {
  const box = el("box");
  const q = el("q");
  let engine = null;
  try {
    const { SearchService } = ChromeUtils.importESModule(
      "moz-src:///toolkit/components/search/SearchService.sys.mjs"
    );
    engine = await SearchService.getDefault();
  } catch (e) {
    console.error("zen newtab: no search engine", e);
  }
  if (engine) {
    q.placeholder = `Search ${engine.name} or enter address`;
    try {
      const icon = await engine.getIconURL();
      if (icon) {
        el("engine").src = icon;
      }
    } catch {}
  }
  if (!el("engine").src) {
    el("engine").hidden = true;
  }

  const go = (url, event) => url && open_(url, event);
  const searchURL = (text) => engine?.getSubmission(text)?.uri?.spec;
  q.addEventListener("input", () => box.classList.toggle("typed", !!q.value.trim()));
  box.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = q.value.trim();
    if (!text) {
      return;
    }
    let url = null;
    try {
      // A typed address goes there; anything else is a search, as in the address bar.
      url = Services.uriFixup.getFixupURIInfo(text,
        Ci.nsIURIFixup.FIXUP_FLAG_ALLOW_KEYWORD_LOOKUP | Ci.nsIURIFixup.FIXUP_FLAG_FIX_SCHEME_TYPOS)
        .preferredURI?.spec;
    } catch {}
    go(url || searchURL(text));
  });

  const base = searchURL("x") || "";
  const key = Object.keys(CATEGORIES).find((k) => {
    try {
      return new URL(base).hostname.includes(k);
    } catch {
      return false;
    }
  });
  const chips = el("chips");
  for (const [name, how] of Object.entries(CATEGORIES[key] || {})) {
    const b = node("button", "chip", name);
    b.type = "button";
    b.addEventListener("click", (e) => {
      const text = q.value.trim();
      if (!text) {
        q.placeholder = `${name}: type what to look for`;
        q.focus();
        return;
      }
      go(typeof how === "function" ? how(text) : searchURL(text) + how, e);
    });
    chips.append(b);
  }
  chips.hidden = !chips.childElementCount;
}

async function topSites(db) {
  el("tiles").replaceChildren();
  const rows = await db.executeCached(
    `SELECT prefix, host FROM moz_origins
      WHERE frecency <> 0 AND prefix IN ('https://', 'http://')
      ORDER BY frecency DESC LIMIT ${layout().tiles}`
  );
  const tiles = el("tiles");
  for (const r of rows) {
    const h = r.getResultByName("host");
    const url = r.getResultByName("prefix") + h + "/";
    const t = link("tile", url);
    const ic = node("div", "ic");
    const img = fav(url);
    ic.append(img);
    t.append(ic, node("span", "n", h.replace(/^www\./, "")));
    tiles.append(t);
  }
  tiles.hidden = !rows.length;
}

var renderedAt = 0; // var: a test resets it

async function render() {
  renderedAt = Date.now();
  el("date").textContent = new Date().toLocaleDateString(undefined, {
    weekday: "long", day: "numeric", month: "long",
  });
  for (const id of ["recent", "list"]) {
    el(id).replaceChildren();
  }
  el("recent-sect").hidden = el("list-sect").hidden = true;

  let rows = [];
  try {
    const { PlacesUtils } = ChromeUtils.importESModule(
      "resource://gre/modules/PlacesUtils.sys.mjs"
    );
    const db = await PlacesUtils.promiseDBConnection();
    topSites(db).catch((e) => console.error("zen newtab: top sites", e));
    rows = await db.executeCached(
      `SELECT url, title, last_visit_date AS date, visit_count
         FROM moz_places
        WHERE hidden = 0 AND last_visit_date NOT NULL AND title NOT NULL AND title <> ''
        ORDER BY last_visit_date DESC
        LIMIT ${MAX}`
    );
  } catch (e) {
    console.error("zen newtab: history unavailable", e);
  }

  const cutoff = Date.now() * 1000 - UNREAD_WINDOW_US;
  const entries = rows.map((r) => {
    const date = r.getResultByName("date");
    return {
      url: r.getResultByName("url"),
      title: r.getResultByName("title"),
      date,
      unread: r.getResultByName("visit_count") <= 1 && date > cutoff,
    };
  });
  pages = entries;
  renderHistory();
  // Empty sections stay hidden: a heading over nothing is clutter.
  if (!entries.length) {
    return;
  }

  const recent = entries.slice(0, layout().recent);
  el("recent-sect").hidden = !recent.length;
  const unread = entries.filter((e) => e.unread).length;
  el("recent-meta").textContent = unread ? `${unread} not opened again` : "";
  recent.forEach((e) => el("recent").append(card(e)));

}

/* ---- History view: everything, filtered as you type. ---- */

let pages = [];

function renderHistory() {
  const needle = el("filter").value.trim().toLowerCase();
  const shown = needle
    ? pages.filter((e) => (e.title + " " + e.url).toLowerCase().includes(needle))
    : pages;
  const list = el("list");
  list.replaceChildren();
  el("list-sect").hidden = !pages.length;
  el("list-meta").textContent = needle ? `${shown.length} of ${pages.length}` : `${pages.length} pages`;
  let group = null;
  for (const e of shown) {
    const b = bucket(e.date);
    if (b !== group) {
      group = b;
      list.append(node("div", "group", b));
    }
    list.append(listRow(e));
  }
}

/* ---- Views: Start, History, Settings. [ and ] or 1-3 cycle them. ---- */

const VIEWS = ["start", "history", "settings"];
let view = "start";

function showView(name) {
  view = name;
  for (const v of VIEWS) {
    el("view-" + v).hidden = v !== name;
    const b = document.querySelector(`[data-view="${v}"]`);
    b.setAttribute("aria-selected", v === name);
    b.tabIndex = v === name ? 0 : -1;
  }
  (name === "start" ? el("q") : name === "history" ? el("filter") : null)?.focus();
}

function setupViews() {
  for (const b of document.querySelectorAll("[data-view]")) {
    b.addEventListener("click", () => showView(b.dataset.view));
  }
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey) {
      return;
    }
    const typing = e.target.matches?.("input, select") && e.target.value !== "";
    const i = VIEWS.indexOf(view);
    let next = null;
    if (!typing && (e.key === "]" || e.key === "[")) {
      next = VIEWS[(i + (e.key === "]" ? 1 : VIEWS.length - 1)) % VIEWS.length];
    } else if (!e.target.matches?.("input, select") && /^[1-3]$/.test(e.key)) {
      next = VIEWS[+e.key - 1];
    } else if (e.target.closest?.("[role=tablist]") && /^Arrow(Left|Right)$/.test(e.key)) {
      next = VIEWS[(i + (e.key === "ArrowRight" ? 1 : VIEWS.length - 1)) % VIEWS.length];
    }
    if (next) {
      e.preventDefault();
      showView(next);
    }
  });
  el("filter").addEventListener("input", renderHistory);
}

/* ---- Settings view: plain prefs, so about:config and the dotfile agree. ---- */

const AWAY = [[0, "Never"], [1, "1 hour"], [4, "4 hours"], [12, "12 hours"], [24, "A day"]];
const SETTINGS = [
  { head: "On this page" },
  { pref: "zen.newtab.show-date", label: "Date" },
  { pref: "zen.newtab.show-chips", label: "Search categories", hint: "Images, News, Videos under the box" },
  { pref: "zen.newtab.show-tiles", label: "Most visited sites" },
  { pref: "zen.newtab.show-recent", label: "Recent pages", hint: "The cards under the search" },
  { head: "When the browser starts" },
  { pref: "zen.workspaces.continue-where-left-off", label: "Continue where you left off",
    hint: "Off: always start on this page" },
  { pref: "zen.newtab.after-away-hours", label: "Start here instead after being closed for",
    options: AWAY, dep: "zen.workspaces.continue-where-left-off" },
];

function prefValue(s) {
  return s.options ? Services.prefs.getIntPref(s.pref, 0) : Services.prefs.getBoolPref(s.pref, true);
}

function buildSettings() {
  const box = el("settings");
  box.append(node("h3", "set-head", "Start layout"));
  const pick = node("div", "layouts");
  pick.setAttribute("role", "radiogroup");
  for (const [key, l] of Object.entries(LAYOUTS)) {
    const b = node("button", "layout");
    b.type = "button";
    b.dataset.layout = key;
    b.setAttribute("role", "radio");
    // A tiny sketch of the layout: search bar, tiles, cards.
    const sketch = node("div", "sketch " + key);
    sketch.append(node("i", "s-bar"), node("i", "s-tiles"), node("i", "s-cards"));
    b.append(sketch, node("span", "set-label", l.name), node("span", "set-hint", l.hint));
    b.addEventListener("click", () => Services.prefs.setStringPref("zen.newtab.layout", key));
    pick.append(b);
  }
  box.append(pick);
  for (const s of SETTINGS) {
    if (s.head) {
      box.append(node("h3", "set-head", s.head));
      continue;
    }
    const row = node("label", "set");
    const text = node("span", "set-text");
    text.append(node("span", "set-label", s.label));
    if (s.hint) {
      text.append(node("span", "set-hint", s.hint));
    }
    let control;
    if (s.options) {
      control = node("select", "set-select");
      for (const [v, name] of s.options) {
        const o = node("option", null, name);
        o.value = v;
        control.append(o);
      }
      control.addEventListener("change", () => Services.prefs.setIntPref(s.pref, +control.value));
    } else {
      control = node("input", "set-switch");
      control.type = "checkbox";
      control.setAttribute("role", "switch");
      control.addEventListener("change", () => Services.prefs.setBoolPref(s.pref, control.checked));
    }
    control.dataset.pref = s.pref;
    row.append(text, control);
    box.append(row);
  }
  const all = node("button", "set-all", "All browser settings");
  all.type = "button";
  all.addEventListener("click", (e) => open_("about:preferences", e));
  box.append(all);
}

/* Prefs into the page; also runs on every change, from here or elsewhere. */
function applySettings() {
  for (const s of SETTINGS) {
    const c = s.pref && document.querySelector(`[data-pref="${s.pref}"]`);
    if (!c) {
      continue;
    }
    if (s.options) {
      c.value = prefValue(s);
    } else {
      c.checked = prefValue(s);
    }
    if (s.dep) {
      c.disabled = !Services.prefs.getBoolPref(s.dep, true);
      c.closest(".set").classList.toggle("off", c.disabled);
    }
  }
  const name = layoutName();
  for (const b of document.querySelectorAll("[data-layout]")) {
    b.setAttribute("aria-checked", b.dataset.layout === name);
  }
  const changed = document.body.dataset.layout && document.body.dataset.layout !== name;
  document.body.dataset.layout = name;
  if (changed) {
    render();
  }
  const on = (p) => Services.prefs.getBoolPref(p, true);
  document.body.classList.toggle("no-date", !on("zen.newtab.show-date"));
  document.body.classList.toggle("no-chips", !on("zen.newtab.show-chips"));
  document.body.classList.toggle("no-tiles", !on("zen.newtab.show-tiles"));
  document.body.classList.toggle("no-recent", !on("zen.newtab.show-recent"));
}

function load() {
  adoptTheme();
  setupViews();
  try {
    buildSettings();
    applySettings();
    const watch = { observe: applySettings };
    for (const branch of ["zen.newtab.", "zen.workspaces.continue-where-left-off"]) {
      Services.prefs.addObserver(branch, watch);
    }
    window.addEventListener("unload", () => {
      for (const branch of ["zen.newtab.", "zen.workspaces.continue-where-left-off"]) {
        Services.prefs.removeObserver(branch, watch);
      }
    });
  } catch (e) {
    console.error("zen newtab: settings", e);
  }
  setupSearch().catch((e) => console.error("zen newtab: search", e));
  render();
  // Zen keeps this tab around for days; show what is new on coming back.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && Date.now() - renderedAt > 60000) {
      adoptTheme();
      render();
    }
  });
  window.addEventListener("focus", () => {
    if (document.activeElement === document.body && view === "start") {
      el("q").focus();
    }
  });
}

document.addEventListener("DOMContentLoaded", load);
