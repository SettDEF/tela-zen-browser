#!/usr/bin/env python3
"""Opened card stack has no holes: with cards of different heights, the gap
between cards is the stack gap and the bar is exactly as tall as its cards.
A card behind is held at the front card's height while stacked, and summing
those held heights made the open bar too tall - the spare opened between the
cards. Both orders: taller card in front, taller card behind. Second monitor."""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import regress

RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append(ok)
    print(("ok    " if ok else "FAIL  ") + f"{name:44} {detail}", flush=True)


TALL = ("{id: 'zen-activity-tabs', title: 'Activity', subtitle: 'All read', icon: 'generic',"
        " items: [{key: '1', label: 'wie schreibt man dayly'}, {key: '2', label: 'second row'}]}")
SHORT = "{id: 'probe-short', title: 'Perplexity', subtitle: 'Active 4m ago', items: []}"

RUN = """
  for (const card of [%s, %s]) gZenPageCards.setWindowCard(card);
  await new Promise(r => setTimeout(r, 1500));
  const bar = document.getElementById('zen-media-controls-toolbar');
  document.getElementById('navigator-toolbox').setAttribute('zen-has-hover', 'true');
  InspectorUtils.addPseudoClassLock(bar, ':hover');
  bar.style.setProperty('--zen-media-reveal', '99');
  gZenCardStack.layout();
  await new Promise(r => setTimeout(r, 1200));
  const gap = parseFloat(getComputedStyle(bar).getPropertyValue('--zen-media-stack-gap')) || 6;
  const rects = gZenCardStack.cards().map(c => c.getBoundingClientRect()).sort((a, b) => a.top - b.top);
  const b = bar.getBoundingClientRect();
  return JSON.stringify({gap, heights: rects.map(r => Math.round(r.height)),
    gaps: rects.slice(1).map((r, i) => Math.round(r.top - rects[i].bottom)),
    topSlack: Math.round(rects[0].top - b.top), bottomSlack: Math.round(b.bottom - rects.at(-1).bottom)});"""

for name, front, behind in (("taller in front", TALL, SHORT), ("taller behind", SHORT, TALL)):
    port = regress.free_port()
    proc = regress.launch("/tmp/claude-1000/stack-gap-%d" % port, port,
                          prefs='user_pref("zen.ui.layout-preset", "minimal");\n')
    try:
        m = regress.Marionette(port)
        time.sleep(3)
        r = m.js(RUN % (front, behind))
    finally:
        proc.terminate()
        proc.wait(15)
    check(f"{name}: heights differ", len(set(r["heights"])) == 2, r["heights"])
    check(f"{name}: no hole between cards", r["gaps"] == [round(r["gap"])], r["gaps"])
    check(f"{name}: bar fits its cards", abs(r["topSlack"]) <= 1 and abs(r["bottomSlack"]) <= 1,
          f"top {r['topSlack']} bottom {r['bottomSlack']}")

# Four cards: the 4th is "overflow" at rest; once the open stack reveals it, it
# must take the pointer (it showed, and hovers and clicks fell through).
port = regress.free_port()
proc = regress.launch("/tmp/claude-1000/stack-overflow-%d" % port, port,
                      prefs='user_pref("zen.ui.layout-preset", "minimal");\n')
try:
    m = regress.Marionette(port)
    time.sleep(3)
    r = m.js("""
      for (const i of [1, 2, 3, 4]) gZenPageCards.setWindowCard({id: 'c' + i, title: 'Card ' + i,
        subtitle: 's', items: [{key: 'a', label: 'row of card ' + i}]});
      await new Promise(r => setTimeout(r, 1500));
      const bar = document.getElementById('zen-media-controls-toolbar');
      document.getElementById('navigator-toolbox').setAttribute('zen-has-hover', 'true');
      InspectorUtils.addPseudoClassLock(bar, ':hover');
      bar.style.setProperty('--zen-media-reveal', '99');
      gZenCardStack.layout();
      await new Promise(r => setTimeout(r, 1200));
      const card = gZenCardStack.cards()[3], row = card.querySelector('.zen-page-card-row');
      const b = row.getBoundingClientRect();
      const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return JSON.stringify({overflow: card.hasAttribute('stack-overflow'), opacity: getComputedStyle(card).opacity,
        hit: top?.closest?.('.zen-page-card-row') === row});""")
finally:
    proc.terminate()
    proc.wait(15)
check("4th card: shown when the stack opens", r["overflow"] and float(r["opacity"]) > 0.9, r)
check("4th card: takes the pointer", r["hit"], r)

print(f"{sum(RESULTS)}/{len(RESULTS)} passed")
sys.exit(0 if all(RESULTS) else 1)
