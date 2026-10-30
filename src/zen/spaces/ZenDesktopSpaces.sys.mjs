/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Spaces tied to virtual desktops: a Zen window on desktop N shows that
 * desktop's space. A window can only take focus on the current desktop, so
 * "which desktop is current" asked on focus is all any desktop must answer.
 * Read-only: nothing here moves a window or switches a desktop.
 *
 * Which space: one pinned to N in zen.spaces.desktop.map ({uuid: N}, 0 =
 * never), else the Nth space among those not pinned. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
});

const PREF_ENABLED = "zen.spaces.desktop.enabled";
const PREF_MAP = "zen.spaces.desktop.map";

/* Each reader: the tool it runs, its arguments, and a pure parser from that
   tool's output to a 1-based desktop number (null when it cannot tell). */
export const READERS = {
  hyprland: {
    command: "hyprctl",
    args: ["-j", "activeworkspace"],
    // Special (scratchpad) workspaces have negative ids.
    parse: out => {
      const id = JSON.parse(out)?.id;
      return id > 0 ? id : null;
    },
  },
  sway: {
    command: "swaymsg",
    args: ["-t", "get_workspaces", "-r"],
    parse: out => JSON.parse(out).find(w => w.focused)?.num ?? null,
  },
  i3: {
    command: "i3-msg",
    args: ["-t", "get_workspaces"],
    parse: out => JSON.parse(out).find(w => w.focused)?.num ?? null,
  },
  // Plasma 5 and 6, X11 and Wayland: KWin's desktops are ids in order.
  kde: {
    command: "gdbus",
    args: [
      "call", "--session", "--dest", "org.kde.KWin",
      "--object-path", "/VirtualDesktopManager",
      "--method", "org.freedesktop.DBus.Properties.GetAll",
      "org.kde.KWin.VirtualDesktopManager",
    ],
    parse: out => {
      const current = /'current': <'([^']+)'>/.exec(out)?.[1];
      const ids = [...out.matchAll(/\(uint32 \d+, '([^']+)'/g)].map(m => m[1]);
      const index = ids.indexOf(current);
      return index >= 0 ? index + 1 : null;
    },
  },
  // XFCE, Cinnamon, MATE, LXQt, Openbox, GNOME on X11 - and GNOME on
  // Wayland, which keeps the same property on XWayland's root.
  ewmh: {
    command: "xprop",
    args: ["-root", "-notype", "_NET_CURRENT_DESKTOP"],
    parse: out => {
      const n = /_NET_CURRENT_DESKTOP\s*=\s*(\d+)/.exec(out)?.[1];
      return n === undefined ? null : Number(n) + 1;
    },
  },
};

export const ZenDesktopSpaces = {
  _started: false,
  // window -> desktop number it was last seen on.
  _seen: new WeakMap(),
  _reader: undefined,

  get enabled() {
    return Services.prefs.getBoolPref(PREF_ENABLED, false);
  },

  /* The reader for this session, by what the session itself says it is. */
  detect(env = name => Services.env.get(name)) {
    const desktop = (env("XDG_CURRENT_DESKTOP") || "").toLowerCase();
    if (env("HYPRLAND_INSTANCE_SIGNATURE")) {
      return "hyprland";
    }
    if (env("SWAYSOCK")) {
      return "sway";
    }
    if (env("I3SOCK") || desktop.includes("i3")) {
      return "i3";
    }
    if (desktop.includes("kde")) {
      return "kde";
    }
    if (env("DISPLAY")) {
      return "ewmh";
    }
    return null;
  },

  get map() {
    try {
      return JSON.parse(Services.prefs.getStringPref(PREF_MAP, "{}")) || {};
    } catch {
      return {};
    }
  },

  setPin(uuid, desktop) {
    const map = this.map;
    if (desktop === null || desktop === undefined) {
      delete map[uuid];
    } else {
      map[uuid] = desktop;
    }
    Services.prefs.setStringPref(PREF_MAP, JSON.stringify(map));
  },

  spaceFor(spaces, desktop, map = this.map) {
    if (!(desktop > 0)) {
      return null;
    }
    const pinned = spaces.find(s => map[s.uuid] === desktop);
    if (pinned) {
      return pinned;
    }
    return spaces.filter(s => !(s.uuid in map))[desktop - 1] || null;
  },

  /* The current desktop, or null with the reason (for Settings to show). */
  async current() {
    const name = this.detect();
    const reader = READERS[name];
    if (!reader) {
      return { desktop: null, reader: null, error: "unsupported" };
    }
    try {
      const command = await lazy.Subprocess.pathSearch(reader.command);
      const proc = await lazy.Subprocess.call({ command, arguments: reader.args, stderr: "pipe" });
      let out = "";
      let chunk;
      while ((chunk = await proc.stdout.readString())) {
        out += chunk;
      }
      const { exitCode } = await proc.wait();
      const desktop = exitCode === 0 ? reader.parse(out) : null;
      return { desktop, reader: name, error: desktop ? null : "no-answer" };
    } catch (e) {
      // pathSearch throws when the tool is not installed.
      return { desktop: null, reader: name, error: "missing-tool", tool: reader.command };
    }
  },

  init() {
    if (this._started) {
      return;
    }
    this._started = true;
    Services.obs.addObserver(win => this._watch(win), "browser-delayed-startup-finished");
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      this._watch(win);
    }
    Services.prefs.addObserver(PREF_ENABLED, () => {
      const win = Services.wm.getMostRecentWindow("navigator:browser");
      if (this.enabled && win?.document.hasFocus()) {
        this._seen.delete(win);
        this._check(win);
      }
    });
  },

  _watch(win) {
    if (win._zenDesktopWatched) {
      return;
    }
    win._zenDesktopWatched = true;
    win.addEventListener("activate", () => this.enabled && this._check(win));
    if (this.enabled && win.document.hasFocus()) {
      this._check(win);
    }
  },

  async _check(win) {
    const { desktop } = await this.current();
    if (!desktop || win.closed) {
      return;
    }
    // Refocusing on the same desktop keeps a space picked by hand.
    if (this._seen.get(win) === desktop) {
      return;
    }
    this._seen.set(win, desktop);
    const spaces = win.gZenWorkspaces;
    if (!spaces?.workspaceEnabled || typeof win.gZenTor?.windowContextId === "number") {
      return;
    }
    const space = this.spaceFor(spaces.getWorkspaces(), desktop);
    if (space && space.uuid !== spaces.getActiveWorkspace()?.uuid) {
      spaces.changeWorkspace(space).catch(e => console.error("[zen-desktop-spaces]", e));
    }
  },
};
