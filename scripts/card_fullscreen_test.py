#!/usr/bin/env python3
"""A media card comes back after its video leaves fullscreen. Zen hides the
card while the video is fullscreen, and Gecko sends the controller no event
when fullscreen ends - only PiP has one. Fullscreen on the video, then on the
player around it (YouTube's way), then another tab. Second monitor."""
import http.server, io, json, math, os, struct, sys, threading, time, wave
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import regress

RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append(ok)
    print(("ok    " if ok else "FAIL  ") + f"{name:46} {detail}", flush=True)


def tone():
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(8000)
        w.writeframes(b"".join(struct.pack("<h", int(600 * math.sin(i / 8))) for i in range(8000 * 4)))
    return buf.getvalue()


WAV = tone()
PAGE = b'<!doctype html><title>clip</title><div id=player><video id=v src="/t.wav" autoplay loop></video></div>'


class Page(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body, kind = (WAV, "audio/wav") if self.path == "/t.wav" else (PAGE, "text/html")
        self.send_response(200); self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

    def log_message(self, *a):
        pass


srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Page)
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = f"http://127.0.0.1:{srv.server_address[1]}/"

RUN = """
  const P = Services.scriptSecurityManager.getSystemPrincipal();
  const tab = gBrowser.addTab(%s, {triggeringPrincipal: P});
  const other = gBrowser.addTab('about:robots', {triggeringPrincipal: P});
  gBrowser.selectedTab = tab;
  await new Promise(r => setTimeout(r, 4000));
  const c = tab.linkedBrowser.browsingContext.mediaController;
  const mm = tab.linkedBrowser.messageManager;
  mm.loadFrameScript('data:,' + encodeURIComponent(%s), false);
  await new Promise(r => setTimeout(r, 2500));
  const during = c.isBeingUsedInPIPModeOrFullscreen;
  gBrowser.selectedTab = other;
  await new Promise(r => setTimeout(r, 2500));
  const card = [...document.querySelectorAll('.zen-media-card')]
    .find(e => e.getAttribute('zen-owner') == tab.linkedBrowser.browserId);
  return JSON.stringify({playing: c.isPlaying, during, after: c.isBeingUsedInPIPModeOrFullscreen,
    winFull: window.fullScreen, card: !!card, hidden: card?.hidden, attrs: card && [...card.attributes].map(a => a.name).join(' '),
    trace: gZenMediaController.recentTrace().slice(-6)});"""

for target in ("v", "player"):
    port = regress.free_port()
    proc = regress.launch("/tmp/claude-1000/card-fs-%d" % port, port,
                          prefs='user_pref("media.autoplay.default", 0);\n'
                                'user_pref("media.autoplay.blocking_policy", 0);\n'
                                'user_pref("full-screen-api.allow-trusted-requests-only", false);\n'
                                'user_pref("full-screen-api.ignore-widgets", true);\n'
                                'user_pref("full-screen-api.transition-duration.enter", "0 0");\n'
                                'user_pref("full-screen-api.transition-duration.leave", "0 0");\n')
    try:
        m = regress.Marionette(port)
        time.sleep(3)
        r = m.js(RUN % (json.dumps(URL), json.dumps(
            "content.document.getElementById(%s).requestFullscreen()" % json.dumps(target))))
    finally:
        proc.terminate(); proc.wait(15)
    print(json.dumps(r, ensure_ascii=False))
    check(f"fullscreen on #{target}: entered", r["during"] or target == "player", r["during"])
    check(f"fullscreen on #{target}: card back on another tab", r["card"] and not r["hidden"], r.get("attrs"))

srv.shutdown()
print(f"{sum(RESULTS)}/{len(RESULTS)} passed")
sys.exit(0 if all(RESULTS) else 1)
