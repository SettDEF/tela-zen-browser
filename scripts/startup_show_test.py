#!/usr/bin/env python3
"""A window opens once, complete: kept hidden until its session is restored
(zen.startup.show-when-ready), not a placeholder sidebar first. Checks, with
a 40-tab session, a fresh profile and a Ctrl+N window: shown by "ready" not
the 3s timeout, Gecko's only native Show is that moment (widget log), and
window.focus still works afterwards (it is held while hidden). Second monitor."""
import datetime, json, os, pathlib, shutil, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import regress

RESULTS = []
LOG = pathlib.Path("/tmp/claude-1000/startup-show-log")


def check(name, ok, detail=""):
    ok = bool(ok)
    RESULTS.append(ok)
    print(("ok    " if ok else "FAIL  ") + f"{name:46} {detail}", flush=True)


def native_shows():
    out = []
    for f in LOG.parent.glob(LOG.name + "*"):
        if ".child-" in f.name:
            continue
        for line in f.read_text(errors="replace").splitlines():
            if "nsWindow::Show state 1" in line and "frame (no frame)" in line:
                t = datetime.datetime.strptime(line[:26] + "+0000", "%Y-%m-%d %H:%M:%S.%f%z")
                out.append(t.timestamp() * 1000)
    return out


STATE = """const t = gZenStartup.timing;
  return JSON.stringify({by: t.shownBy, held: t.held, shown: t.shown, restored: t.restored,
    focus: typeof window.focus, focused: Services.focus.activeWindow === window, tabs: gBrowser.tabs.length});"""


def start(prof, port, seed=None, extra=""):
    for f in LOG.parent.glob(LOG.name + "*"):
        f.unlink()
    os.environ["MOZ_LOG"] = "timestamp,Widget:5"
    os.environ["MOZ_LOG_FILE"] = str(LOG)
    try:
        return regress.launch(prof, port, seed=seed, prefs='user_pref("zen.behavior.restoreSession", true);\n'
                              'user_pref("browser.startup.page", 3);\n'
                              'user_pref("zen.startup.show-when-ready", true);\n' + extra)
    finally:
        os.environ.pop("MOZ_LOG"); os.environ.pop("MOZ_LOG_FILE")


port = regress.free_port()
prof = "/tmp/claude-1000/startup-show-%d" % port
proc = start(prof, port)
try:
    m = regress.Marionette(port)
    time.sleep(2)
    r = m.js(STATE)
    shows = native_shows()
    check("fresh profile: shown when ready", r["by"] == "ready", r)
    check("fresh profile: one native show, ours", len(shows) == 1 and abs(shows[0] - r["shown"]) < 60,
          [round(s - r["shown"]) for s in shows])
    check("window.focus restored", r["focus"] == "function", r["focus"])

    # A second window: held and shown the same way, quickly.
    r = m.js("""const w = OpenBrowserWindow();
      for (let i = 0; i < 60 && !w.gZenStartup?.timing?.shown; i++) await new Promise(r => setTimeout(r, 100));
      const t = w.gZenStartup.timing; const out = {by: t.shownBy, wait: t.shown - t.held, focus: typeof w.focus};
      w.close(); return JSON.stringify(out);""")
    check("new window: shown when ready, under 1.5s", r["by"] == "ready" and r["wait"] < 1500, r)

    # A real session for the next start.
    m.js("""const P = Services.scriptSecurityManager.getSystemPrincipal();
      for (let i = 0; i < 40; i++) gBrowser.addTab('about:robots#' + i, {triggeringPrincipal: P});
      gBrowser.selectedTab = gBrowser.tabs[gBrowser.tabs.length - 1];
      await new Promise(r => setTimeout(r, 2500)); return '1';""")
    try:
        m.js("Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit); return '1';")
    except Exception:
        pass
    proc.wait(30)
    saved = {p.name: p.read_bytes() for p in pathlib.Path(prof).iterdir()
             if p.is_file() and p.name not in ("user.js", "lock", ".parentlock")}

    proc = start(prof, port, seed=saved)
    m = regress.Marionette(port)
    time.sleep(2)
    r = m.js(STATE)
    shows = native_shows()
    check("40-tab session: shown when ready", r["by"] == "ready" and r["tabs"] >= 30, r)
    check("40-tab session: shown after the restore", r["shown"] >= r["restored"] - 5, r["shown"] - r["restored"])
    check("40-tab session: one native show, ours", len(shows) == 1 and abs(shows[0] - r["shown"]) < 60,
          [round(s - r["shown"]) for s in shows])
    check("deferred focus delivered", r["focused"] and r["focus"] == "function", r)
finally:
    proc.terminate()
    proc.wait(15)
    shutil.rmtree(prof, ignore_errors=True)
print(f"{sum(RESULTS)}/{len(RESULTS)} passed")
sys.exit(0 if all(RESULTS) else 1)
