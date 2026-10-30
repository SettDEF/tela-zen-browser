#!/usr/bin/env python3
"""Tab looks (#78): glow strength, selected style, close button, radius,
height, hover shade and folder spacing, each live from its pref, plus the
Settings section that sets them. Second monitor."""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import regress

RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append(ok)
    print(("ok    " if ok else "FAIL  ") + f"{name:40} {detail}", flush=True)


def setpref(m, key, value):
    kind = "Int" if isinstance(value, int) and not isinstance(value, bool) else (
        "Bool" if isinstance(value, bool) else "String")
    m.js(f"Services.prefs.set{kind}Pref({json.dumps(key)}, {json.dumps(value)}); return '1';")
    time.sleep(0.6)


STATE = """
  const sel = gBrowser.selectedTab, other = gBrowser.tabs.find(t => t.label.startsWith('Gort'));
  const bg = t => getComputedStyle(t.querySelector('.tab-background'));
  const mark = getComputedStyle(sel, '::before');
  const folders = [...document.querySelectorAll('zen-folder')].map(f => f.getBoundingClientRect());
  const tabs = document.getElementById('tabbrowser-tabs').getBoundingClientRect();
  const markLeft = sel.getBoundingClientRect().left + parseFloat(mark.left);
  return JSON.stringify({
    layers: document.querySelectorAll('.zen-tab-focus-layer').length,
    halo: [...document.querySelectorAll('.zen-tab-focus-halo')].map(h => getComputedStyle(h).display),
    focus: document.documentElement.getAttribute('zen-tab-focus'),
    selBg: bg(sel).backgroundColor, selShadow: bg(sel).boxShadow, radius: bg(sel).borderTopLeftRadius,
    weight: getComputedStyle(sel.querySelector('.tab-label')).fontWeight,
    markOpacity: mark.opacity, markInside: markLeft >= tabs.left,
    closeOther: getComputedStyle(other.querySelector('.tab-close-button')).display,
    otherBg: bg(other).backgroundColor,
    height: Math.round(other.getBoundingClientRect().height),
    folderGap: folders.length > 1 ? Math.round(folders[1].top - folders[0].bottom) : null,
  });"""

port = regress.free_port()
proc = regress.launch("/tmp/claude-1000/tab-looks-profile", port,
                      prefs='user_pref("zen.tabs.focus.preset", "pulse");\n'
                            'user_pref("zen.glass.file", "/nonexistent");\n')
try:
    m = regress.Marionette(port)
    time.sleep(3)
    m.js("""
      const P = Services.scriptSecurityManager.getSystemPrincipal();
      const t = ['https://example.com/', 'https://example.org/', 'about:robots', 'about:mozilla',
                 'about:license', 'about:buildconfig'].map(u => gBrowser.addTab(u, {triggeringPrincipal: P}));
      gZenFolders.createFolder([t[0]], {label: 'A', renameFolder: false});
      gZenFolders.createFolder([t[1]], {label: 'B', renameFolder: false});
      gBrowser.selectedTab = t[4];
      return '1';""")
    time.sleep(2.5)

    s = m.js(STATE)
    check("defaults: glow on, mark shown", s["layers"] > 0 and s["markOpacity"] == "1", s["focus"])
    check("mark drawn inside the tab list", s["markInside"])
    check("folders get a gap by default", s["folderGap"] is not None and s["folderGap"] >= 5, s["folderGap"])
    check("close button only on hover", s["closeOther"] == "none", s["closeOther"])

    setpref(m, "zen.tabs.focus.strength", "subtle")
    s = m.js(STATE)
    check("subtle: no spill outside the tab", s["layers"] > 0 and all(h == "none" for h in s["halo"]), s["halo"])
    setpref(m, "zen.tabs.focus.strength", "off")
    s = m.js(STATE)
    check("off: no glow layers at all", s["layers"] == 0 and s["focus"] == "flat", s)
    setpref(m, "zen.tabs.focus.strength", "full")
    s = m.js(STATE)
    check("full again: layers back", s["layers"] > 0 and s["focus"] == "pulse", s["focus"])

    setpref(m, "zen.tabs.look.selected", "fill")
    s = m.js(STATE)
    check("fill: tinted, no mark", s["selBg"] != "rgba(0, 0, 0, 0)" and s["markOpacity"] == "0", s["selBg"])
    setpref(m, "zen.tabs.look.selected", "outline")
    time.sleep(2)
    s = m.js(STATE)
    check("outline: ring, no fill", "inset" in s["selShadow"] and s["selBg"] == "rgba(0, 0, 0, 0)", (s["selBg"], s["selShadow"]))
    setpref(m, "zen.tabs.look.selected", "plain")
    s = m.js(STATE)
    check("plain: bold label only", s["weight"] == "600" and s["markOpacity"] == "0", s["weight"])

    setpref(m, "zen.tabs.look.close", "always")
    check("close: always", m.js(STATE)["closeOther"] != "none")
    setpref(m, "zen.tabs.look.close", "never")
    m.js("const t = gBrowser.tabs.find(t => t.label.startsWith('Gort'));"
         "InspectorUtils.addPseudoClassLock(t, ':hover'); return '1';")
    time.sleep(0.3)
    check("close: never, even on hover", m.js(STATE)["closeOther"] == "none")

    before = m.js(STATE)["otherBg"]
    setpref(m, "zen.tabs.look.hover-shade", False)
    after = m.js(STATE)["otherBg"]
    check("hover shade can be switched off", before != "rgba(0, 0, 0, 0)" and after == "rgba(0, 0, 0, 0)",
          f"{before} -> {after}")

    setpref(m, "zen.tabs.look.radius", 12)
    setpref(m, "zen.tabs.look.height", 28)
    setpref(m, "zen.tabs.look.folder-gap", 12)
    s = m.js(STATE)
    check("radius follows the pref", s["radius"] == "12px", s["radius"])
    check("height follows the pref", 26 <= s["height"] <= 32, s["height"])
    check("folder gap follows the pref", s["folderGap"] is not None and s["folderGap"] >= 11, s["folderGap"])

    # Tab colours: the selected tab's own colour drives its selection.
    for k in ("zen.tabs.look.radius", "zen.tabs.look.height", "zen.tabs.look.hover-shade"):
        m.js(f"Services.prefs.clearUserPref({json.dumps(k)}); return '1';")
    m.js("InspectorUtils.clearPseudoClassLocks(gBrowser.tabs.find(t => t.label.startsWith('Gort'))); return '1';")
    COLOR = """
      const sel = gBrowser.selectedTab, gort = gBrowser.tabs.find(t => t.label.startsWith('Gort'));
      const plain = gBrowser.tabs.find(t => t.label.startsWith('The Book'));
      const bg = t => getComputedStyle(t.querySelector('.tab-background'));
      return JSON.stringify({selBg: bg(sel).backgroundColor, selShadow: bg(sel).boxShadow,
        mark: getComputedStyle(sel, '::before').backgroundColor,
        gortBg: bg(gort).backgroundColor, plainBg: bg(plain).backgroundColor,
        colored: [sel, gort, plain].map(t => t.hasAttribute('zen-tab-colored'))});"""
    m.js("""
      const sel = gBrowser.selectedTab, gort = gBrowser.tabs.find(t => t.label.startsWith('Gort'));
      gZenTabFocus.setTabColor(sel, 'a', '#ff3b3b');
      gZenTabFocus.setTabColor(gort, 'a', '#3b6bff');
      return '1';""")
    setpref(m, "zen.tabs.look.selected", "mark")
    setpref(m, "zen.tabs.look.color", "selected")
    c = m.js(COLOR)
    check("colours: only coloured tabs marked", c["colored"] == [True, True, False], c["colored"])
    check("selected: mark in the tab's colour", c["mark"].startswith("rgb(255, 59, 59"), c["mark"])
    check("selected: unselected tabs untouched", c["gortBg"] == "rgba(0, 0, 0, 0)", c["gortBg"])
    setpref(m, "zen.tabs.look.selected", "outline")
    c = m.js(COLOR)
    check("selected: outline in the tab's colour", "255, 59, 59" in c["selShadow"].replace("0.8", "")
          or "1 0.231" in c["selShadow"], c["selShadow"])
    setpref(m, "zen.tabs.look.color", "all")
    c = m.js(COLOR)
    check("every tab: coloured tabs tinted", c["gortBg"] != "rgba(0, 0, 0, 0)", c["gortBg"])
    check("every tab: uncoloured tab untouched", c["plainBg"] == "rgba(0, 0, 0, 0)", c["plainBg"])
    m.screenshot("/tmp/claude-1000/tab-colours.png")
    setpref(m, "zen.tabs.look.color", "off")
    c = m.js(COLOR)
    check("off: no tab colours drawn", c["gortBg"] == "rgba(0, 0, 0, 0)"
          and not c["mark"].startswith("rgb(255, 59, 59"), c)
    menu = m.js("""
      const item = document.getElementById('zen-tab-focus-color-menu');
      return JSON.stringify([item?.parentElement?.parentElement?.id, item?.getAttribute('label')]);""")
    check("right-click > Appearance > Colour", menu[0] == "context_zenTabAppearance", menu)
    setpref(m, "zen.tabs.look.color", "selected")

    # The Settings section: rendered, labelled, and wired to the prefs.
    m.js("""
      const P = Services.scriptSecurityManager.getSystemPrincipal();
      gBrowser.selectedTab = gBrowser.addTab('about:preferences#zenLooks', {triggeringPrincipal: P});
      return '1';""")
    time.sleep(4)
    pane = m.js("""
      const doc = gBrowser.selectedBrowser.contentDocument;
      const lists = [...doc.querySelectorAll('menulist[preference^="zen.tabs.look."], menulist[preference="zen.tabs.focus.strength"]')];
      const glow = lists.find(l => l.getAttribute('preference') === 'zen.tabs.focus.strength');
      glow.value = 'subtle';
      glow.dispatchEvent(new Event('command', {bubbles: true}));
      await new Promise(r => setTimeout(r, 500));
      const labels = lists.map(l => l.previousElementSibling?.textContent.trim());
      return JSON.stringify({count: lists.length, labels, items: lists.map(l => l.label),
        pref: Services.prefs.getStringPref('zen.tabs.focus.strength'),
        attr: document.documentElement.getAttribute('zen-tab-focus-strength')});""")
    check("settings: seven choices, all labelled", pane["count"] == 7 and all(pane["labels"]) and all(pane["items"]),
          pane["labels"])
    check("settings: choosing sets the pref live", pane["pref"] == "subtle" and pane["attr"] == "subtle", pane)
finally:
    try:
        proc.terminate(); proc.wait(15)
    except Exception:
        pass
print(f"{sum(RESULTS)}/{len(RESULTS)} passed")
sys.exit(0 if all(RESULTS) else 1)
