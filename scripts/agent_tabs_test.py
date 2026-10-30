#!/usr/bin/env python3
"""The two tab modes as real behaviour (#68).

Attended: the agent acts on whatever the user is looking at, and following
them is the correct behaviour - it must never pull the selection back.
Silent: its tab exists, is marked in both tab strips, and never takes focus.
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from agent_harness import (Marionette, Channel, free_port, launch, check,
                           report, shot, PROFILE)




def main():
    port = free_port(3380)
    proc = launch(port)
    try:
        m = Marionette(port)
        st = m.js("""
          const { ZenAgentChannel } = ChromeUtils.importESModule(
            "resource:///modules/zen/agent/ZenAgentChannel.sys.mjs");
          return JSON.stringify(await ZenAgentChannel.start("attended"));
        """)
        token = open(os.path.join(PROFILE, "zen-agent.token")).read().strip()
        c = Channel(st["socket"])
        c.call("hello", token=token, write=True)

        # Two tabs the user owns, second one selected by the user.
        setup = m.js("""
          const w = Services.wm.getMostRecentWindow("navigator:browser");
          const p = Services.scriptSecurityManager.getSystemPrincipal();
          const t2 = w.gBrowser.addTab("https://example.com/", {triggeringPrincipal: p});
          w.gBrowser.selectedTab = t2;
          await new Promise(r => w.setTimeout(r, 3000));
          return JSON.stringify({
            count: w.gBrowser.tabs.length,
            selIndex: w.gBrowser.tabs.indexOf(w.gBrowser.selectedTab),
          });
        """)
        check("attended-setup", setup["count"] >= 2, f"tabs={setup['count']}")

        # ATTENDED: with no tabId the agent must act on the tab the user is
        # looking at right now - not one it remembered.
        r = c.call("navigate", url="https://example.org/")
        landed = m.js("""
          const w = Services.wm.getMostRecentWindow("navigator:browser");
          const tabs = [...w.gBrowser.tabs];
          return JSON.stringify({
            selIndex: tabs.indexOf(w.gBrowser.selectedTab),
            selUrl: w.gBrowser.selectedBrowser.currentURI.spec,
            urls: tabs.map(t => t.linkedBrowser.currentURI.spec),
          });
        """)
        check("attended-acts-on-user-tab",
              r.get("ok") is True and "example.org" in landed["selUrl"],
              f"selected={landed['selUrl'][:40]}")
        check("attended-kept-user-selection",
              landed["selIndex"] == setup["selIndex"],
              f"selection {setup['selIndex']}->{landed['selIndex']}")

        # The user switches tabs. The agent must FOLLOW, never drag focus back.
        moved = m.js("""
          const w = Services.wm.getMostRecentWindow("navigator:browser");
          w.gBrowser.selectedTab = w.gBrowser.tabs[0];
          await new Promise(r => w.setTimeout(r, 800));
          return JSON.stringify({
            selIndex: w.gBrowser.tabs.indexOf(w.gBrowser.selectedTab)});
        """)
        r = c.call("navigate", url="https://example.net/")
        after = m.js("""
          const w = Services.wm.getMostRecentWindow("navigator:browser");
          const tabs = [...w.gBrowser.tabs];
          return JSON.stringify({
            selIndex: tabs.indexOf(w.gBrowser.selectedTab),
            selUrl: w.gBrowser.selectedBrowser.currentURI.spec,
            otherUrl: tabs[1].linkedBrowser.currentURI.spec,
          });
        """)
        check("attended-follows-user-switch",
              "example.net" in after["selUrl"],
              f"acted on the newly selected tab: {after['selUrl'][:34]}")
        check("attended-never-reclaims-focus",
              after["selIndex"] == moved["selIndex"],
              f"selection stayed at {after['selIndex']}")
        check("attended-left-other-tab-alone",
              "example.org" in after["otherUrl"],
              f"other tab untouched: {after['otherUrl'][:34]}")

        # SILENT: an agent tab is marked in BOTH strips.
        m.js("""
          const w = Services.wm.getMostRecentWindow("navigator:browser");
          const { ZenAgentChannel } = ChromeUtils.importESModule(
            "resource:///modules/zen/agent/ZenAgentChannel.sys.mjs");
          await ZenAgentChannel.start("silent");
          return JSON.stringify({ok: true});
        """)
        r = c.call("newAgentTab", url="https://example.com/")
        tabid = (r.get("result") or {}).get("tabId")
        vert = m.js("""
          const w = Services.wm.getMostRecentWindow("navigator:browser");
          await new Promise(r => w.setTimeout(r, 2000));
          const marked = [...w.gBrowser.tabs].filter(t => t.hasAttribute("zen-agent"));
          const cs = marked.length ? w.getComputedStyle(marked[0]) : null;
          return JSON.stringify({
            marked: marked.length,
            selectedIsAgent: w.gBrowser.selectedTab.hasAttribute("zen-agent"),
            outlineW: cs ? cs.outlineWidth : "0px",
          });
        """)
        check("silent-tab-marked-vertical",
              vert["marked"] == 1 and vert["outlineW"] != "0px",
              f"outline={vert['outlineW']}")
        check("silent-tab-never-selected",
              vert["selectedIsAgent"] is False, "user selection untouched")

        # Switch to the horizontal layout and require the mark to survive it.
        horiz = m.js("""
          const w = Services.wm.getMostRecentWindow("navigator:browser");
          Services.prefs.setStringPref("zen.ui.layout-preset", "horizontal");
          await new Promise(r => w.setTimeout(r, 2600));
          const rows = [...w.document.querySelectorAll(".zen-htabs-tab")];
          const flagged = rows.filter(x => x.hasAttribute("agent"));
          return JSON.stringify({
            layout: w.document.documentElement.getAttribute("zen-layout"),
            rows: rows.length,
            flagged: flagged.length,
            outline: flagged.length
              ? w.getComputedStyle(flagged[0]).outlineWidth : "0px",
          });
        """)
        check("horizontal-strip-built", horiz["rows"] > 0,
              f"layout={horiz['layout']} rows={horiz['rows']}")
        check("silent-tab-marked-horizontal",
              horiz["flagged"] == 1 and horiz["outline"] != "0px",
              f"flagged={horiz['flagged']} outline={horiz['outline']}")
        shot(m, "07-horizontal-agent-tab")

        # Closing the tab must drop the agent's handle, not dangle.
        closed = m.js("""
          const w = Services.wm.getMostRecentWindow("navigator:browser");
          const t = [...w.gBrowser.tabs].find(x => x.hasAttribute("zen-agent"));
          w.gBrowser.removeTab(t);
          await new Promise(r => w.setTimeout(r, 900));
          const { ZenAgentTabs } = ChromeUtils.importESModule(
            "resource:///modules/zen/agent/ZenAgentTabs.sys.mjs");
          return JSON.stringify({live: ZenAgentTabs.list().length});
        """)
        check("closing-agent-tab-drops-handle", closed["live"] == 0,
              f"live handles={closed['live']}")
        r = c.call("navigate", tabId=tabid, url="https://example.org/")
        check("closed-tab-handle-refuses", r.get("code") == "no-such-tab",
              f"code={r.get('code')}")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except Exception:
            proc.kill()

    return report()


if __name__ == "__main__":
    sys.exit(main())
