#!/usr/bin/env python3
"""Spaces per virtual desktop, and Ctrl+number for spaces.

Every desktop's reader is checked against that tool's real output format; the
live read only on the desktop this runs on (Hyprland here). Switching is driven
through the module's own check with the desktop number supplied, since moving
a window between desktops would move the user's session. Second monitor."""
import json, os, subprocess, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import regress

RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append(ok)
    print(("ok    " if ok else "FAIL  ") + f"{name:44} {detail}", flush=True)


MOD = 'const M = ChromeUtils.importESModule("resource:///modules/zen/ZenDesktopSpaces.sys.mjs");'

# Output shapes as each tool prints them.
FIXTURES = {
    "hyprland": ('{"id": 3, "name": "3", "monitor": "DP-1", "windows": 2}', 3),
    "sway": ('[{"num": 1, "focused": false}, {"num": 4, "focused": true}]', 4),
    "i3": ('[{"num": 2, "focused": true, "name": "2"}]', 2),
    "kde": ("({'id': <'aaa'>, 'count': <uint32 3>, 'current': <'ccc'>, 'rows': <uint32 1>,"
            " 'desktops': <[(uint32 0, 'aaa', 'Desktop 1'), (uint32 1, 'bbb', 'Desktop 2'),"
            " (uint32 2, 'ccc', 'Desktop 3')]>, 'navigationWrappingAround': <true>},)", 3),
    "ewmh": ("_NET_CURRENT_DESKTOP = 1\n", 2),
}
ENVS = [
    ({"HYPRLAND_INSTANCE_SIGNATURE": "x", "XDG_CURRENT_DESKTOP": "Hyprland"}, "hyprland"),
    ({"SWAYSOCK": "/run/sway", "XDG_CURRENT_DESKTOP": "sway"}, "sway"),
    ({"I3SOCK": "/run/i3", "DISPLAY": ":0"}, "i3"),
    ({"XDG_CURRENT_DESKTOP": "KDE", "WAYLAND_DISPLAY": "wayland-0"}, "kde"),
    ({"XDG_CURRENT_DESKTOP": "XFCE", "DISPLAY": ":0"}, "ewmh"),
    ({"XDG_CURRENT_DESKTOP": "GNOME", "DISPLAY": ":0", "WAYLAND_DISPLAY": "wayland-0"}, "ewmh"),
    ({"XDG_CURRENT_DESKTOP": "GNOME", "WAYLAND_DISPLAY": "wayland-0"}, None),
]

port = regress.free_port()
proc = regress.launch("/tmp/claude-1000/desktop-spaces-profile", port,
                      prefs='user_pref("zen.glass.file", "/nonexistent");\n')
try:
    m = regress.Marionette(port)
    time.sleep(3)

    parsed = m.js(MOD + "return JSON.stringify(Object.fromEntries(Object.entries(%s).map("
                  "([k, [out]]) => [k, M.READERS[k].parse(out)])));" % json.dumps(FIXTURES))
    for name, (_, want) in FIXTURES.items():
        check(f"reader {name}: parses its tool's output", parsed[name] == want, f"{parsed[name]} want {want}")

    got = m.js(MOD + "return JSON.stringify(%s.map(([e]) => M.ZenDesktopSpaces.detect(n => e[n])));"
               % json.dumps(ENVS))
    check("each session finds its reader", got == [w for _, w in ENVS], got)

    live = m.js(MOD + "return JSON.stringify(await M.ZenDesktopSpaces.current());")
    truth = json.loads(subprocess.run(["hyprctl", "-j", "activeworkspace"], capture_output=True,
                                      text=True, env=regress._hypr_env()).stdout)["id"]
    check("live: Hyprland's current desktop", live.get("reader") == "hyprland" and live.get("desktop") == truth,
          f"{live} hyprctl={truth}")

    # Three spaces, then the switching rules.
    names = m.js("""
      for (const n of ['Two', 'Three']) await gZenWorkspaces.createAndSaveWorkspace(n, undefined, true);
      await new Promise(r => setTimeout(r, 800));
      return JSON.stringify(gZenWorkspaces.getWorkspaces().map(s => s.name));""")
    check("three spaces to work with", len(names) == 3, names)

    RUN = MOD + """
      const Z = M.ZenDesktopSpaces;
      const real = Z.current;
      Z.current = async () => ({desktop: %d, reader: 'test'});
      try { Services.prefs.setBoolPref('zen.spaces.desktop.enabled', true); await Z._check(window); }
      finally { Z.current = real; }
      await new Promise(r => setTimeout(r, 1500));
      return JSON.stringify(gZenWorkspaces.getActiveWorkspace().name);"""
    check("desktop 2 shows the second space", m.js(RUN % 2) == "Two")
    check("desktop 3 shows the third", m.js(RUN % 3) == "Three")
    m.js("await gZenWorkspaces.changeWorkspace(gZenWorkspaces.getWorkspaces()[0]);"
         " await new Promise(r => setTimeout(r, 1200)); return '1';")
    check("refocus on the same desktop keeps your pick", m.js(RUN % 3) != "Three")
    m.js(MOD + "const s = gZenWorkspaces.getWorkspaces(); M.ZenDesktopSpaces.setPin(s[2].uuid, 1);"
         " M.ZenDesktopSpaces._seen = new WeakMap(); return '1';")
    check("a pin beats position", m.js(RUN % 1) == "Three")
    m.js(MOD + "M.ZenDesktopSpaces._seen = new WeakMap(); return '1';")
    check("unpinned spaces fill in by position", m.js(RUN % 2) == "Two")
    m.js("Services.prefs.clearUserPref('zen.spaces.desktop.map'); return '1';")

    # Ctrl+2 / Ctrl+1: synthesized into this test window only.
    def key(n):
        m.cmd("WebDriver:PerformActions", {"actions": [{"type": "key", "id": "kb", "actions": [
            {"type": "keyDown", "value": ""}, {"type": "keyDown", "value": str(n)},
            {"type": "keyUp", "value": str(n)}, {"type": "keyUp", "value": ""}]}]})
        m.cmd("WebDriver:ReleaseActions", {})
        time.sleep(1.5)
        return m.js("return JSON.stringify(gZenWorkspaces.getActiveWorkspace().name);")
    m.js("window.focus(); gBrowser.selectedBrowser.focus(); return '1';")
    kbs = m.js("return JSON.stringify([Services.prefs.getIntPref('zen.keyboard.shortcuts.version'),"
               " document.getElementById('zen-workspace-switch-2')?.getAttribute('modifiers'),"
               " document.getElementById('zen-workspace-switch-2')?.getAttribute('key')]);")
    check("Ctrl+N registered for spaces", kbs[1] in ("control", "ctrl", "accel") and kbs[2] == "2", kbs)
    check("Ctrl+2 goes to space 2", key(2) == "Two")
    check("Ctrl+1 goes back to space 1", key(1) == names[0])

    m.js("gBrowser.selectedTab = gBrowser.addTab('about:preferences#zenTabManagement',"
         " {triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()}); return '1';")
    time.sleep(4)
    pane = m.js("""
      const d = gBrowser.selectedBrowser.contentDocument;
      const rows = [...d.querySelectorAll('#zenSpacesList .zen-spaces-row')];
      await new Promise(r => setTimeout(r, 1000));
      return JSON.stringify({rows: rows.map(r => r.querySelector('.zen-spaces-name').textContent),
        picks: rows.map(r => r.querySelector('select').value),
        options: rows[0]?.querySelector('select').options[0].textContent,
        status: d.getElementById('zenSpacesDesktopStatus').textContent,
        follow: d.getElementById('zenSpacesFollowDesktop').checked,
        newLabel: d.getElementById('zenSpacesNew').label});""")
    check("settings list every space", pane["rows"] == names, pane["rows"])
    check("settings: labelled, says it works here", pane["options"] and pane["newLabel"]
          and "hyprland" in (pane["status"] or ""), pane)
finally:
    try:
        proc.terminate(); proc.wait(15)
    except Exception:
        pass
print(f"{sum(RESULTS)}/{len(RESULTS)} passed")
sys.exit(0 if all(RESULTS) else 1)
