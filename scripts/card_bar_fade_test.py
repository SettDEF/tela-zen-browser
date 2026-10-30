#!/usr/bin/env python3
"""The media bar must not stay transparent. With one card, selecting its tab
fades the bar out; switching away before the 0.1s fade ends brought the card
back into a bar left at opacity 0 (unhidden, so never shown again). Repeats
that flip at many delays and checks the bar is drawn after each. Second
monitor. REGRESS_BINARY=/opt/tela-zen/zen runs it against the installed build."""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import regress

regress._write_tone_page()
port = regress.free_port()
proc = regress.launch("/tmp/claude-1000/bar-fade-%d" % port, port,
                      prefs='user_pref("media.autoplay.default", 0);\n'
                            'user_pref("media.autoplay.blocking_policy", 0);\n')
fails = []
ROUNDS = int(os.environ.get("ROUNDS", "2"))
DELAYS = list(range(100, 460, 10))
try:
    m = regress.Marionette(port)
    time.sleep(3)
    m.js("""const P = Services.scriptSecurityManager.getSystemPrincipal();
      window._tone = gBrowser.addTab('file://%s', {triggeringPrincipal: P}); gBrowser.selectedTab = _tone;
      await new Promise(r => setTimeout(r, 6000));
      window._other = gBrowser.addTab('about:robots', {triggeringPrincipal: P}); gBrowser.selectedTab = _other;
      await new Promise(r => setTimeout(r, 2000)); return '1';""" % regress.TONE_PAGE)
    for rnd in range(ROUNDS):
        for d in DELAYS:
            r = m.js("""gBrowser.selectedTab = _tone; await new Promise(r => setTimeout(r, %d));
              gBrowser.selectedTab = _other; await new Promise(r => setTimeout(r, 1500));
              const bar = document.getElementById('zen-media-controls-toolbar');
              return JSON.stringify({hidden: bar.hidden, opacity: +getComputedStyle(bar).opacity,
                cards: gZenCardStack.cards().length});""" % d)
            ok = not r["hidden"] and r["opacity"] > 0.95 and r["cards"] >= 1
            if not ok:
                fails.append((rnd, d, r))
                print("FAIL", rnd, d, r, flush=True)
    # The heal path: force the stuck state directly, the 5s mirror must fix it.
    r = m.js("""const bar = document.getElementById('zen-media-controls-toolbar');
      bar.style.opacity = 0; gZenCardStack.mirror(); await new Promise(r => setTimeout(r, 1500));
      return JSON.stringify({opacity: +getComputedStyle(bar).opacity});""")
    heal = r["opacity"] > 0.95 if "healBar" in m.js("return JSON.stringify(String(gZenMediaController.healBar))") else None
    print("heal:", heal, r)
finally:
    proc.terminate()
    proc.wait(15)
n = ROUNDS * len(DELAYS)
print(f"{n - len(fails)}/{n} flips left the bar drawn")
sys.exit(1 if fails or heal is False else 0)
