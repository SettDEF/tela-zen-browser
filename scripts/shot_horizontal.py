#!/usr/bin/env python3
"""Self-capture of the horizontal layout's top chrome (tabs + toolbar) in a
test window, for before/after comparisons. usage: shot_horizontal.py OUT.png"""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import regress
from PIL import Image

out = sys.argv[1]
port = regress.free_port()
proc = regress.launch("/tmp/claude-1000/shot-horizontal-%d" % port, port,
                      prefs='user_pref("zen.ui.layout-preset", "horizontal");\n')
try:
    m = regress.Marionette(port)
    time.sleep(3)
    r = m.js("""
      const P = Services.scriptSecurityManager.getSystemPrincipal();
      for (const u of ['https://example.com/', 'https://www.torproject.org/', 'about:robots'])
        gBrowser.addTab(u, {triggeringPrincipal: P});
      await new Promise(r => setTimeout(r, 3000));
      const chrome = document.getElementById('zen-horizontal-chrome') || document.getElementById('navigator-toolbox');
      const b = chrome.getBoundingClientRect();
      const label = document.querySelector('.zen-htabs-label');
      return JSON.stringify({h: b.bottom, w: innerWidth, dpr: devicePixelRatio,
        label: label && getComputedStyle(label).fontSize, ui: getComputedStyle(document.documentElement).fontSize});""")
    m.screenshot("/tmp/claude-1000/shot-horizontal-full.png")
    d = r["dpr"]
    Image.open("/tmp/claude-1000/shot-horizontal-full.png").crop((0, 0, int(r["w"] * d), int((r["h"] + 12) * d))).save(out)
    print(json.dumps(r))
finally:
    proc.terminate()
    proc.wait(15)
