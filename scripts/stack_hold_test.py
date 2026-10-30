#!/usr/bin/env python3
"""The card stack stays open while a card's ⋯ menu is open: opening it moves
the pointer off the stack, and folding then slid the card out from under its
own menu. Released (folds) when the menu closes. Second monitor."""
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import regress

RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append(ok)
    print(("ok    " if ok else "FAIL  ") + f"{name:44} {detail}", flush=True)


regress._write_tone_page()
port = regress.free_port()
proc = regress.launch("/tmp/claude-1000/stack-hold-%d" % port, port,
                      prefs='user_pref("media.autoplay.default", 0);\n'
                            'user_pref("media.autoplay.blocking_policy", 0);\n')
try:
    m = regress.Marionette(port)
    time.sleep(3)
    r = m.js("""
      const P = Services.scriptSecurityManager.getSystemPrincipal();
      const tone = gBrowser.addTab('file://%s', {triggeringPrincipal: P});
      gBrowser.selectedTab = tone;
      await new Promise(r => setTimeout(r, 7000));
      gBrowser.selectedTab = gBrowser.addTab('about:robots', {triggeringPrincipal: P});
      gZenPageCards.setWindowCard({id: 'probe', title: 'Behind', subtitle: 's', items: [{key: 'a', label: 'row'}]});
      await new Promise(r => setTimeout(r, 2000));
      const bar = document.getElementById('zen-media-controls-toolbar');
      const state = () => ({hover: bar.matches(':hover'), reveal: bar.style.getPropertyValue('--zen-media-reveal')});
      const card = [...document.querySelectorAll('.zen-media-card')].find(c => !c.hidden);
      const panel = () => document.getElementById('zen-media-more-panel');
      const shown = new Promise(r => document.addEventListener('popupshown', r, {once: true}));
      card.querySelector('.zen-media-more-button').doCommand();
      await Promise.race([shown, new Promise(r => setTimeout(r, 4000))]);
      // The pointer goes to the menu: the stack sees it leave.
      bar.dispatchEvent(new PointerEvent('pointerleave'));
      await new Promise(r => setTimeout(r, 900));
      const whileOpen = {...state(), panel: panel()?.state};
      panel().hidePopup();
      await new Promise(r => setTimeout(r, 600));
      return JSON.stringify({whileOpen, after: state()});""" % regress.TONE_PAGE)
finally:
    proc.terminate()
    proc.wait(15)
w, a = r["whileOpen"], r["after"]
check("menu open", w["panel"] == "open", w)
check("stack stays open after the pointer leaves", w["hover"] and w["reveal"] not in ("", None), w)
check("menu closed: stack folds", not a["hover"] and not a["reveal"], a)
print(f"{sum(RESULTS)}/{len(RESULTS)} passed")
sys.exit(0 if all(RESULTS) else 1)
