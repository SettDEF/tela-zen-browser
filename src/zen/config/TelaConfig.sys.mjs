/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/* The dotfile: ~/.config/tela-zen/config.toml (XDG_CONFIG_HOME honoured).
 *
 * A TOML subset - [section], key = value, # comments; strings, integers,
 * booleans. Friendly keys map to prefs (KEYS below); [prefs] takes any
 * about:config name. What the file sets is written as a locked default, so
 * Settings shows it greyed and nothing drifts from the file; a removed line
 * is unlocked and its old default restored. Read before the first window,
 * then re-read whenever the file changes. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  NetUtil: "resource://gre/modules/NetUtil.sys.mjs",
  setInterval: "resource://gre/modules/Timer.sys.mjs",
});

// Tests point this elsewhere so a test browser never takes the user's file.
const PREF_FILE = "zen.config.file";
const POLL_MS = 1000;

/* section -> key -> [pref, description]. The description is the comment the
   generated file carries, so the file documents itself. */
export const KEYS = {
  theme: {
    style: ["zen.theme.style", "default | android"],
    palette: ["zen.theme.palette", "desktop | custom"],
    accent: ["zen.theme.accent", "#rrggbb, used when palette = custom"],
    scheme: ["zen.theme.scheme", "dark | light | auto, used when palette = custom"],
  },
  layout: {
    preset: ["zen.ui.layout-preset", "comfortable | compact | minimal | horizontal | shy | custom1-4"],
    "right-side": ["zen.tabs.vertical.right-side", "sidebar on the right"],
    "single-toolbar": ["zen.view.use-single-toolbar", "address bar inside the sidebar"],
    "hide-tabbar": ["zen.view.compact.hide-tabbar", "compact: hide the sidebar until hovered"],
    "hide-toolbar": ["zen.view.compact.hide-toolbar", "compact: hide the toolbar until hovered"],
  },
  tabs: {
    style: ["zen.tabs.style", "comfortable | compact"],
    selected: ["zen.tabs.look.selected", "mark | fill | outline | plain"],
    colors: ["zen.tabs.look.color", "off | selected | all"],
    close: ["zen.tabs.look.close", "hover | always | never"],
    radius: ["zen.tabs.look.radius", "px, -1 = style default (also sets the address bar and page)"],
    height: ["zen.tabs.look.height", "px, -1 = style default"],
    "folder-gap": ["zen.tabs.look.folder-gap", "px between folders"],
    "hover-shade": ["zen.tabs.look.hover-shade", "shade the tab under the pointer"],
  },
  glow: {
    strength: ["zen.tabs.focus.strength", "full | subtle | off"],
    preset: ["zen.tabs.focus.preset", "siren | beacon | scanner | pulse | aurora | trail | flat | custom"],
    "color-a": ["zen.tabs.focus.color-a", "#rrggbb"],
    "color-b": ["zen.tabs.focus.color-b", "#rrggbb"],
    speed: ["zen.tabs.focus.speed", "ms per cycle"],
    intensity: ["zen.tabs.focus.intensity", "0-100"],
  },
  urlbar: {
    behavior: ["zen.urlbar.behavior", "sidebar | float | normal"],
    overlay: ["zen.urlbar.sidebar.overlay", "focused field floats over the page instead of widening the sidebar"],
    density: ["zen.urlbar.sidebar.density", "comfortable | compact"],
    "max-rows": ["zen.urlbar.sidebar.max-rows", "results shown"],
  },
  spaces: {
    "follow-desktop": ["zen.spaces.desktop.enabled", "each virtual desktop shows its own space"],
    "continue-where-left-off": ["zen.workspaces.continue-where-left-off", "reopen the last space"],
  },
  media: {
    cards: ["zen.mediacontrols.enabled", "media cards in the sidebar"],
    "show-on-own-tab": ["zen.mediacontrols.show-on-own-tab", "keep the card while on its tab"],
  },
  glance: {
    enabled: ["zen.glance.enabled", "open links in a glance"],
  },
  newtab: {
    layout: ["zen.newtab.layout", "full | minimal | sites | recent"],
    date: ["zen.newtab.show-date", "show the date"],
    categories: ["zen.newtab.show-chips", "Images/News/Videos under the search"],
    tiles: ["zen.newtab.show-tiles", "most visited sites"],
    recent: ["zen.newtab.show-recent", "recent page cards"],
    "after-away-hours": ["zen.newtab.after-away-hours", "start on the new tab after this long closed, 0 = never"],
  },
  translations: {
    enabled: ["browser.translations.enable", "offer to translate pages"],
    "remember-sites": ["zen.translations.remember-sites", "translate sites again on return"],
  },
};

/* ---- parsing ------------------------------------------------------------ */

function parseValue(raw) {
  const v = raw.trim();
  if (v === "true" || v === "false") {
    return { value: v === "true" };
  }
  if (/^[+-]?\d+$/.test(v)) {
    const n = Number(v);
    return Number.isSafeInteger(n) && Math.abs(n) <= 2 ** 31 - 1
      ? { value: n }
      : { error: "integer out of range" };
  }
  if (/^[+-]?\d*\.\d+$/.test(v)) {
    return { error: "decimals are not supported, use an integer or a string" };
  }
  if (v.startsWith("'")) {
    const m = /^'([^']*)'$/.exec(v);
    return m ? { value: m[1] } : { error: "unterminated 'string'" };
  }
  if (v.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)"$/.exec(v);
    if (!m) {
      return { error: 'unterminated "string"' };
    }
    const value = m[1].replace(/\\(.)/g, (_, c) =>
      ({ n: "\n", t: "\t", '"': '"', "\\": "\\" })[c] ?? c
    );
    return { value };
  }
  return { error: `cannot read value ${v.slice(0, 40)}` };
}

// Drops a trailing # comment, but not a # inside a string (colours).
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\" && quote === '"') {
        i++;
      } else if (c === quote) {
        quote = null;
      }
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

/* -> { entries: [{pref, value, line}], errors: [{line, message}] } */
export function parse(text) {
  const entries = [];
  const errors = [];
  let section = null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const n = i + 1;
    const line = stripComment(lines[i]).trim();
    if (!line) {
      continue;
    }
    const head = /^\[\s*([A-Za-z0-9_-]+)\s*\]$/.exec(line);
    if (head) {
      section = head[1];
      if (section !== "prefs" && !KEYS[section]) {
        errors.push({ line: n, message: `unknown section [${section}]` });
      }
      continue;
    }
    const kv = /^("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) {
      errors.push({ line: n, message: "expected key = value" });
      continue;
    }
    const key = /^["']/.test(kv[1]) ? kv[1].slice(1, -1) : kv[1];
    const parsed = parseValue(kv[2]);
    if (parsed.error) {
      errors.push({ line: n, message: `${key}: ${parsed.error}` });
      continue;
    }
    let pref;
    if (section === "prefs") {
      pref = key;
    } else if (!section) {
      errors.push({ line: n, message: `${key} is outside any [section]` });
      continue;
    } else if (!KEYS[section]) {
      continue; // The section line already reported this.
    } else if (!KEYS[section][key]) {
      errors.push({ line: n, message: `unknown key ${key} in [${section}]` });
      continue;
    } else {
      pref = KEYS[section][key][0];
    }
    entries.push({ pref, value: parsed.value, line: n });
  }
  return { entries, errors };
}

/* ---- applying ----------------------------------------------------------- */

const TYPE = Ci.nsIPrefBranch;

function readDefault(branch, pref) {
  switch (branch.getPrefType(pref)) {
    case TYPE.PREF_BOOL:
      return { type: "bool", value: branch.getBoolPref(pref) };
    case TYPE.PREF_INT:
      return { type: "int", value: branch.getIntPref(pref) };
    case TYPE.PREF_STRING:
      return { type: "string", value: branch.getStringPref(pref) };
  }
  return null;
}

function writeDefault(branch, pref, type, value) {
  if (type === "bool") {
    branch.setBoolPref(pref, value);
  } else if (type === "int") {
    branch.setIntPref(pref, value);
  } else {
    branch.setStringPref(pref, value);
  }
}

// The value as the pref's own type wants it, or an error.
function coerce(existing, value) {
  const type = existing?.type || (typeof value === "boolean" ? "bool" : typeof value === "number" ? "int" : "string");
  if (type === "bool" && typeof value !== "boolean") {
    return { error: "expects true or false" };
  }
  if (type === "int" && typeof value !== "number") {
    return { error: "expects an integer" };
  }
  return { type, value: type === "string" ? String(value) : value };
}

export const TelaConfig = {
  _started: false,
  _mtime: null,
  // pref -> original default ({type, value} or null), for what the file set.
  _managed: new Map(),
  status: { path: "", exists: false, applied: [], errors: [] },

  get path() {
    const override = Services.prefs.getStringPref(PREF_FILE, "");
    if (override) {
      return override;
    }
    const config =
      Services.env.get("XDG_CONFIG_HOME") ||
      PathUtils.join(Services.dirsvc.get("Home", Ci.nsIFile).path, ".config");
    return PathUtils.join(config, "tela-zen", "config.toml");
  },

  /* Synchronous on purpose: called as the first window initialises, so the
     window lays out with the file's values rather than switching to them. */
  init() {
    if (this._started) {
      return;
    }
    this._started = true;
    this._load();
    lazy.setInterval(() => this._poll(), POLL_MS);
  },

  _file() {
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(this.path);
    return file;
  },

  _read(file) {
    const stream = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(
      Ci.nsIFileInputStream
    );
    stream.init(file, -1, 0, 0);
    try {
      return lazy.NetUtil.readInputStreamToString(stream, stream.available(), {
        charset: "UTF-8",
      });
    } finally {
      stream.close();
    }
  },

  _poll() {
    let mtime = null;
    try {
      const file = this._file();
      mtime = file.exists() ? file.lastModifiedTime : null;
    } catch {}
    if (mtime !== this._mtime) {
      this._load();
    }
  },

  _load() {
    let text = "";
    let exists = false;
    try {
      const file = this._file();
      exists = file.exists();
      this._mtime = exists ? file.lastModifiedTime : null;
      text = exists ? this._read(file) : "";
    } catch (e) {
      this._publish({ exists, applied: [], errors: [{ line: 0, message: String(e) }] });
      return;
    }
    const { entries, errors } = parse(text);
    this.apply(entries, errors, exists);
  },

  apply(entries, errors = [], exists = true) {
    const defaults = Services.prefs.getDefaultBranch("");
    const wanted = new Map();
    for (const e of entries) {
      wanted.set(e.pref, e); // A later line wins, as in TOML tools that allow it.
    }
    // Lines that went away: give the pref back.
    for (const [pref, original] of this._managed) {
      if (wanted.has(pref)) {
        continue;
      }
      Services.prefs.unlockPref(pref);
      if (original) {
        writeDefault(defaults, pref, original.type, original.value);
      }
      this._managed.delete(pref);
    }
    const applied = [];
    for (const [pref, e] of wanted) {
      const original = this._managed.has(pref)
        ? this._managed.get(pref)
        : readDefault(defaults, pref);
      const v = coerce(original || readDefault(Services.prefs, pref), e.value);
      if (v.error) {
        errors.push({ line: e.line, message: `${pref} ${v.error}` });
        continue;
      }
      try {
        if (Services.prefs.prefIsLocked(pref)) {
          Services.prefs.unlockPref(pref);
        }
        writeDefault(defaults, pref, v.type, v.value);
        Services.prefs.lockPref(pref);
        if (!this._managed.has(pref)) {
          this._managed.set(pref, original);
        }
        applied.push(pref);
      } catch (ex) {
        errors.push({ line: e.line, message: `${pref}: ${ex.message || ex}` });
      }
    }
    errors.sort((a, b) => a.line - b.line);
    this._publish({ exists, applied, errors });
  },

  _publish({ exists, applied, errors }) {
    this.status = { path: this.path, exists, applied, errors };
    for (const err of errors) {
      console.warn(`[tela-config] ${this.path}:${err.line}: ${err.message}`);
    }
    Services.obs.notifyObservers(null, "tela-config-changed");
  },

  /* A starting file: everything changed from the default is live, the rest
     listed commented out with its default, so the file is its own manual. */
  generate() {
    const defaults = Services.prefs.getDefaultBranch("");
    const value = v =>
      typeof v === "string" ? JSON.stringify(v) : String(v);
    const current = pref => {
      const d = readDefault(Services.prefs, pref);
      return d?.value;
    };
    const original = pref =>
      this._managed.has(pref) ? this._managed.get(pref)?.value : readDefault(defaults, pref)?.value;
    const out = [
      "# tela-zen config - https://toml.io subset: [section], key = value, # comments.",
      "# Lines here are locked in Settings (shown greyed); delete a line to manage",
      "# that setting in the browser again. Saved changes apply within a second.",
      "# Any about:config pref can go under [prefs], e.g. \"browser.startup.page\" = 3",
      "",
    ];
    for (const [section, keys] of Object.entries(KEYS)) {
      out.push(`[${section}]`);
      for (const [key, [pref, help]] of Object.entries(keys)) {
        const now = current(pref);
        if (now === undefined) {
          continue;
        }
        const changed = now !== original(pref) || this._managed.has(pref);
        out.push(`${changed ? "" : "# "}${key} = ${value(now)}  # ${help}`);
      }
      out.push("");
    }
    out.push("[prefs]", "");
    return out.join("\n");
  },

  /* Creates the file from the current setup; never overwrites one. */
  async create() {
    if (await IOUtils.exists(this.path)) {
      return false;
    }
    await IOUtils.makeDirectory(PathUtils.parent(this.path), { createAncestors: true });
    await IOUtils.writeUTF8(this.path, this.generate(), { mode: "create" });
    this._load();
    return true;
  },
};
