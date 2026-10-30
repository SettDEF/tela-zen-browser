#!/usr/bin/env python3
"""Prove a converted stylesheet still parses to the same rules.

A .scss round-trip reformats freely - quotes come off attribute selectors,
shorthand whitespace moves, comments vanish - so a textual diff proves
nothing either way. This parses both versions with Gecko's own CSS parser in
a throwaway browser and compares the resulting rule trees, which is the only
check that notices a rule silently swallowed by a broken comment.

    python3 scripts/css_equiv.py                    # every converted .scss
    python3 scripts/css_equiv.py --baseline DIR     # against saved originals
    python3 scripts/css_equiv.py src/zen/tabs/x.scss
"""

import argparse
import json
import re
import pathlib
import subprocess
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from regress import Marionette, ROOT, BINARY, free_port, launch  # noqa: E402

# Walks both sheets with the same serializer. Custom properties, priorities and
# nesting all come along; comments and whitespace deliberately do not.
SERIALIZE = r"""
const ser = rules => [...rules].map(r => {
  const e = { t: r.constructor.name };
  if (r.selectorText !== undefined) { e.s = r.selectorText; }
  if (r.conditionText !== undefined) { e.c = r.conditionText; }
  if (r.media && r.media.mediaText !== undefined) { e.m = r.media.mediaText; }
  if (r.name !== undefined) { e.n = String(r.name); }
  if (r.style) {
    e.d = [];
    for (let i = 0; i < r.style.length; i++) {
      const p = r.style[i];
      e.d.push([p, r.style.getPropertyValue(p), r.style.getPropertyPriority(p)]);
    }
  }
  if (r.cssRules) { e.r = ser(r.cssRules); }
  return e;
});
const parse = text => {
  const sheet = new (Services.wm.getMostRecentWindow("navigator:browser").CSSStyleSheet)();
  sheet.replaceSync(text);
  return ser(sheet.cssRules);
};
"""


MOZ_PREF_PAREN = re.compile(r"\((-moz-pref\([^()]*(?:\([^()]*\))?[^()]*\))\)")


def norm(value):
    """Fold the rewrites dart-sass makes that Gecko treats as identical.

    Whitespace inside a value is one; the redundant parentheses a bare
    `@media -moz-pref(x)` needs to survive a SASS parse are the other, and
    those were confirmed equivalent by toggling the pref against matchMedia
    in a real window before any file was converted - see docs/sass.md.
    """
    value = re.sub(r"\s+", " ", value).strip()
    for _ in range(4):
        after = MOZ_PREF_PAREN.sub(r"\1", value)
        after = after.replace("not (-moz-pref", "not -moz-pref")
        if after == value:
            break
        value = after
    return value


def join(conds):
    """`@media A { @media B {} }` and `@media A and B {}` gate the same
    declarations, and dart-sass freely converts one into the other. Comma
    lists do not distribute that way, so those stay structural."""
    if any("," in c for c in conds):
        return " && ".join(conds)
    return " and ".join(conds)


def flatten(node, conds=(), out=None):
    """One ordered line per declaration, addressed by the media/supports
    conditions in force and the selector - not by position in the tree, since
    dart-sass legitimately splits and merges nested @media blocks."""
    out = [] if out is None else out
    for e in node:
        here = conds
        cond = e.get("c") or e.get("m")
        if cond is not None:
            here = conds + (norm(cond),)
        elif e.get("n") is not None:
            here = conds + (e["t"] + " " + e["n"],)
        sel = norm(e.get("s") or e["t"])
        for prop, value, prio in e.get("d") or []:
            out.append("%s | %s | %s: %s%s"
                       % (join(here), sel, prop, norm(value), "!" if prio else ""))
        if e.get("r"):
            flatten(e["r"], here + ((sel,) if e.get("s") else ()), out)
    return out


def compare(m, label, before, after):
    r = m.js(SERIALIZE + "return JSON.stringify({ a: parse(%s), b: parse(%s) });"
             % (json.dumps(before), json.dumps(after)))
    fa, fb = flatten(r["a"]), flatten(r["b"])
    lost = [k for k in fa if k not in fb]
    gained = [k for k in fb if k not in fa]
    # Order matters as much as content: two rules of equal specificity are
    # decided by which came last.
    reordered = fa != fb and not (lost or gained)
    ok = not (lost or gained or reordered)
    detail = "%d declarations" % len(fa)
    if not ok:
        detail += " | lost=%s gained=%s reordered=%s" % (
            lost[:2] or "none", gained[:2] or "none", reordered)
    print("%s  %-46s %s" % ("ok  " if ok else "FAIL", label, detail), flush=True)
    return ok


def converted(rev, baseline):
    """Every .scss paired with the pre-conversion .css to compare it against:
    a file in `baseline`, else the one `rev` still tracks."""
    listing = subprocess.run(["git", "ls-tree", "-r", "--name-only", rev],
                             cwd=ROOT, capture_output=True, text=True, check=True)
    tracked = set(listing.stdout.split())
    out = []
    for scss in sorted((ROOT / "src").rglob("*.scss")):
        rel = str(scss.relative_to(ROOT))
        old = rel[:-5] + ".css"
        if baseline and (pathlib.Path(baseline) / old).exists():
            out.append((scss, old, (pathlib.Path(baseline) / old).read_text()))
        elif old in tracked:
            text = subprocess.run(["git", "show", "%s:%s" % (rev, old)], cwd=ROOT,
                                  capture_output=True, text=True, check=True).stdout
            out.append((scss, old, text))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("paths", nargs="*", help="specific .scss files")
    ap.add_argument("--rev", default="HEAD", help="revision holding the old .css")
    ap.add_argument("--baseline", help="directory of pre-conversion .css files")
    args = ap.parse_args()

    pairs = converted(args.rev, args.baseline)
    if args.paths:
        want = {str(pathlib.Path(p).resolve()) for p in args.paths}
        pairs = [p for p in pairs if str(p[0]) in want]
    if not pairs:
        sys.exit("nothing converted to compare")

    if not BINARY.exists():
        sys.exit("no build at %s" % BINARY)
    port = free_port(2960)
    proc = launch("/tmp/claude-1000/css-equiv-profile-%d" % port, port)
    failures = 0
    try:
        m = Marionette(port)
        for scss, old, before in pairs:
            after = scss.with_suffix(".css").read_text()
            if not compare(m, old, before, after):
                failures += 1
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
    print("\n%d of %d differ" % (failures, len(pairs)))
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
