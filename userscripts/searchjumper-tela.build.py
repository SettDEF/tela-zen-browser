#!/usr/bin/env python3
"""Build a single SearchJumper userscript with the Tela skin folded in.

SearchJumper builds its bar inside attachShadow({mode: "closed"}), which no
page CSS and no querySelector can reach - a companion userscript is powerless
against it unless it wins a race to patch Element.prototype.attachShadow first.
Merging removes the race: the root is opened at the source, and the skin ships
inside the same script.

Works on Linux, macOS and Windows with Python 3.8+ and no third-party packages.

    python3 searchjumper-tela.build.py            # build, then serve for install
    python3 searchjumper-tela.build.py --no-serve # just write the file
    python3 searchjumper-tela.build.py --source ./SearchJumper.user.js
"""

import argparse
import http.server
import os
import re
import socket
import socketserver
import sys
import urllib.error
import urllib.request

UPSTREAM = "https://update.greasyfork.org/scripts/445274/Search%20Jumper.user.js"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"

SHADOW_FROM = 'attachShadow({ mode: "closed" })'
SHADOW_TO = 'attachShadow({ mode: "open" })'

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_SKIN = os.path.join(HERE, "searchjumper-tela.skin.js")
DEFAULT_OUT = os.path.join(HERE, "searchjumper-tela.user.js")


def fail(msg):
    print("error: " + msg, file=sys.stderr)
    raise SystemExit(1)


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        fail("upstream returned HTTP %s for %s" % (e.code, url))
    except Exception as e:
        fail("could not download %s (%s).\nUse --source with a local copy." % (url, e))


def strip_metadata(js):
    """Drop a userscript's own ==UserScript== block; the merged file keeps one."""
    return re.sub(r"//\s*==UserScript==.*?//\s*==/UserScript==\s*", "", js, count=1, flags=re.S)


def strip_marked(js, start, end):
    pattern = re.escape(start) + r".*?" + re.escape(end)
    return re.sub(pattern, "/* patched at the source in this build */", js, flags=re.S)


def rewrite_metadata(js):
    """Rename so it sits beside the original rather than colliding with it."""
    block = re.search(r"//\s*==UserScript==.*?//\s*==/UserScript==", js, re.S)
    if not block:
        fail("no ==UserScript== block in the upstream script")
    meta = block.group(0)
    new = meta
    new = re.sub(r"(//\s*@name\s+)SearchJumper\s*$", r"\1SearchJumper (Tela skin)",
                 new, count=1, flags=re.M)
    new = re.sub(r"(//\s*@namespace\s+).*$", r"\1tela.zen.searchjumper",
                 new, count=1, flags=re.M)
    # Auto-update would pull the unpatched upstream straight back over this.
    new = re.sub(r"^//\s*@(updateURL|downloadURL|supportURL)\s+.*$\n?", "",
                 new, flags=re.M)
    if "@name         SearchJumper (Tela skin)" not in new and "(Tela skin)" not in new:
        fail("could not rename the script; upstream metadata format changed")
    return js.replace(meta, new, 1)


def build(source_js, skin_js):
    if source_js.count(SHADOW_FROM) != 1:
        fail(
            "expected exactly one %r in SearchJumper, found %d.\n"
            "Upstream changed - the shadow-root patch needs updating."
            % (SHADOW_FROM, source_js.count(SHADOW_FROM))
        )
    out = source_js.replace(SHADOW_FROM, SHADOW_TO, 1)
    out = rewrite_metadata(out)

    skin = strip_metadata(skin_js)
    skin = strip_marked(skin, "/* TELA-SHADOW-PATCH-START", "TELA-SHADOW-PATCH-END */")

    out += (
        "\n\n/* ==========================================================\n"
        "   Tela skin - merged build. The shadow root above is opened at\n"
        "   the source, so this runs in the same realm with no ordering.\n"
        "   ========================================================== */\n"
        + skin
    )
    return out


def free_port(preferred=8899):
    for port in [preferred] + list(range(8900, 8940)):
        with socket.socket() as s:
            if s.connect_ex(("127.0.0.1", port)) != 0:
                return port
    fail("no free port between 8899 and 8939")


def serve(path):
    directory, name = os.path.dirname(path), os.path.basename(path)
    port = free_port()

    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=directory, **kw)

        def end_headers(self):
            # MonkeyStyles only offers to install when it is served as JS.
            if self.path.endswith(".user.js"):
                self.send_header("Content-Type", "text/javascript; charset=utf-8")
            super().end_headers()

        def log_message(self, *a):
            pass

    url = "http://127.0.0.1:%d/%s" % (port, name)
    print("\nOpen this in your browser to install:\n\n    %s\n" % url)
    print("MonkeyStyles will show its install page - click Confirm installation.")
    print("Press Ctrl+C when you are done.\n")
    with socketserver.TCPServer(("127.0.0.1", port), Handler) as srv:
        srv.allow_reuse_address = True
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            print("stopped.")


def main():
    ap = argparse.ArgumentParser(description="Build SearchJumper with the Tela skin merged in.")
    ap.add_argument("--source", help="local SearchJumper .user.js instead of downloading")
    ap.add_argument("--skin", default=DEFAULT_SKIN, help="skin userscript (default: alongside this file)")
    ap.add_argument("--out", default=DEFAULT_OUT, help="output path")
    ap.add_argument("--no-serve", action="store_true", help="only write the file")
    args = ap.parse_args()

    if not os.path.exists(args.skin):
        fail("skin not found: %s" % args.skin)
    skin_js = open(args.skin, encoding="utf-8").read()

    if args.source:
        if not os.path.exists(args.source):
            fail("source not found: %s" % args.source)
        print("using local source: %s" % args.source)
        source_js = open(args.source, encoding="utf-8").read()
    else:
        print("downloading SearchJumper from Greasy Fork ...")
        source_js = fetch(UPSTREAM)

    version = re.search(r"//\s*@version\s+(\S+)", source_js)
    print("SearchJumper version: %s" % (version.group(1) if version else "unknown"))

    out = build(source_js, skin_js)
    with open(args.out, "w", encoding="utf-8") as f:
        f.write(out)

    print("wrote %s (%.0f KB)" % (args.out, len(out) / 1024))
    print("  shadow root  : closed -> open")
    print("  skin merged  : %d bytes" % len(skin_js))

    if not args.no_serve:
        serve(args.out)


if __name__ == "__main__":
    main()
