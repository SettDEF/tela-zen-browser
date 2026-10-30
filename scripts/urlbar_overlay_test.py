#!/usr/bin/env python3
"""Sidebar address bar as an overlay (zen.urlbar.sidebar.overlay): focusing
it must not change the sidebar's width on any frame (no relayout of the tab
list), the field and results must sit over the page on a solid surface, and
blur must return the field to its exact resting rect. Comfortable, compact and
right-side sidebars. Second monitor."""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import regress

RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append(ok)
    print(("ok    " if ok else "FAIL  ") + f"{name:46} {detail}", flush=True)


RUN = """
  const P = Services.scriptSecurityManager.getSystemPrincipal();
  for (let i = 0; i < 6; i++) gBrowser.addTab('about:robots', {triggeringPrincipal: P});
  gBrowser.selectedTab = gBrowser.tabs[gBrowser.tabs.length - 1];
  await new Promise(r => setTimeout(r, 1500));
  const tb = document.getElementById('navigator-toolbox'), u = document.getElementById('urlbar');
  const list = document.getElementById('zen-sidebar-results');
  const R = e => { const b = e.getBoundingClientRect(); return [b.left, b.top, b.width, b.height].map(Math.round); };
  const rest = {side: R(tb), field: R(u)};
  const widths = new Set(); let on = true;
  const tick = () => { widths.add(Math.round(tb.getBoundingClientRect().width)); if (on) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  gURLBar.focus();
  for (let i = 0; i < 30 && !list.hasAttribute('open'); i++) {
    if (i % 5 == 0) { gURLBar.value = 'example.org'; gURLBar.startQuery({searchString: 'example.org'}); }
    await new Promise(r => setTimeout(r, 300));
  }
  await new Promise(r => setTimeout(r, 600));
  on = false;
  const f = R(u), rs = R(list);
  const right = tb.getAttribute('zen-right-side') === 'true';
  // A point just past the sidebar's edge, over the page.
  const px = right ? rest.side[0] - 40 : rest.side[0] + rest.side[2] + 40;
  const hit = (x, y, sel) => !!document.elementFromPoint(x, y)?.closest?.(sel);
  const bg = getComputedStyle(list).backgroundImage + ' ' + getComputedStyle(list).backgroundColor;
  const fb = document.querySelector('#urlbar .urlbar-background').getBoundingClientRect(), lb = list.getBoundingClientRect();
  const join = [lb.top - fb.bottom, lb.left - fb.left, lb.width - fb.width].map(v => +v.toFixed(2));
  const open = {join, field: f, results: rs, open: list.hasAttribute('open'), widths: [...widths],
    fieldOver: hit(px, f[1] + f[3] / 2, '#urlbar'), resultsOver: hit(px, rs[1] + 20, '#zen-sidebar-results'),
    solid: /gradient/.test(bg)};
  gURLBar.blur();
  await new Promise(r => setTimeout(r, 800));
  return JSON.stringify({rest, open, back: {side: R(tb), field: R(u), attr: tb.hasAttribute('zen-urlbar-overlay')}});"""

CASES = [
    ("comfortable", 'user_pref("zen.ui.layout-preset", "comfortable");\n'),
    ("compact", 'user_pref("zen.ui.layout-preset", "compact");\n'),
    ("right side", 'user_pref("zen.ui.layout-preset", "comfortable");\nuser_pref("zen.tabs.vertical.right-side", true);\n'),
    # The user's own profile: minimal, compact tabs, breakout disabled.
    ("minimal, no breakout", 'user_pref("zen.ui.layout-preset", "minimal");\nuser_pref("zen.tabs.style", "compact");\n'
     'user_pref("zen.urlbar.disable-breakout", true);\nuser_pref("zen.view.compact.hide-toolbar", true);\n'),
]

for name, prefs in CASES:
    port = regress.free_port()
    proc = regress.launch("/tmp/claude-1000/urlbar-overlay-%d" % port, port,
                          prefs=prefs + 'user_pref("zen.glass.file", "/nonexistent");\n')
    try:
        m = regress.Marionette(port)
        time.sleep(3)
        r = m.js(RUN)
    finally:
        proc.terminate()
        proc.wait(15)
    o, rest, back = r["open"], r["rest"], r["back"]
    check(f"{name}: results open", o["open"])
    check(f"{name}: sidebar width never changed", o["widths"] == [rest["side"][2]], o["widths"])
    check(f"{name}: field reaches over the page", o["field"][2] > rest["side"][2] and o["fieldOver"],
          f"field w={o['field'][2]} sidebar w={rest['side'][2]}")
    check(f"{name}: results over the page, solid", o["resultsOver"] and o["solid"])
    check(f"{name}: field and results are one panel", o["join"] == [0, 0, 0], o["join"])
    check(f"{name}: blur returns the exact rest rect", back["field"] == rest["field"] and not back["attr"],
          f"{back['field']} vs {rest['field']}")

print(f"{sum(RESULTS)}/{len(RESULTS)} passed")
sys.exit(0 if all(RESULTS) else 1)
