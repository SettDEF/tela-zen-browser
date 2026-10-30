/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Reads the Material 3 palette that a Material-You desktop shell generates
 * from the wallpaper, and publishes it to a chrome document as CSS custom
 * properties named `--zen-m3-<key>` (e.g. `--zen-m3-surfaceContainerHigh`).
 *
 * The file is quickshell/illogical-impulse's `material_colors.scss`, a flat
 * list of `$name: value;` lines regenerated on every wallpaper change. Nothing
 * here is specific to about:preferences: `apply(document)` works on any chrome
 * document, so the same module can retint the whole browser later.
 *
 * Every consumer must keep working when the file is absent - that is the
 * common case. `apply()` resolves to false and sets nothing, so stylesheets
 * written as `var(--zen-m3-x, <browser token>)` fall back on their own.
 */

const PALETTE_ATTR = "zen-material-palette";
const PROP_PREFIX = "--zen-m3-";
const REL_PATH = "quickshell/user/generated/material_colors.scss";

// A palette we would not be able to build a readable page out of is no
// palette at all; these are the keys every consumer assumes.
const REQUIRED_KEYS = ["background", "onBackground", "surface", "onSurface", "primary"];


/* ---- Palette from one colour -------------------------------------------
 * The "custom colours" option: an accent picked in Settings is turned into the
 * same set of role colours the desktop's generator writes, under the same key
 * names, so every stylesheet that reads --zen-m3-<key> follows without change.
 * Roles use Material 3's tone tables; tone is mapped to OKLab lightness
 * (cbrt of the CIE luminance), and chroma is reduced until the colour fits
 * sRGB. The accent itself becomes primaryContainer, the vivid fill. */

const srgbToLinear = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = c => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function hexToOklch(hex) {
  const n = parseInt(hex.slice(1, 7), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => srgbToLinear(v / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(a, bb), ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360];
}

function oklchToLinear(L, C, h) {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** A colour of this lightness and hue, with as much chroma as fits sRGB. */
function oklchHex(L, C, h) {
  let rgb = oklchToLinear(L, C, h);
  for (let i = 0; i < 24 && rgb.some(v => v < -0.0005 || v > 1.0005); i++) {
    C *= 0.9;
    rgb = oklchToLinear(L, C, h);
  }
  return (
    "#" +
    rgb
      .map(v => Math.round(Math.min(1, Math.max(0, linearToSrgb(Math.min(1, Math.max(0, v))))) * 255)
        .toString(16)
        .padStart(2, "0"))
      .join("")
  );
}

/** Material tone (CIE L*) as OKLab lightness. */
const toneToL = tone => {
  const f = (tone + 16) / 116;
  return Math.cbrt(tone > 8 ? f ** 3 : tone / 903.3);
};

// role -> [palette, dark tone, light tone]
const ROLES = {
  background: ["n", 6, 98], onBackground: ["n", 90, 10],
  surface: ["n", 6, 98], surfaceDim: ["n", 6, 87], surfaceBright: ["n", 24, 98],
  surfaceContainerLowest: ["n", 4, 100], surfaceContainerLow: ["n", 10, 96],
  surfaceContainer: ["n", 12, 94], surfaceContainerHigh: ["n", 17, 92],
  surfaceContainerHighest: ["n", 22, 90],
  onSurface: ["n", 90, 10], surfaceVariant: ["nv", 30, 90], onSurfaceVariant: ["nv", 80, 30],
  inverseSurface: ["n", 90, 20], inverseOnSurface: ["n", 20, 95],
  outline: ["nv", 60, 50], outlineVariant: ["nv", 30, 80],
  primary: ["p", 80, 40], onPrimary: ["p", 20, 100], onPrimaryContainer: ["p", 90, 10],
  inversePrimary: ["p", 40, 80],
  secondary: ["s", 80, 40], onSecondary: ["s", 20, 100],
  secondaryContainer: ["s", 30, 90], onSecondaryContainer: ["s", 90, 10],
  tertiary: ["t", 80, 40], onTertiary: ["t", 20, 100],
  tertiaryContainer: ["t", 30, 90], onTertiaryContainer: ["t", 90, 10],
  error: ["e", 80, 40], onError: ["e", 20, 100],
  errorContainer: ["e", 30, 90], onErrorContainer: ["e", 90, 10],
  surfaceTint: ["p", 80, 40],
};

export const ZenMaterialPalette = {
  /** Applied colours, or null. Shared so a second caller need not re-read. */
  _cache: null,
  _cachePath: null,

  /**
   * `$XDG_STATE_HOME/quickshell/...`, falling back to `~/.local/state`.
   * Returns null where the layout cannot exist (Windows, macOS).
   */
  defaultPath() {
    let state = Services.env.get("XDG_STATE_HOME");
    if (!state) {
      // No HOME is how this comes back on the platforms that have no such
      // directory at all, so there is no separate platform check.
      let home = Services.env.get("HOME");
      if (!home) {
        return null;
      }
      state = PathUtils.join(home, ".local", "state");
    }
    return PathUtils.join(state, ...REL_PATH.split("/"));
  },

  /**
   * Parse `$key: value;` lines. Only colour-valued keys are kept, plus the
   * `$darkmode` flag, which says which scheme the palette was generated for.
   */
  parse(text) {
    const colors = new Map();
    let darkmode = null;
    const line = /^[ \t]*\$([A-Za-z0-9_]+)[ \t]*:[ \t]*([^;]+);/gm;
    for (const [, key, rawValue] of text.matchAll(line)) {
      const value = rawValue.trim();
      if (key === "darkmode") {
        darkmode = /^true$/i.test(value);
      } else if (/^#[0-9a-fA-F]{3,8}$/.test(value)) {
        colors.set(key, value);
      }
    }
    if (!REQUIRED_KEYS.every(k => colors.has(k))) {
      return null;
    }
    return { colors, darkmode: darkmode ?? this._isDark(colors.get("background")) };
  },

  /** Luminance of the background, for a file that predates the flag. */
  _isDark(hex) {
    const n = parseInt(hex.slice(1, 7).padEnd(6, "0"), 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5;
  },

  async read(path = this.defaultPath()) {
    if (!path) {
      return null;
    }
    if (this._cache && this._cachePath === path) {
      return this._cache;
    }
    let text;
    try {
      text = await IOUtils.readUTF8(path);
    } catch (e) {
      return null; // Absent is the normal case, not an error.
    }
    const parsed = this.parse(text);
    if (parsed) {
      this._cache = parsed;
      this._cachePath = path;
    }
    return parsed;
  },

  /**
   * The full role set for one accent colour, as `{ colors, darkmode }` - the
   * shape parse() returns - so it can be applied like a desktop palette.
   */
  fromSeed(seed, dark = true) {
    if (!/^#[0-9a-fA-F]{6}$/.test(seed)) {
      return null;
    }
    const [seedL, seedC, hue] = hexToOklch(seed);
    const chroma = Math.min(Math.max(seedC, 0.07), 0.16);
    const palettes = {
      p: [hue, chroma], s: [hue, chroma * 0.4], t: [(hue + 60) % 360, chroma * 0.65],
      n: [hue, 0.012], nv: [hue, 0.02], e: [25, 0.16],
    };
    const colors = new Map();
    for (const [role, [pal, darkTone, lightTone]] of Object.entries(ROLES)) {
      const [h, c] = palettes[pal];
      colors.set(role, oklchHex(toneToL(dark ? darkTone : lightTone), c, h));
    }
    // The accent is the vivid fill; the text on it is whichever reads better.
    colors.set("primaryContainer", seed.toLowerCase());
    colors.set("onPrimaryContainer", oklchHex(toneToL(seedL > 0.62 ? 8 : 98), 0.02, hue));
    return { colors, darkmode: dark };
  },

  /** Set a palette's roles on a document, as apply() does for the file. */
  set(doc, palette) {
    const root = doc?.documentElement;
    if (!palette || !root) {
      return false;
    }
    for (const [key, value] of palette.colors) {
      root.style.setProperty(PROP_PREFIX + key, value);
    }
    root.style.colorScheme = palette.darkmode ? "dark" : "light";
    root.setAttribute(PALETTE_ATTR, palette.darkmode ? "dark" : "light");
    return true;
  },

  /**
   * Read the palette and set it on `doc`. Resolves to true when the document
   * was retinted. `{ path }` overrides the file, for tests.
   *
   * The palette decides the page's light/dark state rather than the browser:
   * these are the desktop's colours, and half-applying them - a dark shell
   * palette on a light page - is how you get unreadable text.
   */
  async apply(doc, { path } = {}) {
    // A custom palette (see fromSeed) is the user's choice over the file.
    if (doc?.documentElement?.hasAttribute("zen-palette-custom")) {
      return false;
    }
    return this.set(doc, await this.read(path));
  },

  clear(doc) {
    const root = doc?.documentElement;
    if (!root) {
      return;
    }
    for (const key of this._cache?.colors.keys() ?? []) {
      root.style.removeProperty(PROP_PREFIX + key);
    }
    root.style.removeProperty("color-scheme");
    root.removeAttribute(PALETTE_ATTR);
  },

  /**
   * Keep a window's theme in step with the prefs: the `zen-theme-style` tag
   * its stylesheets hang off, and the palette those stylesheets read. A
   * custom accent wins over the desktop's file. One implementation for the
   * browser window and about:preferences, so they cannot disagree.
   *
   * `paletteInDefault`: also load the desktop palette when the theme is the
   * default one (the Settings page has always followed it).
   */
  syncTheme(win, { paletteInDefault = false } = {}) {
    const PREFS = ["zen.theme.style", "zen.theme.palette", "zen.theme.accent", "zen.theme.scheme"];
    const prefs = Services.prefs;
    const doc = win.document;
    const root = doc.documentElement;
    let watched = false;
    const apply = () => {
      const style = prefs.getStringPref("zen.theme.style", "default");
      root.setAttribute("zen-theme-style", style);
      root.removeAttribute("zen-palette-custom");
      const custom = style !== "default" && prefs.getStringPref("zen.theme.palette", "desktop") === "custom";
      if (custom) {
        const scheme = prefs.getStringPref("zen.theme.scheme", "dark");
        const dark = scheme === "auto" ? win.matchMedia("(prefers-color-scheme: dark)").matches : scheme !== "light";
        const palette = this.fromSeed(prefs.getStringPref("zen.theme.accent", "#478fff"), dark);
        if (palette) {
          root.setAttribute("zen-palette-custom", "true");
          this.set(doc, palette);
          return;
        }
      }
      if (style === "default" && !paletteInDefault) {
        this.clear(doc);
        return;
      }
      if (!paletteInDefault && !prefs.getBoolPref("zen.material.follow-desktop-palette", true)) {
        return;
      }
      this.apply(doc).then(applied => {
        if (applied && !watched) {
          watched = true;
          this.watch(win);
        }
      });
    };
    apply();
    for (const name of PREFS) {
      prefs.addObserver(name, apply);
    }
    win.addEventListener("unload", () => PREFS.forEach(name => prefs.removeObserver(name, apply)), { once: true });
  },

  /**
   * Keep `doc` in step with the file. The palette is regenerated on wallpaper
   * change, so re-read when the window is next focused rather than polling.
   */
  watch(win, options) {
    const refresh = () => {
      this._cache = null;
      this.apply(win.document, options);
    };
    win.addEventListener("focus", refresh);
    win.addEventListener("unload", () => win.removeEventListener("focus", refresh), {
      once: true,
    });
  },
};
