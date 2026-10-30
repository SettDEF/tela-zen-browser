#!/usr/bin/env python3
"""Stop must stay stopped across a restart; start must survive one.

The user pressed stop 14 times and agent control came back at every launch,
and the panel filled with start/stop rows. Restarts in place over Marionette,
so the same profile is read back as a real launch would. Second monitor.
"""
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import regress

RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append(ok)
    print(("ok    " if ok else "FAIL  ") + f"{name:34} {detail}", flush=True)


STATE = """
  const { ZenAgentChannel } = ChromeUtils.importESModule("resource:///modules/zen/agent/ZenAgentChannel.sys.mjs");
  return JSON.stringify({ listening: !!ZenAgentChannel.listening,
    pref: Services.prefs.getBoolPref("zen.agent.enabled", false) });"""
PANEL = """
  const w = Services.wm.getMostRecentWindow("navigator:browser");
  w.gZenAgentUI.togglePanel(); await new Promise(r => setTimeout(r, 800));
  const p = w.document.getElementById("zen-agent-panel");
  const ids = [...(p?.querySelectorAll("[data-l10n-id]") || [])].map(e => e.getAttribute("data-l10n-id"));
  p?.hidePopup?.();
  return JSON.stringify({ empty: ids.includes("zen-agent-panel-empty"),
    rows: ids.filter(i => i.startsWith("zen-agent-log-entry")).length });"""


def restart(m, port):
    m.cmd("Marionette:Quit", {"flags": ["eRestart"]})
    time.sleep(8)
    return regress.Marionette(port)


port = regress.free_port()
proc = regress.launch("/tmp/claude-1000/agent-stop", port)
try:
    m = regress.Marionette(port)
    m.js("""Services.prefs.setBoolPref("zen.agent.enabled", true);
      await Services.wm.getMostRecentWindow("navigator:browser").gZenAgentUI.startSilent();
      return "1";""")
    s = m.js(STATE)
    check("start turns it on", s["listening"] and s["pref"], s)
    m.js("""await Services.wm.getMostRecentWindow("navigator:browser").gZenAgentUI.stop(); return "1";""")
    s = m.js(STATE)
    check("stop turns it off", not s["listening"] and not s["pref"], s)
    p = m.js(PANEL)
    check("panel lists no start/stop rows", p["rows"] == 0 and p["empty"], p)
    m = restart(m, port)
    time.sleep(6)
    s = m.js(STATE)
    check("stays off after a restart", not s["listening"] and not s["pref"], s)
    m.js("""await Services.wm.getMostRecentWindow("navigator:browser").gZenAgentUI.startSilent(); return "1";""")
    m = restart(m, port)
    time.sleep(6)
    s = m.js(STATE)
    check("started again survives a restart", s["listening"] and s["pref"], s)
finally:
    try:
        regress.Marionette(port).cmd("Marionette:Quit", {})
    except Exception:
        pass
    proc.terminate()
print(f"{sum(RESULTS)}/{len(RESULTS)} passed")
sys.exit(0 if all(RESULTS) else 1)
