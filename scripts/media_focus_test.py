#!/usr/bin/env python3
"""Clicking a media card's site icon goes to that tab - a normal tab and one
pinned as an essential (YouTube Music lives there for the user), where
MediaController.focus() left the tab unselected. Second monitor."""
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import regress

RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append(ok)
    print(("ok    " if ok else "FAIL  ") + f"{name:44} {detail}", flush=True)


RUN = """
  const P = Services.scriptSecurityManager.getSystemPrincipal();
  const tone = gBrowser.addTab('file://%s', {triggeringPrincipal: P});
  gBrowser.selectedTab = tone;
  await new Promise(r => setTimeout(r, 7000));
  if (%s) {
    gZenPinnedTabManager.addToEssentials(tone);
    await new Promise(r => setTimeout(r, 800));
  }
  const other = gBrowser.addTab('about:robots', {triggeringPrincipal: P});
  gBrowser.selectedTab = other;
  await new Promise(r => setTimeout(r, 2500));
  const card = [...document.querySelectorAll('.zen-media-card')].find(c => !c.hidden);
  if (!card) return JSON.stringify({card: false, audible: tone.hasAttribute('soundplaying')});
  card.querySelector('.zen-media-focus-button').doCommand();
  await new Promise(r => setTimeout(r, 1500));
  return JSON.stringify({card: true, essential: tone.hasAttribute('zen-essential'),
    selected: gBrowser.selectedTab === tone, label: gBrowser.selectedTab.label});"""

regress._write_tone_page()
for name, essential in (("normal tab", "false"), ("essential", "true")):
    port = regress.free_port()
    proc = regress.launch("/tmp/claude-1000/media-focus-%d" % port, port,
                          prefs='user_pref("media.autoplay.default", 0);\n'
                                'user_pref("media.autoplay.blocking_policy", 0);\n')
    try:
        m = regress.Marionette(port)
        time.sleep(3)
        r = m.js(RUN % (regress.TONE_PAGE, essential))
    finally:
        proc.terminate()
        proc.wait(15)
    check(f"{name}: card shown for the playing tab", r.get("card"), r)
    if essential == "true":
        check(f"{name}: tab really is an essential", r.get("essential"), r)
    check(f"{name}: icon click selects its tab", r.get("selected"), r.get("label"))

print(f"{sum(RESULTS)}/{len(RESULTS)} passed")
sys.exit(0 if all(RESULTS) else 1)
