#!/usr/bin/env python3
"""One playing card must be drawn whenever it should be. Random runs of what
the user does - tab switches, fast flips, clicking the card, hovering and
leaving the stack - and after each settle: the card is unhidden, opaque,
inside the bar and on top at its centre. Second monitor."""
import json, os, random, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import regress

STEPS = int(os.environ.get("STEPS", "60"))
SEED = int(os.environ.get("SEED", "1"))

SETUP = """
  const P = Services.scriptSecurityManager.getSystemPrincipal();
  window._tone = gBrowser.addTab('file://%s', {triggeringPrincipal: P});
  gBrowser.selectedTab = _tone;
  await new Promise(r => setTimeout(r, 6000));
  window._a = gBrowser.addTab('about:robots', {triggeringPrincipal: P});
  window._b = gBrowser.addTab('about:mozilla', {triggeringPrincipal: P});
  gBrowser.selectedTab = _a;
  await new Promise(r => setTimeout(r, 1500));
  return JSON.stringify(_tone.linkedBrowser.browsingContext.mediaController.isPlaying);"""

OPS = {
    "own": "gBrowser.selectedTab = _tone;",
    "a": "gBrowser.selectedTab = _a;",
    "b": "gBrowser.selectedTab = _b;",
    "flip": "gBrowser.selectedTab = _tone; await new Promise(r => setTimeout(r, %d)); gBrowser.selectedTab = _a;",
    "flip2": "gBrowser.selectedTab = _b; await new Promise(r => setTimeout(r, %d)); gBrowser.selectedTab = _tone;"
             " await new Promise(r => setTimeout(r, %d)); gBrowser.selectedTab = _a;",
    # The card's body: mousedown goes to its tab.
    "click": """const c = [...document.querySelectorAll('.zen-media-card')].find(c => !c.hidden);
                if (c) c.querySelector('.zen-media-info-vbox, .zen-media-main-vbox')
                  .dispatchEvent(new MouseEvent('mousedown', {bubbles: true}));""",
    "click-icon": """const c = [...document.querySelectorAll('.zen-media-card')].find(c => !c.hidden);
                c?.querySelector('.zen-media-focus-button')?.doCommand();""",
    "hover": """const bar = document.getElementById('zen-media-controls-toolbar');
                if (!bar._lock) { InspectorUtils.addPseudoClassLock(bar, ':hover'); bar._lock = true; }
                bar.dispatchEvent(new PointerEvent('pointerenter'));""",
    "leave": """const bar = document.getElementById('zen-media-controls-toolbar');
                if (bar._lock) { InspectorUtils.removePseudoClassLock(bar, ':hover'); bar._lock = false; }
                bar.dispatchEvent(new PointerEvent('pointerleave'));""",
    "sb-in": "document.getElementById('navigator-toolbox').setAttribute('zen-has-hover', 'true');",
    "sb-out": "document.getElementById('navigator-toolbox').removeAttribute('zen-has-hover');",
    "pause": "_tone.linkedBrowser.browsingContext.mediaController.pause('user');",
    "play": "_tone.linkedBrowser.browsingContext.mediaController.play('user');",
}

COMPACT = os.environ.get("COMPACT", "1") == "1"
CHECK = "const COMPACT = %s;" % ("true" if COMPACT else "false") + """
  const bar = document.getElementById('zen-media-controls-toolbar');
  if (bar._lock) { InspectorUtils.removePseudoClassLock(bar, ':hover'); bar._lock = false;
    bar.dispatchEvent(new PointerEvent('pointerleave')); }
  if (gBrowser.selectedTab === _tone) gBrowser.selectedTab = _a;
  _tone.linkedBrowser.browsingContext.mediaController.play('user');
  const tb = document.getElementById('navigator-toolbox');
  if (COMPACT) { tb.removeAttribute('zen-has-hover'); await new Promise(r => setTimeout(r, 400));
    tb.setAttribute('zen-has-hover', 'true'); }
  await new Promise(r => setTimeout(r, 1600));
  const card = [...document.querySelectorAll('.zen-media-card')].find(c => c.getAttribute('zen-owner') == _tone.linkedBrowser.browserId)
    || [...document.querySelectorAll('.zen-media-card')][0];
  if (!card) return JSON.stringify({ok: false, why: 'no card element'});
  const r = card.getBoundingClientRect(), b = bar.getBoundingClientRect();
  const cs = getComputedStyle(card), inner = getComputedStyle(card.firstElementChild);
  const top = r.width ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
  const st = {hidden: card.hidden, barHidden: bar.hidden, attrs: [...card.attributes].map(a => a.name).join(' '),
    rect: [r.left, r.top, r.width, r.height].map(Math.round), bar: [b.top, b.height].map(Math.round),
    opacity: cs.opacity, vis: cs.visibility, inner: inner.opacity + ' ' + inner.visibility,
    transform: cs.transform, top: top ? (top.id || top.className) : null,
    vars: ['--zen-media-collapsed-height', '--zen-media-expanded-height', '--zen-media-reveal']
      .map(v => bar.style.getPropertyValue(v)).join(','),
    trace: gZenMediaController.recentTrace?.().slice(-8)};
  st.toolbox = Math.round(tb.getBoundingClientRect().right);
  st.ok = !card.hidden && !bar.hidden && +cs.opacity > 0.9 && cs.visibility == 'visible' && +inner.opacity > 0.9
    && r.height >= 20 && r.top >= b.top - 2 && r.bottom <= b.bottom + 2 && !!top && card.contains(top);
  return JSON.stringify(st);"""

regress._write_tone_page()
port = regress.free_port()
proc = regress.launch("/tmp/claude-1000/card-vis-%d" % port, port,
                      prefs='user_pref("media.autoplay.default", 0);\n'
                            'user_pref("media.autoplay.blocking_policy", 0);\n')
rng = random.Random(SEED)
fails = 0
try:
    m = regress.Marionette(port)
    time.sleep(3)
    print("playing:", m.js(SETUP % regress.TONE_PAGE), flush=True)
    if COMPACT:
        m.js("gZenCompactModeManager.preference = true; await new Promise(r => setTimeout(r, 1000));"
             " return JSON.stringify(gZenCompactModeManager.preference);")
    for step in range(STEPS):
        seq = [rng.choice(list(OPS)) for _ in range(rng.randint(1, 4))]
        body = []
        for op in seq:
            code = OPS[op]
            if "%d" in code:
                code = code % tuple(rng.choice([0, 10, 40, 100, 130, 200, 320]) for _ in range(code.count("%d")))
            body.append(code + " await new Promise(r => setTimeout(r, %d));" % rng.choice([0, 20, 90, 150, 300, 700]))
        m.js("\n".join(body) + " return '1';")
        r = m.js(CHECK)
        if not r["ok"]:
            fails += 1
            print("FAIL", step, seq, json.dumps(r, ensure_ascii=False), flush=True)
    print(f"{STEPS - fails}/{STEPS} settled with the card drawn", flush=True)
finally:
    proc.terminate()
    proc.wait(15)
sys.exit(1 if fails else 0)
