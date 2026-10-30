#!/usr/bin/env python3
"""No band over the tab list after hovering the card stack. If the cards
change while the pointer is on the stack, the front card is measured with its
title and progress rows unfolded, and that height (115px in the user's log,
over a 34px card) was kept as the resting one. Two playing tabs, one paused,
the stack hovered while switching, then left. Second monitor."""
import json, os, pathlib, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import regress
regress._write_tone_page()
# A second, distinct tone page (another media session).
p2 = regress.TONE_PAGE.replace(".html", "-b.html")
pathlib.Path(p2).write_text(pathlib.Path(regress.TONE_PAGE).read_text().replace("Regress Tone", "Second Tone"))
port = regress.free_port()
proc = regress.launch("/tmp/claude-1000/card-band", port, prefs='user_pref("media.autoplay.default", 0);\nuser_pref("media.autoplay.blocking_policy", 0);\nuser_pref("zen.ui.layout-preset","minimal");\n')
try:
    m = regress.Marionette(port); time.sleep(3)
    r = m.js("""
      const P = Services.scriptSecurityManager.getSystemPrincipal();
      const a = gBrowser.addTab('file://%s', {triggeringPrincipal: P}); gBrowser.selectedTab = a;
      await new Promise(r => setTimeout(r, 6000));
      const b = gBrowser.addTab('file://%s', {triggeringPrincipal: P}); gBrowser.selectedTab = b;
      await new Promise(r => setTimeout(r, 6000));
      // b paused (like the paused YouTube tab), then stand on a (the playing one).
      b.linkedBrowser.messageManager.loadFrameScript('data:,content.document.querySelector("audio").pause()', false); await new Promise(r => setTimeout(r, 800));
      const other = gBrowser.addTab('about:robots', {triggeringPrincipal: P}); gBrowser.selectedTab = other;
      await new Promise(r => setTimeout(r, 2500));
      // The pointer is over the stack while the card set changes (user's trace).
      const bar0 = document.getElementById('zen-media-controls-toolbar');
      InspectorUtils.addPseudoClassLock(bar0, ':hover');
      gBrowser.selectedTab = a;
      await new Promise(r => setTimeout(r, 1500));
      InspectorUtils.removePseudoClassLock(bar0, ':hover');
      bar0.dispatchEvent(new PointerEvent('pointerleave'));
      await new Promise(r => setTimeout(r, 1500));
      const bar = document.getElementById('zen-media-controls-toolbar');
      const R = e => { const r = e.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.height)]; };
      return JSON.stringify({bar: R(bar), collapsed: bar.style.getPropertyValue('--zen-media-collapsed-height'),
        behind: bar.style.getPropertyValue('--zen-media-stack-behind'),
        cards: [...document.querySelectorAll('.zen-media-card')].map(c => ({hidden: c.hidden, rect: R(c), attrs: ['stacked-behind','zen-hiding'].filter(x => c.hasAttribute(x)), idx: c.style.getPropertyValue('--zen-media-card-index')})),
        stack: gZenCardStack.cards().length});""" % (regress.TONE_PAGE, p2))
finally:
    proc.terminate(); proc.wait(15)
card = [c for c in r["cards"] if not c["hidden"]][0]
ok = r["bar"][1] == card["rect"][1]
print(("ok    " if ok else "FAIL  ") + f"bar fits the visible card after hover       bar={r['bar'][1]} card={card['rect'][1]}")
sys.exit(0 if ok else 1)
