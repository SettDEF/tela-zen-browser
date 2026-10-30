#!/usr/bin/env python3
"""The loading pill while an agent works in a tab (#76).

A local server holds each response for 3 s, so the pill can be caught
mid-call: present on the tab being driven, named in words, gone afterwards,
and never flashed by a call that is refused at once. Screenshot saved for
looking at - the pill is a visual feature and numbers alone have lied here.
"""
import http.server, json, os, sys, threading, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from agent_harness import Marionette, free_port, launch, check, report, shot
from agent_mcp_test import McpClient, text_of, is_error


class Slow(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        time.sleep(5)
        body = b"<title>slow page</title><h1>Slow page</h1><p>Held for three seconds.</p>"
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Slow)
threading.Thread(target=srv.serve_forever, daemon=True).start()
SLOW = f"http://127.0.0.1:{srv.server_address[1]}/slow"

MARKER = """
  const w = Services.wm.getMostRecentWindow("navigator:browser");
  const mk = w.document.getElementById("zen-agent-marker");
  return JSON.stringify(mk ? w.getComputedStyle(mk).display : "absent");
"""

PILL = """
  const w = Services.wm.getMostRecentWindow("navigator:browser");
  const tab = %s;
  const panel = w.document.getElementById(tab.linkedPanel);
  const bar = panel?.querySelector(":scope > .zen-agent-progress");
  if (!bar) return JSON.stringify(null);
  const r = bar.getBoundingClientRect(), cs = w.getComputedStyle(bar);
  return JSON.stringify({ active: bar.hasAttribute("active"), label: bar.getAttribute("aria-label"),
    x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height * 10) / 10, opacity: cs.opacity,
    bg: cs.backgroundColor });
"""

port = free_port(3500)
proc = launch(port)
mcp = None
try:
    m = Marionette(port)
    setup = m.js("""
      const w = Services.wm.getMostRecentWindow("navigator:browser");
      const sys = Services.scriptSecurityManager.getSystemPrincipal();
      const bg = w.gBrowser.addTab("https://example.com/", { triggeringPrincipal: sys });
      const front = w.gBrowser.addTab("https://example.org/", { triggeringPrincipal: sys });
      w.gBrowser.selectedTab = front;
      await new Promise(r => setTimeout(r, 5000));
      const { ZenAgentChannel } = ChromeUtils.importESModule(
        "resource:///modules/zen/agent/ZenAgentChannel.sys.mjs");
      const { ZenAgentTabs } = ChromeUtils.importESModule(
        "resource:///modules/zen/agent/ZenAgentTabs.sys.mjs");
      const s = await ZenAgentChannel.start("attended");
      return JSON.stringify({ socket: s.socket, bg: ZenAgentTabs.idFor(bg) });
    """)
    mcp = McpClient(dict(os.environ, ZEN_AGENT_SOCKET=setup["socket"],
                         ZEN_AGENT_CLIENT="Claude"))

    mcp.call("status")
    time.sleep(1)
    idle_marker = m.js(MARKER)
    rid = mcp.call_async("navigate", {"url": SLOW})
    time.sleep(1.2)
    during_marker = m.js(MARKER)
    during = m.js(PILL % "w.gBrowser.selectedTab")
    path = shot(m, "agent-busy-pill")
    # One frame cannot show motion. Find where the accent is strongest along
    # the pill (red minus blue: the page is grey, the accent is not) in
    # several frames, and require that place to move.
    from PIL import Image
    peaks = []
    x0, y0 = during["x"], max(0, during["y"])
    for i in range(4):
        f = shot(m, f"agent-busy-pill-{i}")
        im = Image.open(f).convert("RGB")
        cols = []
        for x in range(x0, x0 + during["w"]):
            r, g, b = im.getpixel((x, y0 + 2))
            cols.append(r - b)
        peaks.append(cols.index(max(cols)) if max(cols) > 60 else None)
        time.sleep(0.27)
    reply = mcp.await_id(rid)
    time.sleep(0.8)
    after = m.js(PILL % "w.gBrowser.selectedTab")

    check("marker-hidden-when-idle", idle_marker == "none", f"display={idle_marker}")
    check("marker-shown-while-working", during_marker == "block", f"display={during_marker}")
    check("pill-shown-while-working", bool(during and during["active"]), json.dumps(during))
    check("pill-named-in-words", bool(during and during["label"] and "opening a page" in during["label"]),
          (during or {}).get("label") or "no label")
    check("pill-same-shape-as-load-bar", bool(during and 70 <= during["w"] <= 90), f"w={(during or {}).get('w')}")
    check("pill-sweep-moves", len({p for p in peaks if p is not None}) > 1, f"brightest column per frame: {peaks}")
    check("navigate-finished-ok", not is_error(reply), text_of(reply).split("\n")[0][:60])
    check("pill-gone-after", after is None, json.dumps(after))

    time.sleep(6.5)
    after_marker = m.js(MARKER)
    check("marker-gone-after-work", after_marker == "none", f"display={after_marker}")

    # A refused call returns in milliseconds and must never flash it.
    seen = []
    rid = mcp.call_async("read_page", {"tabId": setup["bg"]})
    for _ in range(8):
        seen.append(m.js(PILL % "w.gBrowser.selectedTab"))
        time.sleep(0.05)
    refused = mcp.await_id(rid)
    check("refused-call-no-flash", is_error(refused) and all(s is None for s in seen),
          text_of(refused).split("\n")[0][:50])
    print("screenshot:", path)
finally:
    if mcp:
        mcp.close()
    proc.terminate(); proc.wait(15)
    srv.shutdown()
sys.exit(report())
