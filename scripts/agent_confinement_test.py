#!/usr/bin/env python3
"""Can the agent reach tabs that are not its own? (#76)

Silent mode must be confined to agent tabs; attended mode to agent tabs plus
the tab the user is looking at. Ids are small sequential integers, so every id
up to 30 is tried rather than only the ones list_tabs hands out. Driven
through the real MCP bridge, on the throwaway agentdrive profile.
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from agent_harness import Marionette, free_port, launch, check, report
from agent_mcp_test import McpClient, text_of, is_error

port = free_port(3480)
proc = launch(port)
mcp = None
try:
    m = Marionette(port)
    setup = m.js("""
      Services.prefs.setBoolPref("zen.agent.enabled", true);
      const w = Services.wm.getMostRecentWindow("navigator:browser");
      const sys = Services.scriptSecurityManager.getSystemPrincipal();
      const bg = w.gBrowser.addTab("https://example.com/", { triggeringPrincipal: sys });
      const front = w.gBrowser.addTab("https://example.org/", { triggeringPrincipal: sys });
      w.gBrowser.selectedTab = front;
      await new Promise(r => setTimeout(r, 6000));
      const { ZenAgentChannel } = ChromeUtils.importESModule(
        "resource:///modules/zen/agent/ZenAgentChannel.sys.mjs");
      const { ZenAgentTabs } = ChromeUtils.importESModule(
        "resource:///modules/zen/agent/ZenAgentTabs.sys.mjs");
      const s = await ZenAgentChannel.start("silent");
      return JSON.stringify({ socket: s.socket,
        bg: ZenAgentTabs.idFor(bg), front: ZenAgentTabs.idFor(front) });
    """)
    mcp = McpClient(dict(os.environ, ZEN_AGENT_SOCKET=setup["socket"]))
    own = json.loads(text_of(mcp.call("new_agent_tab", url="https://example.net/")))["tabId"]

    # --- silent ---
    tabs = json.loads(text_of(mcp.call("list_tabs")))["tabs"]
    check("silent-list-only-agent-tabs",
          all(t["agentOwned"] for t in tabs) and any(t["tabId"] == own for t in tabs),
          f"{len(tabs)} listed, all agent-owned")
    leaks = []
    for tid in range(1, 31):
        if tid == own:
            continue
        for tool, args in (("read_page", {}), ("screenshot", {}),
                           ("navigate", {"url": "https://www.iana.org/"})):
            r = mcp.call(tool, tabId=tid, **args)
            if not is_error(r):
                leaks.append(f"{tool}({tid})")
    check("silent-refuses-every-other-id", not leaks, ", ".join(leaks) or "ids 1-30 refused")
    # navigate waits for the load; new_agent_tab returns before it.
    r = mcp.call("navigate", tabId=own, url="https://example.com/")
    check("silent-own-tab-navigates", not is_error(r), text_of(r).split("\n")[0][:60])
    r = mcp.call("read_page", tabId=own)
    check("silent-own-tab-works", not is_error(r) and "Example Domain" in text_of(r),
          text_of(r).replace("\n", " ")[:80])
    r = mcp.call("navigate", tabId=own, url="https://zen-agent-probe.invalid/")
    check("failed-load-is-an-error", is_error(r) and "load-failed" in text_of(r),
          text_of(r).split("\n")[0][:70])
    urls = m.js("""
      const w = Services.wm.getMostRecentWindow("navigator:browser");
      return JSON.stringify([...w.gBrowser.tabs].filter(t => !t.hasAttribute("zen-agent"))
        .map(t => t.linkedBrowser.currentURI.spec));
    """)
    check("silent-user-tabs-untouched", "https://www.iana.org/" not in urls, str(urls))

    # --- attended ---
    m.js("""
      const { ZenAgentChannel } = ChromeUtils.importESModule(
        "resource:///modules/zen/agent/ZenAgentChannel.sys.mjs");
      return JSON.stringify(await ZenAgentChannel.start("attended"));
    """)
    r = mcp.call("read_page", tabId=setup["front"])
    check("attended-front-tab-readable", not is_error(r), "the tab the user is looking at")
    r = mcp.call("read_page")
    check("attended-default-is-front-tab", not is_error(r) and "example.org" in text_of(r), "")
    r = mcp.call("read_page", tabId=setup["bg"])
    check("attended-refuses-background-tab", is_error(r) and "not-agent-tab" in text_of(r),
          text_of(r).split("\n")[0])
    r = mcp.call("navigate", tabId=setup["bg"], url="https://www.iana.org/")
    check("attended-cannot-navigate-background", is_error(r), text_of(r).split("\n")[0])
    r = mcp.call("read_page", tabId=own)
    check("attended-own-tab-works", not is_error(r), "")
finally:
    if mcp:
        mcp.close()
    proc.terminate(); proc.wait(15)
sys.exit(report())
