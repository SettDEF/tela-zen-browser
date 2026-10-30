#!/usr/bin/env python3
"""Ctrl+Alt+Shift+C writes a card report: json with every card's styles,
ancestors and animations, a png of the sidebar as the browser renders it,
and the person's answer after the forced repaint. Second monitor."""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import regress

RESULTS = []


def check(name, ok, detail=""):
    ok = bool(ok)
    RESULTS.append(ok)
    print(("ok    " if ok else "FAIL  ") + f"{name:40} {detail}", flush=True)


regress._write_tone_page()
port = regress.free_port()
prof = "/tmp/claude-1000/card-report-%d" % port
proc = regress.launch(prof, port, prefs='user_pref("media.autoplay.default", 0);\n'
                                       'user_pref("media.autoplay.blocking_policy", 0);\n')
try:
    m = regress.Marionette(port)
    time.sleep(3)
    r = m.js("""const P = Services.scriptSecurityManager.getSystemPrincipal();
      const tone = gBrowser.addTab('file://%s', {triggeringPrincipal: P}); gBrowser.selectedTab = tone;
      await new Promise(r => setTimeout(r, 6000));
      gBrowser.selectedTab = gBrowser.addTab('about:robots', {triggeringPrincipal: P});
      await new Promise(r => setTimeout(r, 2500));
      window.dispatchEvent(new KeyboardEvent('keydown', {code: 'KeyC', key: 'C', ctrlKey: true, altKey: true, shiftKey: true}));
      let n;
      for (let i = 0; i < 50 && !(n = gNotificationBox.getNotificationWithValue('zen-cards-report')); i++)
        await new Promise(r => setTimeout(r, 100));
      const base = n?.getAttribute('data-zen-cards-report');
      const no = [...(n?.buttonContainer?.querySelectorAll('button') || n?.querySelectorAll('button') || [])]
        .find(b => /still missing/.test(b.label || b.textContent));
      no?.click();
      await new Promise(r => setTimeout(r, 500));
      return JSON.stringify({base, label: n?.messageText?.textContent || '', clicked: !!no});""" % regress.TONE_PAGE)
    check("shortcut raises the question", bool(r["base"]) and r["clicked"], r)
    rep = json.load(open(r["base"] + ".json"))
    card = (rep.get("cards") or [{}])[0]
    check("report has the media card", rep["media"] and card.get("rect", [0])[3] > 0, rep["media"])
    check("card styles, ancestors, points", card.get("style") and len(card.get("ancestors", [])) >= 3
          and card.get("atPoints"), list(card.keys()))
    check("trace and history captured", len(rep["trace"]) > 3 and rep["history"], (len(rep["trace"]), len(rep["history"])))
    png = rep.get("render", "")
    check("sidebar render saved", png.endswith(".png") and os.path.getsize(png) > 2000, png)
    check("answer recorded", rep.get("afterRepaint") == "still missing", rep.get("afterRepaint"))
    if len(sys.argv) > 1 and png.endswith(".png"):
        os.system(f"cp '{png}' '{sys.argv[1]}'")
finally:
    proc.terminate()
    proc.wait(15)
print(f"{sum(RESULTS)}/{len(RESULTS)} passed")
sys.exit(0 if all(RESULTS) else 1)
