#!/usr/bin/env python3
"""The card log names what covers a card. "seen" only measured the card, so a
card under the tab list still counted as visible; the log now records what is
drawn at each card's centre and files a problem when it is not the card.
An element is laid over a live media card here; the log must say so.
Second monitor."""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import regress

regress._write_tone_page()
prof = "/tmp/claude-1000/card-cover-trace"
port = regress.free_port()
proc = regress.launch(prof, port, prefs='user_pref("media.autoplay.default", 0);\n'
                                        'user_pref("media.autoplay.blocking_policy", 0);\n')
try:
    m = regress.Marionette(port)
    time.sleep(3)
    m.js("""
      const P = Services.scriptSecurityManager.getSystemPrincipal();
      const tone = gBrowser.addTab('file://%s', {triggeringPrincipal: P}); gBrowser.selectedTab = tone;
      await new Promise(r => setTimeout(r, 6000));
      gBrowser.selectedTab = gBrowser.addTab('about:robots', {triggeringPrincipal: P});
      await new Promise(r => setTimeout(r, 1500));
      const card = [...document.querySelectorAll('.zen-media-card')].find(c => !c.hidden);
      const r = card.getBoundingClientRect();
      const cover = document.createElementNS('http://www.w3.org/1999/xhtml', 'div');
      cover.id = 'test-cover';
      Object.assign(cover.style, {position: 'fixed', left: r.left + 'px', top: r.top + 'px',
        width: r.width + 'px', height: r.height + 'px', zIndex: 9999, background: 'red'});
      document.documentElement.append(cover);
      gZenCardStack.mirror();
      await new Promise(r => setTimeout(r, 1500));
      return '1';""" % regress.TONE_PAGE)
    d = json.load(open(prof + "/zen-cards-live.json"))
finally:
    proc.terminate()
    proc.wait(15)
card = d["cards"][0]
ok1 = (card.get("covered") or "").startswith("test-cover")
ok2 = any("test-cover" in p for p in d["problems"])
ok3 = isinstance(d.get("list"), list)
for ok, name, detail in ((ok1, "card records what covers it", card.get("covered")),
                         (ok2, "covered card filed as a problem", d["problems"]),
                         (ok3, "tab list position logged", d.get("list"))):
    print(("ok    " if ok else "FAIL  ") + f"{name:44} {detail}")
sys.exit(0 if ok1 and ok2 and ok3 else 1)
