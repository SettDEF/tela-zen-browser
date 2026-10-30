#!/usr/bin/env python3
"""The agent channel and its permission model, driven as a real client (#67).

Socket and token permissions, the handshake, every refusal path, and the kill
switch pulled while a navigation is genuinely in flight.
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from agent_harness import (Marionette, Channel, free_port, launch, check,
                           report, PROFILE)


def main():
    port = free_port()
    proc = launch(port)
    try:
        m = Marionette(port)

        # Start the channel from chrome, as the UI toggle will.
        started = m.js("""
          const { ZenAgentChannel } = ChromeUtils.importESModule(
            "resource:///modules/zen/agent/ZenAgentChannel.sys.mjs");
          const r = await ZenAgentChannel.start("attended");
          return JSON.stringify(r);
        """)
        check("channel-starts", started.get("ok") is True,
              f"socket={os.path.basename(started.get('socket',''))}")
        sock_path = started["socket"]

        st = os.stat(sock_path)
        check("socket-is-0600", oct(st.st_mode & 0o777) == "0o600",
              f"mode={oct(st.st_mode & 0o777)}")
        tok_path = os.path.join(PROFILE, "zen-agent.token")
        tst = os.stat(tok_path)
        check("token-is-0600", oct(tst.st_mode & 0o777) == "0o600",
              f"mode={oct(tst.st_mode & 0o777)}")
        token = open(tok_path).read().strip()

        # A connection that never authenticates gets nothing.
        bad = Channel(sock_path)
        r = bad.call("listTabs")
        check("unauthenticated-refused", r.get("code") == "not-authenticated",
              f"code={r.get('code')}")
        r = bad.call("hello", token="wrong-token")
        check("bad-token-refused", r.get("code") == "bad-token",
              f"code={r.get('code')}")

        c = Channel(sock_path)
        r = c.call("hello", token=token, write=True)
        check("hello-authenticates", r.get("ok") is True,
              f"mode={r.get('result',{}).get('mode')} "
              f"guarded={len(r.get('result',{}).get('guardedHosts',[]))}")

        r = c.call("listTabs")
        check("listTabs-works", r.get("ok") is True,
              f"tabs={len(r.get('result',{}).get('tabs',[]))}")

        r = c.call("navigate", url="https://example.com/")
        check("navigate-works", r.get("ok") is True,
              f"url={r.get('result',{}).get('url','')[:40]} code={r.get('code','')}")

        # The browser's own state must agree, not just the channel's answer.
        real = m.js("""
          const w = Services.wm.getMostRecentWindow("navigator:browser");
          return JSON.stringify({url: w.gBrowser.selectedBrowser.currentURI.spec});
        """)
        check("navigate-really-landed", "example.com" in real["url"],
              f"browser-says={real['url'][:44]}")

        # Guarded origins, by exact host and by subdomain.
        r = c.call("navigate", url="https://github.com/some/repo")
        check("guarded-origin-refused", r.get("code") == "origin-guarded",
              f"code={r.get('code')}")
        r = c.call("navigate", url="https://api.github.com/x")
        check("guarded-subdomain-refused", r.get("code") == "origin-guarded",
              f"code={r.get('code')}")
        # A lookalike must NOT be caught by a substring test.
        r = c.call("navigate", url="https://github.com.evil.test/")
        check("lookalike-not-guarded", r.get("code") != "origin-guarded",
              f"code={r.get('code')} (refused for another reason is fine)")

        # Privileged schemes are refused.
        r = c.call("navigate", url="about:config")
        check("about-config-refused", r.get("code") == "scheme-refused",
              f"code={r.get('code')}")
        r = c.call("navigate", url="file:///etc/passwd")
        check("file-scheme-refused", r.get("code") == "scheme-refused",
              f"code={r.get('code')}")

        # An unknown verb is named as such rather than falling through.
        r = c.call("evaluate", script="1+1")
        check("unknown-verb-refused", r.get("code") == "unknown-verb",
              f"code={r.get('code')}")

        # A read-only session cannot write.
        ro = Channel(sock_path)
        ro.call("hello", token=token)
        r = ro.call("navigate", url="https://example.org/")
        check("readonly-refused-write", r.get("code") == "read-only-session",
              f"code={r.get('code')}")

        # Silent tab: created unselected, marked, and never steals focus.
        before = m.js("""
          const w = Services.wm.getMostRecentWindow("navigator:browser");
          return JSON.stringify({sel: w.gBrowser.tabs.indexOf(w.gBrowser.selectedTab)});
        """)
        r = c.call("newAgentTab", url="https://example.net/")
        agent_tab = r.get("result", {}).get("tabId")
        after = m.js("""
          const w = Services.wm.getMostRecentWindow("navigator:browser");
          const marked = [...w.gBrowser.tabs].filter(t => t.hasAttribute("zen-agent"));
          return JSON.stringify({
            sel: w.gBrowser.tabs.indexOf(w.gBrowser.selectedTab),
            marked: marked.length,
            markedSelected: marked.some(t => t.selected),
            container: marked.length ? marked[0].getAttribute("usercontextid") : null,
          });
        """)
        check("agent-tab-marked", after["marked"] == 1,
              f"marked={after['marked']}")
        check("agent-tab-not-selected", after["markedSelected"] is False
              and before["sel"] == after["sel"],
              f"selection {before['sel']}->{after['sel']}")
        check("agent-tab-own-container",
              after["container"] not in (None, "", "0"),
              f"usercontextid={after['container']}")

        # THE KILL SWITCH, MID-NAVIGATION. Fire a slow navigation, revoke
        # while it is still in flight, and require the in-flight call itself
        # to come back revoked.
        c.send_only("navigate", url="https://httpbin.org/delay/10")
        time.sleep(1.0)
        rev = m.js("""
          const { ZenAgentChannel } = ChromeUtils.importESModule(
            "resource:///modules/zen/agent/ZenAgentChannel.sys.mjs");
          const r = await ZenAgentChannel.revoke("test");
          return JSON.stringify(r);
        """)
        try:
            inflight = c.read()
        except Exception as e:
            inflight = {"code": f"connection-dropped ({e})"}
        check("killswitch-interrupts-inflight",
              inflight.get("code") == "revoked",
              f"in-flight reply code={inflight.get('code')}")
        check("killswitch-revoked-ok", rev.get("ok") is True, "")

        # The interruption must be real: the tab must NOT have reached the
        # slow URL. A reply saying "revoked" while the load quietly finished
        # would be exactly the dishonest state the task forbids.
        time.sleep(12)
        landed = m.js("""
          const w = Services.wm.getMostRecentWindow("navigator:browser");
          return JSON.stringify({url: w.gBrowser.selectedBrowser.currentURI.spec});
        """)
        check("killswitch-load-did-not-land",
              "httpbin.org" not in landed["url"],
              f"tab-still-at={landed['url'][:46]}")

        gone = not os.path.exists(sock_path)
        check("killswitch-removes-socket", gone, f"socket-exists={not gone}")

        # A new connection after revoke must fail outright.
        try:
            Channel(sock_path)
            reconnected = True
        except OSError:
            reconnected = False
        check("no-reconnect-after-revoke", reconnected is False, "")

        # The audit log must contain both what ran and what was refused.
        log = m.js("""
          const { ZenAgentLog } = ChromeUtils.importESModule(
            "resource:///modules/zen/agent/ZenAgentLog.sys.mjs");
          await ZenAgentLog.init();
          await ZenAgentLog.flush();
          const e = ZenAgentLog.entries;
          return JSON.stringify({
            total: e.length,
            refused: e.filter(x => x.outcome === "refused").length,
            codes: [...new Set(e.filter(x => x.code).map(x => x.code))],
          });
        """)
        check("log-records-actions", log["total"] > 0, f"entries={log['total']}")
        check("log-records-refusals", log["refused"] > 0,
              f"refused={log['refused']} codes={','.join(sorted(log['codes']))[:60]}")

        # And it must survive a restart: read the file straight off disk.
        path = os.path.join(PROFILE, "zen-agent-log.json")
        time.sleep(1.5)
        on_disk = json.load(open(path))
        check("log-persisted-to-disk",
              len(on_disk.get("entries", [])) > 0,
              f"file-entries={len(on_disk.get('entries', []))}")

        m.screenshot = None
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()

    return report()


if __name__ == "__main__":
    sys.exit(main())
