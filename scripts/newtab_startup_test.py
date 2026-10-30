#!/usr/bin/env python3
"""Startup and the new tab page. Run 1 makes a session and quits cleanly.
Run 2 restores it soon after: the empty tab shows the page (not blank) and
the last tab stays selected. Run 3 restores it as if closed 6 hours ago: the
new tab page is selected. Also the Startup setting. Second monitor."""
import json, os, pathlib, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import regress

RESULTS = []
URL = "chrome://browser/content/zen-newtab.html"
RESTORE = 'user_pref("zen.behavior.restoreSession", true);\nuser_pref("browser.startup.page", 3);\n'


def check(name, ok, detail=""):
    RESULTS.append(ok)
    print(("ok    " if ok else "FAIL  ") + f"{name:44} {detail}", flush=True)


def mozlz4_read(data):
    src, out, i = data[12:], bytearray(), 0
    while i < len(src):
        t = src[i]; i += 1; n = t >> 4
        if n == 15:
            while True:
                b = src[i]; i += 1; n += b
                if b != 255: break
        out += src[i:i + n]; i += n
        if i >= len(src): break
        off = src[i] | src[i + 1] << 8; i += 2; m = t & 15
        if m == 15:
            while True:
                b = src[i]; i += 1; m += b
                if b != 255: break
        s = len(out) - off
        for k in range(m + 4): out.append(out[s + k])
    return bytes(out)


def mozlz4_write(raw):
    # One all-literal LZ4 block: valid, just uncompressed.
    n, token = len(raw), bytearray([0xF0])
    rest = n - 15
    while rest >= 255:
        token.append(255); rest -= 255
    token.append(rest)
    return b"mozLz40\0" + n.to_bytes(4, "little") + bytes(token) + raw


def files_of(profile):
    return {p.name: p.read_bytes() for p in pathlib.Path(profile).iterdir() if p.is_file()
            and p.name not in ("user.js", "lock", ".parentlock")}


def quit_(m, proc):
    try:
        m.js("Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit); return '1';")
    except Exception:
        pass
    proc.wait(30)


STATE = """
  for (let i = 0; i < 50 && !gZenWorkspaces._emptyTab?.linkedBrowser?.contentDocument?.getElementById('q'); i++)
    await new Promise(r => setTimeout(r, 200));
  await new Promise(r => setTimeout(r, 1500));
  const e = gZenWorkspaces._emptyTab, b = e?.linkedBrowser;
  return JSON.stringify({uri: b?.currentURI.spec, q: !!b?.contentDocument?.getElementById('q'),
    tiles: b?.contentDocument?.querySelectorAll('.tile').length,
    selectedIsEmpty: gBrowser.selectedTab === e, selected: gBrowser.selectedBrowser.currentURI.spec,
    urlbarOpen: gURLBar.view.isOpen});"""

port = regress.free_port()
prof = "/tmp/claude-1000/newtab-start-%d" % port

# Run 1: history, a real tab selected, clean quit.
proc = regress.launch(prof, port, prefs=RESTORE)
m = regress.Marionette(port)
time.sleep(3)
m.js("""const P = Services.scriptSecurityManager.getSystemPrincipal();
  await PlacesUtils.history.insertMany([['https://archlinux.org/', 'Arch'], ['https://hyprland.org/', 'Hyprland']]
    .map(([url, title]) => ({url, title, visits: [{date: new Date()}]})));
  gBrowser.selectedTab = gBrowser.addTab('about:robots', {triggeringPrincipal: P});
  await new Promise(r => setTimeout(r, 2500)); return '1';""")
quit_(m, proc)
saved = files_of(prof)
zs = json.loads(mozlz4_read(saved["zen-sessions.jsonlz4"]))
ss = json.loads(mozlz4_read(saved["sessionstore.jsonlz4"]))
empties = [t["entries"][-1]["url"] for w in ss["windows"] for t in w["tabs"] if t.get("zenIsEmpty") and t.get("entries")]
check("session saved the empty tab as the page", empties == [URL], empties)

try:
    # Run 2: back soon.
    proc = regress.launch(prof, port, prefs=RESTORE, seed=saved)
    m = regress.Marionette(port)
    r = m.js(STATE)
    check("restored empty tab shows the page", r["uri"] == URL and r["q"], r)
    check("back soon: last tab stays selected", not r["selectedIsEmpty"] and "robots" in r["selected"], r["selected"])

    # Revisit refresh: new history appears after a minute away.
    r = m.js("""const d = gZenWorkspaces._emptyTab.linkedBrowser.contentDocument;
      await PlacesUtils.history.insert({url: 'https://kloud.example/', title: 'Fresh KLOUD', visits: [{date: new Date()}]});
      gBrowser.selectedTab = gBrowser.tabs.find(t => t !== gZenWorkspaces._emptyTab && !t.collapsed);
      await new Promise(r => setTimeout(r, 300));
      d.defaultView.renderedAt = 0;
      gBrowser.selectedTab = gZenWorkspaces._emptyTab; await new Promise(r => setTimeout(r, 1500));
      return JSON.stringify(d.body.textContent.includes('Fresh KLOUD'));""")
    check("page re-renders when shown again", r is True, r)

    # The setting.
    r = m.js("""const t = gBrowser.addTab('about:preferences', {triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()});
      gBrowser.selectedTab = t; let s;
      for (let i = 0; i < 50 && !(s = t.linkedBrowser.contentDocument?.getElementById('zenNewTabAfterAway')); i++)
        await new Promise(r => setTimeout(r, 200));
      if (!s) return JSON.stringify({missing: true});
      await new Promise(r => setTimeout(r, 800));
      const before = s.value; s.value = '12'; s.dispatchEvent(new Event('change', {bubbles: true}));
      await new Promise(r => setTimeout(r, 300));
      const after = Services.prefs.getIntPref('zen.newtab.after-away-hours');
      Services.prefs.setIntPref('zen.newtab.after-away-hours', 4);
      return JSON.stringify({before, after, label: s.label, opts: s.options?.length});""")
    check("setting shows and writes the pref", r.get("before") == "4" and r.get("after") == 12, r)
    quit_(m, proc)

    # Run 3: closed 6 hours ago.
    zs["lastCollected"] = int(time.time() * 1000) - 6 * 3600 * 1000
    old = dict(saved, **{"zen-sessions.jsonlz4": mozlz4_write(json.dumps(zs).encode())})
    proc = regress.launch(prof, port, prefs=RESTORE, seed=old)
    m = regress.Marionette(port)
    r = m.js(STATE)
    check("away 6h: starts on the new tab page", r["selectedIsEmpty"] and r["q"], r)
    check("away 6h: urlbar does not cover it", not r["urlbarOpen"], r["urlbarOpen"])
    if len(sys.argv) > 1:
        m.screenshot(sys.argv[1])
finally:
    proc.terminate()
    proc.wait(15)
print(f"{sum(RESULTS)}/{len(RESULTS)} passed")
sys.exit(0 if all(RESULTS) else 1)
