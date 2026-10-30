#!/usr/bin/env python3
"""One colour per assistant, derived from its name (#72 follow-on).

Two bridges connect under different names and must end up visibly distinct:
different accents, their own tabs coloured and named, and both recorded in the
audit log. Colour is never the only signal - the name appears in words too, so
a colourblind reader loses nothing.
"""
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from agent_harness import (Marionette, Channel, free_port, launch, check,
                           report, shot, PROFILE, ROOT)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from agent_mcp_test import McpClient, text_of, is_error


def main():
    port = free_port(3500)
    proc = launch(port)
    clients = []
    try:
        m = Marionette(port)
        started = m.js("""
          const { ZenAgentChannel } = ChromeUtils.importESModule(
            "resource:///modules/zen/agent/ZenAgentChannel.sys.mjs");
          return JSON.stringify(await ZenAgentChannel.start("silent"));
        """)
        sock = started["socket"]

        # Derivation is pure, so check it in the browser before any driving.
        pure = m.js("""
          const { ZenAgentIdentity } = ChromeUtils.importESModule(
            "resource:///modules/zen/agent/ZenAgentIdentity.sys.mjs");
          return JSON.stringify({
            a: ZenAgentIdentity.accentFor("claude-code"),
            aAgain: ZenAgentIdentity.accentFor("claude-code"),
            b: ZenAgentIdentity.accentFor("other-assistant"),
            anon: ZenAgentIdentity.accentFor(""),
            longName: ZenAgentIdentity.clean("x".repeat(200)).length,
            ctrl: ZenAgentIdentity.clean("bad\\u0000na\\u001fme"),
          });
        """)
        check("same-name-same-colour", pure["a"] == pure["aAgain"],
              f"{pure['a']}")
        check("different-name-different-colour", pure["a"] != pure["b"],
              f"{pure['a']} vs {pure['b']}")
        check("fixed-lightness-and-chroma",
              pure["a"].startswith("oklch(0.52 0.13 ")
              and pure["b"].startswith("oklch(0.52 0.13 "),
              "only the hue varies, so no hash can be illegible")
        check("anonymous-is-near-grey", "0.02" in pure["anon"],
              f"{pure['anon']} - no claimed identity, no identity colour")
        check("name-is-bounded", pure["longName"] == 40, "capped at 40 chars")
        check("control-chars-stripped", pure["ctrl"] == "badname",
              f"{pure['ctrl']!r}")

        # Two bridges, two names.
        a = McpClient(dict(os.environ, ZEN_AGENT_SOCKET=sock,
                           ZEN_AGENT_CLIENT="claude-code"))
        b = McpClient(dict(os.environ, ZEN_AGENT_SOCKET=sock,
                           ZEN_AGENT_CLIENT="other-assistant"))
        clients = [a, b]

        ra = a.call("new_agent_tab", url="https://example.com/")
        rb = b.call("new_agent_tab", url="https://example.org/")
        check("both-clients-opened-a-tab",
              not is_error(ra) and not is_error(rb),
              "two agent tabs")
        time.sleep(3)

        tabs = m.js("""
          const w = Services.wm.getMostRecentWindow("navigator:browser");
          const marked = [...w.gBrowser.tabs].filter(t => t.hasAttribute("zen-agent"));
          return JSON.stringify(marked.map(t => ({
            client: t.getAttribute("zen-agent-client"),
            accent: t.style.getPropertyValue("--zen-agent-accent"),
            tip: t.getAttribute("tooltiptext") || "",
            shadow: w.getComputedStyle(
              t.querySelector(".tab-background")).boxShadow,
          })));
        """)
        check("each-tab-names-its-owner",
              sorted(t["client"] for t in tabs) ==
              ["claude-code", "other-assistant"],
              ", ".join(t["client"] or "?" for t in tabs))
        accents = {t["client"]: t["accent"] for t in tabs}
        check("each-tab-wears-its-own-colour",
              len(set(accents.values())) == 2 and all(accents.values()),
              " | ".join(f"{k}={v}" for k, v in accents.items()))
        check("tab-marking-uses-the-accent",
              all("oklch" in t["shadow"] or "rgb" in t["shadow"] for t in tabs),
              "inset shadow painted on .tab-background")
        # Two assistants must not share a cookie jar, and the container stripe
        # must agree with the badge rather than contradicting it.
        cont = m.js("""
          const w = Services.wm.getMostRecentWindow("navigator:browser");
          const { ContextualIdentityService } = ChromeUtils.importESModule(
            "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs");
          const marked = [...w.gBrowser.tabs].filter(t => t.hasAttribute("zen-agent"));
          return JSON.stringify(marked.map(t => {
            const id = parseInt(t.getAttribute("usercontextid") || "0", 10);
            const ci = ContextualIdentityService.getPublicIdentityFromId(id);
            return {client: t.getAttribute("zen-agent-client"), id,
                    colour: ci ? ci.color : null, name: ci ? ci.name : null};
          }));
        """)
        check("clients-get-separate-containers",
              len({c["id"] for c in cont}) == 2 and all(c["id"] > 0 for c in cont),
              " | ".join(f"{c['client']}=ctx{c['id']}" for c in cont))
        check("container-colour-matches-identity",
              {c["client"]: c["colour"] for c in cont} ==
              {"claude-code": "yellow", "other-assistant": "blue"},
              " | ".join(f"{c['client']}={c['colour']}" for c in cont))
        check("container-names-the-client",
              all(c["client"] in (c["name"] or "") for c in cont),
              ", ".join(c["name"] or "?" for c in cont))

        check("tooltip-names-the-assistant",
              all(t["client"] in t["tip"] for t in tabs),
              tabs[0]["tip"])

        # The window indicator follows whoever acted last, and says the name.
        b.call("status")
        after_b = m.js("""
          const w = Services.wm.getMostRecentWindow("navigator:browser");
          await new Promise(r => w.setTimeout(r, 700));
          const d = w.document;
          return JSON.stringify({
            accent: d.documentElement.style.getPropertyValue("--zen-agent-accent"),
            pill: d.querySelector("#zen-agent-marker .zen-agent-pill").textContent,
          });
        """)
        check("indicator-names-active-client",
              "other-assistant" in after_b["pill"],
              f"pill={after_b['pill']!r}")
        check("indicator-takes-active-accent",
              after_b["accent"] == accents["other-assistant"],
              f"{after_b['accent']}")

        a.call("status")
        after_a = m.js("""
          const w = Services.wm.getMostRecentWindow("navigator:browser");
          await new Promise(r => w.setTimeout(r, 700));
          const d = w.document;
          return JSON.stringify({
            accent: d.documentElement.style.getPropertyValue("--zen-agent-accent"),
            pill: d.querySelector("#zen-agent-marker .zen-agent-pill").textContent,
          });
        """)
        check("indicator-switches-with-driver",
              "claude-code" in after_a["pill"]
              and after_a["accent"] != after_b["accent"],
              f"pill={after_a['pill']!r}")

        # A client must not be able to name its own colour. Forge one in a
        # raw handshake and require the derived value to come back instead.
        raw = Channel(sock)
        forged = raw.call("hello", token=open(
            os.path.join(PROFILE, "zen-agent.token")).read().strip(),
            write=True, client="claude-code",
            accent="oklch(0.52 0.13 999)")
        got = (forged.get("result") or {}).get("accent")
        check("colour-cannot-be-forged",
              got == pure["a"],
              f"asked for hue 999, got {got}")
        check("forged-name-still-shares-a-colour",
              got == accents["claude-code"],
              "same name, same colour - impersonation gains nothing visual")

        # Both identities must appear in the audit log.
        log = m.js("""
          const { ZenAgentLog } = ChromeUtils.importESModule(
            "resource:///modules/zen/agent/ZenAgentLog.sys.mjs");
          await ZenAgentLog.init();
          const e = ZenAgentLog.entries;
          return JSON.stringify({
            clients: [...new Set(e.map(x => x.client).filter(Boolean))].sort(),
            withClient: e.filter(x => x.client).length,
            total: e.length,
          });
        """)
        check("log-records-which-assistant",
              log["clients"] == ["claude-code", "other-assistant"],
              ", ".join(log["clients"]))
        check("log-attributes-most-entries",
              log["withClient"] >= log["total"] - 2,
              f"{log['withClient']}/{log['total']} carry a client")

        # The panel lists both, each with its own swatch.
        panel = m.js("""
          const w = Services.wm.getMostRecentWindow("navigator:browser");
          const d = w.document;
          d.getElementById("nav-bar").appendChild(
            d.getElementById("zen-agent-status-button"));
          w.gZenAgentUI.togglePanel();
          await new Promise(r => w.setTimeout(r, 900));
          const rows = [...d.querySelectorAll("#zen-agent-panel-body .zen-agent-client-row")];
          return JSON.stringify({
            count: rows.length,
            text: rows.map(r => r.textContent),
            accents: rows.map(r => r.style.getPropertyValue("--zen-agent-accent")),
          });
        """)
        check("panel-lists-every-client", panel["count"] == 2,
              f"rows={panel['count']} {panel['text']}")
        check("panel-rows-named-and-coloured",
              all(panel["text"]) and len(set(panel["accents"])) == 2,
              " | ".join(panel["text"]))
        shot(m, "09-two-assistants")
    finally:
        for c in clients:
            c.close()
        try:
            proc.terminate()
            proc.wait(timeout=15)
        except Exception:
            proc.kill()
    return report()


if __name__ == "__main__":
    sys.exit(main())
