#!/usr/bin/env python3
"""Drive readPage and screenshot over the real channel."""
import os, subprocess, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from agent_harness import (Marionette, Channel, free_port, launch, check,
                           report, shot, PROFILE)

def main():
    port = free_port(3160); proc = launch(port)
    try:
        m = Marionette(port)
        started = m.js("""
          const { ZenAgentChannel } = ChromeUtils.importESModule(
            "resource:///modules/zen/agent/ZenAgentChannel.sys.mjs");
          return JSON.stringify(await ZenAgentChannel.start("attended"));
        """)
        sock = started["socket"]
        token = open(os.path.join(PROFILE, "zen-agent.token")).read().strip()
        c = Channel(sock); c.call("hello", token=token, write=True)

        r = c.call("navigate", url="https://example.com/")
        check("nav-for-read", r.get("ok") is True, r.get("code",""))

        r = c.call("readPage")
        res = r.get("result") or {}
        md = res.get("markdown", "")
        check("readPage-works", r.get("ok") is True, f"code={r.get('code','')}")
        check("readPage-returns-markdown", "Example Domain" in md,
              f"extractor={res.get('extractor')} chars={len(md)}")
        check("readPage-is-not-html", "<html" not in md.lower() and "<div" not in md.lower(),
              f"first={md[:48]!r}")
        check("readPage-labels-untrusted", res.get("untrusted") is True,
              f"untrusted={res.get('untrusted')} flagged={res.get('injectionSuspected')}")
        check("readPage-has-title", bool(res.get("title")), f"title={res.get('title')!r}")

        r = c.call("screenshot")
        png = (r.get("result") or {}).get("png", "")
        check("screenshot-works", r.get("ok") is True, f"code={r.get('code','')}")
        check("screenshot-is-png", png.startswith("data:image/png;base64,"),
              f"bytes={len(png)}")

        # A deterministic local page: every markdown construct, plus nav and
        # footer that must be dropped and an injection string that must be
        # flagged without being acted on.
        srv = subprocess.Popen(
            [sys.executable, "-m", "http.server", "8791", "--bind", "127.0.0.1"],
            cwd="/tmp/claude-1000/agentpage",
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(1.5)
        try:
            c.call("navigate", url="http://127.0.0.1:8791/")
            r = c.call("readPage")
            res = r.get("result") or {}
            md = res.get("markdown", "")
            check("md-keeps-headings",
                  "# Top Heading" in md and "## Second Level" in md
                  and "### Third Level" in md, "h1/h2/h3 all present")
            check("md-keeps-inline",
                  "**bold**" in md and "*italic*" in md
                  and "`inline_code`" in md
                  and "[link](https://example.com/target)" in md,
                  "bold/italic/code/link")
            check("md-keeps-lists",
                  "- first bullet" in md and "1. step one" in md, "ul and ol")
            check("md-keeps-code-and-quote",
                  "```" in md and "> a quoted claim" in md, "pre and blockquote")
            check("md-keeps-table", "| Col A | Col B |" in md, "table row")
            check("md-drops-chrome",
                  "nav link" not in md and "footer text" not in md
                  and "window.x" not in md, "nav/footer/script dropped")
            check("md-flags-injection",
                  len(res.get("injectionSuspected") or []) >= 2,
                  f"hits={res.get('injectionSuspected')}")
            check("md-still-returns-flagged-text",
                  "Ignore all previous instructions" in md,
                  "content returned as data, not censored")
        finally:
            srv.terminate()

        # Guarded origins refuse reads and captures, not just navigation.
        m.js("""
          const w = Services.wm.getMostRecentWindow("navigator:browser");
          w.gBrowser.selectedBrowser.loadURI(
            Services.io.newURI("https://github.com/"),
            {triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()});
          await new Promise(r => w.setTimeout(r, 5000));
          return JSON.stringify({url: w.gBrowser.selectedBrowser.currentURI.spec});
        """)
        r = c.call("readPage")
        check("readPage-refuses-guarded", r.get("code") == "origin-guarded",
              f"code={r.get('code')}")
        r = c.call("screenshot")
        check("screenshot-refuses-guarded", r.get("code") == "origin-guarded",
              f"code={r.get('code')}")

        # Both must appear in the audit log like any other verb.
        log = m.js("""
          const { ZenAgentLog } = ChromeUtils.importESModule(
            "resource:///modules/zen/agent/ZenAgentLog.sys.mjs");
          await ZenAgentLog.init();
          const e = ZenAgentLog.entries;
          return JSON.stringify({
            verbs: [...new Set(e.map(x => x.verb))],
            shots: e.filter(x => x.verb === "screenshot").length,
            reads: e.filter(x => x.verb === "readPage").length,
          });
        """)
        check("screenshot-audited", log["shots"] >= 2, f"entries={log['shots']}")
        check("readPage-audited", log["reads"] >= 2, f"entries={log['reads']}")
    finally:
        proc.terminate()
        try: proc.wait(timeout=15)
        except Exception: proc.kill()
    return report()

if __name__ == "__main__":
    sys.exit(main())
