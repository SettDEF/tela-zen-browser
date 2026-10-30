#!/usr/bin/env python3
"""The dotfile (~/.config/tela-zen/config.toml). A private file stands in for
the user's: applied before the first window, bad lines reported with their
line numbers while the rest still apply, saved edits picked up live, a
deleted line handing the setting back (including a value set in Settings),
the Settings section, and a generated file that reads back with no errors.
Second monitor."""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import regress

DIR = "/tmp/claude-1000/config-test"
FILE = f"{DIR}/config.toml"
NEW = f"{DIR}/fresh/config.toml"
RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append(ok)
    print(("ok    " if ok else "FAIL  ") + f"{name:46} {detail}", flush=True)


FIRST = """# my tela
[tabs]
colors = "all"     # every tab
radius = 12
height = 1.5

[glow]
strength = "off"
sparkle = true

[prefs]
"browser.startup.page" = 2
zen.tabs.look.close = "always"
broken line
"""

SECOND = """[tabs]
colors = "selected"
"""

os.makedirs(DIR, exist_ok=True)
for p in (FILE, NEW):
    if os.path.exists(p):
        os.remove(p)
with open(FILE, "w") as f:
    f.write(FIRST)

STATE = """
  const C = ChromeUtils.importESModule('resource:///modules/zen/TelaConfig.sys.mjs').TelaConfig;
  const P = Services.prefs, root = document.documentElement;
  return JSON.stringify({status: C.status,
    colors: P.getStringPref('zen.tabs.look.color'), radius: P.getIntPref('zen.tabs.look.radius'),
    strength: P.getStringPref('zen.tabs.focus.strength'), startup: P.getIntPref('browser.startup.page'),
    close: P.getStringPref('zen.tabs.look.close'),
    startupDefault: P.getDefaultBranch('').getIntPref('browser.startup.page'),
    locked: ['zen.tabs.look.color', 'zen.tabs.look.radius', 'browser.startup.page'].map(p => P.prefIsLocked(p)),
    attrs: [root.getAttribute('zen-tab-color'), root.getAttribute('zen-tab-focus')]});"""

port = regress.free_port()
proc = regress.launch("/tmp/claude-1000/config-profile", port,
                      prefs=f'user_pref("zen.config.file", "{FILE}");\n'
                            'user_pref("zen.tabs.look.radius", 4);\n')
try:
    m = regress.Marionette(port)
    time.sleep(3)
    s = m.js(STATE)
    check("startup: file values applied", s["colors"] == "all" and s["radius"] == 12
          and s["strength"] == "off" and s["startup"] == 2 and s["close"] == "always", s)
    check("startup: the window drew with them", s["attrs"] == ["all", "flat"], s["attrs"])
    check("file beats a value set in Settings", s["radius"] == 12, "user value 4 in prefs.js")
    check("file's settings are locked", all(s["locked"]), s["locked"])
    errs = {e["line"]: e["message"] for e in s["status"]["errors"]}
    check("bad lines reported by line number", sorted(errs) == [5, 9, 14], errs)
    check("good lines still applied around them", len(s["status"]["applied"]) == 5, s["status"]["applied"])

    with open(FILE + ".tmp", "w") as f:
        f.write(SECOND)
    os.replace(FILE + ".tmp", FILE)
    time.sleep(2.5)
    s = m.js(STATE)
    check("saved edit applies live", s["colors"] == "selected" and s["attrs"][0] == "selected", s["colors"])
    check("deleted line: the user's own value is back", s["radius"] == 4 and not s["locked"][1], s["radius"])
    check("deleted line: default restored", s["strength"] == "full" and s["close"] == "hover"
          and s["startup"] == s["startupDefault"] == 3, s)
    check("no errors left", not s["status"]["errors"], s["status"]["errors"])

    m.js("gBrowser.selectedTab = gBrowser.addTab('about:preferences#zenLooks',"
         " {triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()}); return '1';")
    time.sleep(4)
    pane = m.js("""
      const d = gBrowser.selectedBrowser.contentDocument;
      const colorList = d.querySelector('menulist[preference="zen.tabs.look.color"]');
      return JSON.stringify({path: d.getElementById('zenConfigPath').textContent,
        status: d.getElementById('zenConfigStatus').textContent,
        open: !d.getElementById('zenConfigOpen').hidden, colorDisabled: colorList?.disabled});""")
    check("settings: shows the file and its status", pane["path"] == FILE and "Applied 1 setting" in pane["status"],
          pane)
    check("settings: file's setting greyed out", pane["colorDisabled"] is True, pane["colorDisabled"])

    gen = m.js("""
      const C = ChromeUtils.importESModule('resource:///modules/zen/TelaConfig.sys.mjs').TelaConfig;
      const { parse } = ChromeUtils.importESModule('resource:///modules/zen/TelaConfig.sys.mjs');
      const text = C.generate();
      const r = parse(text);
      return JSON.stringify({errors: r.errors, live: r.entries.map(e => e.pref), lines: text.split('\\n').length});""")
    check("generated file reads back clean", not gen["errors"] and gen["lines"] > 30, gen["errors"])
    check("generated file keeps the live settings", "zen.tabs.look.color" in gen["live"], gen["live"])
finally:
    try:
        proc.terminate(); proc.wait(15)
    except Exception:
        pass
print(f"{sum(RESULTS)}/{len(RESULTS)} passed")
sys.exit(0 if all(RESULTS) else 1)
