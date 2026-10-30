#!/usr/bin/env python3
"""Compile src/**/*.scss to the sibling .css that jar.inc.mn and the
engine/ symlinks already point at.

Chrome CSS here still goes through Mozilla's own preprocessor afterwards, and
two of its constructs do not survive a SASS parse - see docs/sass.md. This
script only runs dart-sass; the rules about what may appear in a .scss are
enforced by scripts/check_styles.py.

    python3 scripts/build_styles.py            # compile what changed
    python3 scripts/build_styles.py --check    # fail if any .css is stale

The generated .css is build output, so this also keeps .gitignore's list of
it in step with the sources - a hand-maintained list would drift, and a
generated stylesheet committed by accident is the stale-file bug all over
again.
"""

import argparse
import os
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
SASS = ROOT / "node_modules/.bin/sass"


def sources():
    """Every .scss that is not a partial; `_name.scss` is included by others."""
    return sorted(
        p for p in SRC.rglob("*.scss")
        if not p.name.startswith("_")
    )


def compile_one(scss):
    out = subprocess.run(
        [str(SASS), "--no-source-map", "--no-charset", "--style=expanded",
         "--load-path", str(SRC), str(scss)],
        capture_output=True, text=True,
    )
    if out.returncode != 0:
        sys.stderr.write(out.stderr)
        raise SystemExit("sass failed on %s" % scss.relative_to(ROOT))
    if out.stderr.strip():
        sys.stderr.write(out.stderr)
    return out.stdout


BEGIN = "# BEGIN generated stylesheets (scripts/build_styles.py)"
END = "# END generated stylesheets"


def sync_gitignore(outputs):
    """Rewrite the managed block in .gitignore, so the ignore list cannot
    fall behind the set of .scss sources."""
    path = ROOT / ".gitignore"
    lines = path.read_text().splitlines()
    body = [BEGIN] + ["/" + str(p.relative_to(ROOT)) for p in outputs] + [END]
    if BEGIN in lines:
        start, stop = lines.index(BEGIN), lines.index(END)
        kept = lines[:start] + body + lines[stop + 1:]
    else:
        kept = lines + [""] + body
    text = "\n".join(kept) + "\n"
    if text != path.read_text():
        path.write_text(text)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true",
                    help="report stale output instead of writing it")
    args = ap.parse_args()

    if not SASS.exists():
        raise SystemExit("no dart-sass at %s - run `npm install`" % SASS)

    written = stale = 0
    for scss in sources():
        css = scss.with_suffix(".css")
        text = compile_one(scss)
        current = css.read_text() if css.exists() else None
        if current == text:
            continue
        if args.check:
            print("stale: %s" % css.relative_to(ROOT))
            stale += 1
            continue
        # Only on change: an untouched mtime keeps `mach build faster` from
        # redoing work, and a rewritten one is how it learns to.
        css.write_text(text)
        written += 1

    sync_gitignore([p.with_suffix(".css") for p in sources()])

    if args.check and stale:
        raise SystemExit("%d generated stylesheet(s) out of date - run "
                         "`npm run styles`" % stale)
    print("styles: %d source(s), %d written" % (len(sources()), written))


if __name__ == "__main__":
    main()
