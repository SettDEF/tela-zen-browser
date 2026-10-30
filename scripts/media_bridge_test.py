#!/usr/bin/env python3
"""TelaMediaBridge: every tab's media on the bridge, controlled per tab.

Scratch bridge (~/.scripts/media serve on its own port) and a throwaway browser
on an unseen workspace, silent (media.volume_scale 0), its bridge pref pointed
at the scratch one. Two local tabs play a tone, one with Media Session
metadata. Asserts both are listed, that a command reaches only its own tab, and
that the browser - not just the bridge - changed state.
"""
import json, os, shutil, socket, struct, subprocess, sys, time, math
sys.path.insert(0, os.path.dirname(__file__))
from agent_harness import Marionette, free_port, BINARY
from regress import _spare_workspace, _launch_on

SCRATCH = "/tmp/claude-1000/media-bridge-test"
PROFILE = f"{SCRATCH}/profile"
MEDIA = os.path.expanduser("~/.scripts/media")
BPORT = str(free_port(18790))
fails = 0


def check(name, ok, detail=""):
    global fails
    fails += not ok
    print(("PASS " if ok else "FAIL ") + name + (f"  {detail}" if detail else ""))


def media(*a):
    r = subprocess.run([MEDIA, *a], env=dict(os.environ, MEDIA_PORT=BPORT), capture_output=True, text=True)
    return r.returncode, (r.stdout + r.stderr).strip()


def tabs():
    return json.loads(media("list", "--json")[1] or "[]")


def wait(pred, t=15):
    end = time.time() + t
    while time.time() < end:
        ts = tabs()
        if pred(ts):
            return ts
        time.sleep(0.5)
    return tabs()


def tone(path, secs=120):
    rate = 8000
    frames = b"".join(struct.pack("<h", int(8000 * math.sin(2 * math.pi * 220 * i / rate))) for i in range(rate * secs))
    with open(path, "wb") as f:
        f.write(b"RIFF" + struct.pack("<I", 36 + len(frames)) + b"WAVEfmt " +
                struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16) + b"data" + struct.pack("<I", len(frames)) + frames)


shutil.rmtree(SCRATCH, ignore_errors=True)
os.makedirs(PROFILE)
tone(f"{SCRATCH}/tone.wav")
page = """<!doctype html><title>%s</title><audio id=a src="tone.wav" loop></audio><script>
%s
document.getElementById('a').play();
</script>"""
with open(f"{SCRATCH}/a.html", "w") as f:
    f.write(page % ("Tab A", "navigator.mediaSession.metadata = new MediaMetadata({title:'Song A', artist:'Artist A'});"))
with open(f"{SCRATCH}/b.html", "w") as f:
    f.write(page % ("Tab B", ""))

port = free_port(2990)
with open(f"{PROFILE}/user.js", "w") as f:
    for k, v in {"marionette.port": port, "browser.shell.checkDefaultBrowser": False,
                 "zen.behavior.restoreSession": False, "media.volume_scale": "0.0",
                 "media.autoplay.default": 0, "media.autoplay.blocking_policy": 0,
                 "media.block-autoplay-until-in-foreground": False,
                 "media.hardwaremediakeys.enabled": False,
                 "zen.media.bridge.url": f"http://127.0.0.1:{BPORT}"}.items():
        f.write(f'user_pref("{k}", {json.dumps(v)});\n')

bridge = subprocess.Popen([MEDIA, "serve"], env=dict(os.environ, MEDIA_PORT=BPORT))
spare = _spare_workspace() or "9"  # unseen; the rule is scoped to this launch
proc = _launch_on(spare, [BINARY, "--marionette", "-remote-allow-system-access", "--profile", PROFILE,
                          "--no-remote"],
                  dict(os.environ, MOZ_DISABLE_CONTENT_SANDBOX="1"), PROFILE)
m = None
stole = []


def guard():
    """Kill the test browser the moment it holds the user's focus."""
    import threading
    def run():
        while proc and proc.poll() is None:
            r = subprocess.run(["hyprctl", "activewindow", "-j"], capture_output=True, text=True)
            try:
                if json.loads(r.stdout or "{}").get("pid") == proc.pid:
                    stole.append(time.time())
                    proc.kill()
                    return
            except ValueError:
                pass
            time.sleep(0.1)
    threading.Thread(target=run, daemon=True).start()


try:
    if proc is None:
        sys.exit("browser did not start")
    guard()
    for _ in range(60):
        with socket.socket() as probe:
            if probe.connect_ex(("127.0.0.1", port)) == 0:
                break
        time.sleep(1)
    time.sleep(2)
    m = Marionette(port)
    # Pages are opened from inside, never as a launch argument: a URL on the command
    # line made Firefox request activation, and Hyprland moved the user to the test.
    m.js(f"""const sp = Services.scriptSecurityManager.getSystemPrincipal();
             gBrowser.loadURI(Services.io.newURI("file://{SCRATCH}/a.html"), {{triggeringPrincipal: sp}});
             gBrowser.addTab("file://{SCRATCH}/b.html", {{triggeringPrincipal: sp}}); return 1;""")

    ts = wait(lambda ts: len(ts) == 2 and all(t["playing"] for t in ts))
    check("both tabs listed and playing", len(ts) == 2 and all(t["playing"] for t in ts),
          json.dumps([(t["id"], t["title"], t["playing"]) for t in ts]))
    a = next((t for t in ts if t.get("title") == "Song A"), None)
    b = next((t for t in ts if t is not a), None)
    check("Media Session metadata reaches the bridge", a and a.get("artist") == "Artist A", str(a))
    if a and b:
        rc, out = media(a["id"], "pause")
        ts = wait(lambda ts: any(t["id"] == a["id"] and not t["playing"] for t in ts))
        sa = next(t for t in ts if t["id"] == a["id"]); sb = next(t for t in ts if t["id"] == b["id"])
        check("pause reaches only its tab", not sa["playing"] and sb["playing"], f"rc={rc} {out}")
        real = m.js(f"""for (const t of gBrowser.tabs) if (String(t.linkedBrowser.browserId) === "{a['id']}")
                          return t.linkedBrowser.browsingContext.mediaController.isPlaying; return null;""")
        check("the browser's own controller paused (not just the report)", real is False, str(real))
        media("1" if tabs()[0]["id"] == a["id"] else "2", "toggle")
        ts = wait(lambda ts: all(t["playing"] for t in ts))
        check("toggle by list number resumes it", all(t["playing"] for t in ts))
        ts = wait(lambda ts: all(t.get("duration") for t in ts))
        check("timeline for both tabs (B has no Media Session)", all(t.get("duration") for t in ts),
              json.dumps([(t["title"], t.get("position"), t.get("duration")) for t in ts]))
        media(b["id"], "seek", "60")
        ts = wait(lambda ts: any(t["id"] == b["id"] and (t.get("position") or 0) >= 59 for t in ts))
        sb = next(t for t in ts if t["id"] == b["id"])
        check("seek moves the timeline", (sb.get("position") or 0) >= 59, str(sb.get("position")))
        ts = wait(lambda ts: all(t.get("volume") is not None for t in ts))
        check("volume reported per tab", all(t.get("volume") is not None for t in ts),
              json.dumps([(t["title"], t.get("volume")) for t in ts]))
        rc, out = media(b["id"], "volume", "30")
        ts = wait(lambda ts: any(t["id"] == b["id"] and t.get("volume") == 30 for t in ts))
        sb = next(t for t in ts if t["id"] == b["id"]); sa = next(t for t in ts if t["id"] == a["id"])
        check("volume reaches only its tab", sb.get("volume") == 30 and sa.get("volume") != 30,
              f"rc={rc} {out} B={sb.get('volume')} A={sa.get('volume')}")
        rc, out = media("nosuchsite", "pause")
        check("unknown tab is refused", rc != 0 and "no tab matches" in out, out)
        rc, out = media("status")
        check("status falls back to the playing tab", rc == 0 and "▶" in out, out)
finally:
    if m:
        try:
            m.cmd("WebDriver:DeleteSession", {})
        except Exception:
            pass
    if proc:
        proc.terminate()
    bridge.terminate()
if stole:
    print("FAIL the test browser took the user's focus and was killed")
sys.exit(1 if fails or stole else 0)
