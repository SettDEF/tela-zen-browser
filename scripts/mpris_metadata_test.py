#!/usr/bin/env python3
"""Track metadata reaches MPRIS even with Plasma Browser Integration's page
hook. The extension redefines navigator.mediaSession.metadata/playbackState
with accessors that never reach Firefox; this page installs that same hook
(copied from its page-script.js), plays audio and sets the track. With
zen.mediacontrols.mirror-session on, Firefox's controller and this test
browser's own MPRIS player carry title and artist; off, they fall back to the
page title - which proves the check can fail. Second monitor."""
import http.server, io, json, math, os, struct, subprocess, sys, threading, time, wave
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import regress

RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append(ok)
    print(("ok    " if ok else "FAIL  ") + f"{name:46} {detail}", flush=True)


def tone():
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(8000)
        w.writeframes(b"".join(struct.pack("<h", int(600 * math.sin(i / 8))) for i in range(8000 * 4)))
    return buf.getvalue()


WAV = tone()
PAGE = b"""<!doctype html><title>Page Title | Music Site</title>
<audio id=a src="/t.wav" loop></audio>
<script>
  // Plasma Browser Integration's override, as in its page-script.js.
  const transfer = {metadata: null, playbackState: "none"};
  Object.defineProperty(navigator.mediaSession, "metadata", {
    get: () => transfer.metadata, set: v => { transfer.metadata = v; } });
  Object.defineProperty(navigator.mediaSession, "playbackState", {
    get: () => transfer.playbackState, set: v => { transfer.playbackState = v; } });
  document.getElementById("a").play().then(() => {
    navigator.mediaSession.metadata = new MediaMetadata(
      {title: "Brains at Work", artist: "Sandvik", album: "Rev", artwork: []});
    navigator.mediaSession.playbackState = "playing";
  });
</script>"""


class Page(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body, kind = (WAV, "audio/wav") if self.path == "/t.wav" else (PAGE, "text/html")
        self.send_response(200)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Page)
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = f"http://127.0.0.1:{srv.server_address[1]}/"


def mpris_for(pid):
    """This browser's own MPRIS player, found by the bus name's owner pid."""
    out = subprocess.run(["busctl", "--user", "list"], capture_output=True, text=True).stdout
    for line in out.splitlines():
        parts = line.split()
        if len(parts) > 1 and parts[0].startswith("org.mpris.MediaPlayer2.firefox") and parts[1] == str(pid):
            name = parts[0].removeprefix("org.mpris.MediaPlayer2.")
            meta = subprocess.run(["playerctl", "-p", name, "metadata", "--format",
                                   "{{xesam:title}}|{{xesam:artist}}"], capture_output=True, text=True).stdout
            return meta.strip()
    return None


for mirror in (True, False):
    port = regress.free_port()
    proc = regress.launch("/tmp/claude-1000/mpris-meta-%d" % port, port,
                          prefs='user_pref("media.autoplay.default", 0);\n'
                                'user_pref("media.autoplay.blocking_policy", 0);\n'
                                f'user_pref("zen.mediacontrols.mirror-session", {"true" if mirror else "false"});\n')
    try:
        m = regress.Marionette(port)
        time.sleep(3)
        r = m.js("""
          const tab = gBrowser.addTab(%s, {triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()});
          gBrowser.selectedTab = tab;
          await new Promise(r => setTimeout(r, 6000));
          const c = tab.linkedBrowser.browsingContext.mediaController;
          let md = null; try { md = c.getMetadata(); } catch (e) {}
          return JSON.stringify({playing: c.isPlaying, title: md?.title, artist: md?.artist, album: md?.album});""" % json.dumps(URL))
        pid = m.js("return JSON.stringify(Services.appinfo.processID);")
        mpris = mpris_for(pid)
    finally:
        proc.terminate()
        proc.wait(15)
    if mirror:
        check("hooked page: controller has the track", r["title"] == "Brains at Work" and r["artist"] == "Sandvik"
              and r["album"] == "Rev", r)
        check("hooked page: MPRIS has title and artist", mpris == "Brains at Work|Sandvik", mpris)
    else:
        check("mirror off: falls back to the page title", r["title"] != "Brains at Work" and not r["artist"], r)

srv.shutdown()
print(f"{sum(RESULTS)}/{len(RESULTS)} passed")
sys.exit(0 if all(RESULTS) else 1)
