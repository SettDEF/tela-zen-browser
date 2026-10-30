#!/usr/bin/env python3
"""Do our chrome stylesheets still style anything?

A patch that stops applying is caught by patches-apply. CSS that applies
cleanly while the element it styled has moved or been renamed upstream is
caught by nothing - it just stops doing anything. This opens a fresh browser
in a fixed state, walks every rule of our stylesheets in every layout preset,
and records which selectors match an element. The set is the baseline; a
selector in it that no longer matches anything fails the run.

  selector_match.py            compare against scripts/selector-baseline.json
  selector_match.py --update   write the baseline from this build

Nested rules are resolved against their parents (`&` is `:is(parent)`), and
state pseudo-classes and pseudo-elements are stripped first: `:hover` and
`::before` say when a rule applies, not what it is for. Second monitor."""
import argparse, json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import regress

BASELINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "selector-baseline.json")
PRESETS = ["comfortable", "compact", "horizontal"]

WALK = r"""
  const STATE = /::?(?:before|after|marker|placeholder|selection|backdrop|first-line|first-letter|-moz-[\w-]+(?:\([^)]*\))?)|:(?:hover|active|focus(?:-visible|-within)?|visited|link|checked|disabled|enabled|open|popover-open|placeholder-shown|indeterminate|-moz-[\w-]+)(?![\w-])/g;
  const out = {};
  const resolve = (sel, parent) => {
    if (!parent) return sel;
    return sel.includes('&') ? sel.replaceAll('&', ':is(' + parent + ')') : ':is(' + parent + ') ' + sel;
  };
  const walk = (rules, parent, file) => {
    for (const r of rules) {
      let mine = parent;
      if (r.selectorText !== undefined && r.style) {
        mine = resolve(r.selectorText, parent);
        const clean = mine.replace(STATE, '').replace(/:is\(\s*\)/g, '*').replace(/\(\s*\)/g, '(*)');
        let hit = false, bad = false;
        try { hit = !!document.querySelector(clean.trim() || '*'); } catch (e) { bad = true; }
        if (!bad) {
          const key = file + ' | ' + r.selectorText.replace(/\s+/g, ' ').slice(0, 300) + (parent ? '  <in ' + parent.replace(/\s+/g, ' ').slice(0, 120) + '>' : '');
          out[key] = (out[key] || false) || hit;
        }
      }
      if (r.cssRules && r.cssRules.length) walk(r.cssRules, r.selectorText !== undefined ? mine : parent, file);
    }
  };
  for (const sheet of document.styleSheets) {
    const href = sheet.href || '';
    if (!/zen/.test(href)) continue;
    let rules;
    try { rules = sheet.cssRules; } catch (e) { continue; }
    walk(rules, '', href.split('/').pop());
  }
  return JSON.stringify(out);"""

SETUP = """
  const P = Services.scriptSecurityManager.getSystemPrincipal();
  const t = ['https://example.com/', 'https://example.org/', 'about:robots', 'about:mozilla']
    .map(u => gBrowser.addTab(u, {triggeringPrincipal: P}));
  gZenFolders.createFolder([t[0], t[1]], {label: 'Work', renameFolder: false});
  gBrowser.selectedTab = t[2];
  return '1';"""


def collect():
    matched = set()
    seen = set()
    for preset in PRESETS:
        port = regress.free_port()
        proc = regress.launch("/tmp/claude-1000/selmatch-%s-%d" % (preset, port), port,
                              'user_pref("zen.ui.layout-preset", "%s");\n'
                              'user_pref("zen.glass.file", "/nonexistent");\n' % preset)
        try:
            m = regress.Marionette(port)
            time.sleep(3)
            m.js(SETUP)
            time.sleep(3)
            res = m.js(WALK)
        finally:
            proc.terminate()
            proc.wait(15)
        seen |= set(res)
        matched |= {k for k, v in res.items() if v}
    return seen, matched


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--update", action="store_true")
    args = ap.parse_args()
    if regress._user_fullscreen() and not os.environ.get("REGRESS_IGNORE_FULLSCREEN"):
        sys.exit("user is fullscreen - not starting; set REGRESS_IGNORE_FULLSCREEN=1 to override")
    seen, matched = collect()
    if args.update:
        with open(BASELINE, "w") as f:
            json.dump(sorted(matched), f, indent=0)
        print("baseline: %d of %d selectors match something" % (len(matched), len(seen)))
        return
    with open(BASELINE) as f:
        base = set(json.load(f))
    # Gone from the stylesheet is a source edit, not breakage; only a selector
    # still there that stopped matching counts.
    lost = sorted(k for k in base if k in seen and k not in matched)
    print("%d of %d selectors match; %d in the baseline, %d stopped matching"
          % (len(matched), len(seen), len(base), len(lost)))
    for k in lost[:40]:
        print("  dead:", k)
    sys.exit(1 if lost else 0)


if __name__ == "__main__":
    main()
