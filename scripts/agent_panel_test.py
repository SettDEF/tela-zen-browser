#!/usr/bin/env python3
"""The agent panel can switch agent control back on. After a Stop it said
"Off" and offered nothing, and turning the setting on only cleared a flag, so
only a browser restart brought it back. Now: Start buttons while off, the
setting starts it at once, and the panel's padding is one margin, not two.
Second monitor."""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import regress

RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append(ok)
    print(("ok    " if ok else "FAIL  ") + f"{name:44} {detail}", flush=True)


prof = "/tmp/claude-1000/agent-panel-test"
sock = os.path.join(prof, "zen-agent.sock")
port = regress.free_port()
proc = regress.launch(prof, port, prefs='user_pref("zen.agent.enabled", true);\n')
try:
    m = regress.Marionette(port)
    time.sleep(4)
    check("auto-started at launch", os.path.exists(sock))
    r = m.js("""
      await gZenAgentUI.stop();
      await new Promise(r => setTimeout(r, 800));
      const prefAfterStop = Services.prefs.getBoolPref('zen.agent.enabled');
      const panel = gZenAgentUI._panel();
      const shown = new Promise(r => panel.addEventListener('popupshown', r, {once: true}));
      gZenAgentUI.togglePanel();
      await Promise.race([shown, new Promise(r => setTimeout(r, 3000))]);
      await new Promise(r => setTimeout(r, 400));
      const labels = [...panel.querySelectorAll('button')].map(b => b.label);
      const body = document.getElementById('zen-agent-panel-body');
      const pad = getComputedStyle(body).paddingTop;
      const ppad = getComputedStyle(panel).getPropertyValue('--panel-padding').trim();
      const start = [...panel.querySelectorAll('button')].find(b => b.classList.contains('zen-agent-start'));
      start?.doCommand();
      await new Promise(r => setTimeout(r, 1500));
      const after = {mode: gZenAgentUI.mode, labels: [...panel.querySelectorAll('button')].map(b => b.label)};
      panel.hidePopup();
      // The other mode, pressed while off: may use this tab.
      await gZenAgentUI.stop();
      await new Promise(r => setTimeout(r, 500));
      await gZenAgentUI.startAttended();
      await new Promise(r => setTimeout(r, 1000));
      const attended = gZenAgentUI.mode;
      return JSON.stringify({labels, pad, ppad, after, prefAfterStop, attended});""")
    check("off: panel offers Start", any("Start" in (l or "") for l in r["labels"]), r["labels"])
    check("Stop switched the setting off", r["prefAfterStop"] is False)
    check("Start brings it back anyway", r["after"]["mode"] == "silent" and os.path.exists(sock), r["after"])
    check("'may use this tab' starts attended", r["attended"] == "attended", r["attended"])
    check("panel padding is one margin", r["pad"] == "4px" and r["ppad"] == "6px", f"body {r['pad']} panel {r['ppad']}")
    m.js("gZenAgentUI.stop(); Services.prefs.setBoolPref('zen.agent.enabled', false); return '1';")
    time.sleep(1)
    off = os.path.exists(sock)
    m.js("Services.prefs.setBoolPref('zen.agent.enabled', true); return '1';")
    time.sleep(2)
    check("setting on starts it, no restart", os.path.exists(sock) and m.js("return JSON.stringify(gZenAgentUI.mode);") == "silent",
          f"socket before={off}")
finally:
    try:
        proc.terminate(); proc.wait(15)
    except Exception:
        pass
print(f"{sum(RESULTS)}/{len(RESULTS)} passed")
sys.exit(0 if all(RESULTS) else 1)
