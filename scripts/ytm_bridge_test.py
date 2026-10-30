#!/usr/bin/env python3
"""media-ytm userscript against the real music.youtube.com, in a background window.

Runs the bridge on a scratch port and a logged-out throwaway browser on the
spare monitor (unfocused, no audio: media.volume_scale 0), injects userscripts/media-ytm.user.js
with a GM_xmlhttpRequest shim, and drives it with the `ytm` CLI. Logged out on
purpose: a second logged-in YTM session can pause the user's own playback.
"""
import os, shutil, subprocess, sys, time, json
sys.path.insert(0, os.path.dirname(__file__))
from agent_harness import Marionette, free_port, BINARY, ROOT

PROFILE = "/tmp/claude-1000/ytm-bridge-profile"
YTM = os.path.expanduser("~/.scripts/media")
BPORT = "18788"
VIDEO, VIDEO2 = "lYBUbBu4W08", "dQw4w9WgXcQ"
fails = 0

def check(name, ok, detail=""):
    global fails
    fails += not ok
    print(("PASS " if ok else "FAIL ") + name + (f"  {detail}" if detail else ""))

def ytm(*a):
    r = subprocess.run([YTM, *a], env=dict(os.environ, YTM_PORT=BPORT), capture_output=True, text=True)
    return r.returncode, (r.stdout + r.stderr).strip()

def state():
    return json.loads(ytm("status", "--json")[1])

def wait(pred, t=20):
    end = time.time() + t
    while time.time() < end:
        s = state()
        if pred(s): return s
        time.sleep(0.5)
    return state()

port = free_port(2990)
shutil.rmtree(PROFILE, ignore_errors=True); os.makedirs(PROFILE)
with open(f"{PROFILE}/user.js", "w") as f:
    for k, v in {"marionette.port": port, "browser.shell.checkDefaultBrowser": False,
                 "media.volume_scale": '"0.0"', "media.autoplay.default": 0,
                 "media.autoplay.blocking_policy": 0, "media.hardwaremediakeys.enabled": False,
                 "zen.behavior.restoreSession": False}.items():
        f.write(f'user_pref("{k}", {json.dumps(v) if not isinstance(v, str) else v});\n')
bridge = subprocess.Popen([YTM, "serve"], env=dict(os.environ, YTM_PORT=BPORT))
# Headless crashes this build; launch on the monitor the user is not on instead
# (unfocused, which is also the background condition under test).
from regress import _spare_workspace, _launch_on
spare = _spare_workspace() or "9"  # an unseen workspace; the rule is scoped to this launch
if not spare:
    bridge.terminate(); sys.exit("no spare monitor to launch on without disturbing the user")
env = dict(os.environ, MOZ_DISABLE_CONTENT_SANDBOX="1")
proc = _launch_on(spare, [BINARY, "--marionette", "-remote-allow-system-access", "--profile", PROFILE,
                          "--no-remote"], env, PROFILE)
if proc is None:
    bridge.terminate(); sys.exit("browser did not start")
try:
    import socket
    for _ in range(60):
        with socket.socket() as probe:
            if probe.connect_ex(("127.0.0.1", port)) == 0: break
        time.sleep(1)
    time.sleep(2)
    m = Marionette(port)
    m.cmd("Marionette:SetContext", {"value": "content"})
    # Logged out in the EU lands on consent.youtube.com; SOCS=CAI is "reject all".
    m.cmd("WebDriver:Navigate", {"url": "https://music.youtube.com/robots.txt"})
    m.cmd("WebDriver:AddCookie", {"cookie": {"name": "SOCS", "value": "CAI", "domain": ".youtube.com",
                                             "path": "/", "secure": True}})
    m.cmd("WebDriver:Navigate", {"url": f"https://music.youtube.com/watch?v={VIDEO}"})
    time.sleep(6)
    url = m.cmd("WebDriver:GetCurrentURL", {})["value"]
    print("at", url)
    src = open(f"{ROOT}/userscripts/media-ytm.user.js").read().replace("8788", BPORT)
    shim = """
      var unsafeWindow = window.wrappedJSObject;
      function GM_xmlhttpRequest(o) {
        fetch(o.url, {method: o.method, body: o.data, headers: o.headers})
          .then(r => r.text()).then(t => o.onload({responseText: t}), o.onerror);
      }
    """
    m.cmd("WebDriver:ExecuteScript", {"script": shim + src, "args": [], "sandbox": "ytm"})
    s = wait(lambda s: s.get("connected"))
    check("page connects and reports", s.get("connected"), json.dumps(s)[:200])
    check("reports the video", s.get("videoId") == VIDEO, str(s.get("videoId")))
    ytm("play"); s = wait(lambda s: s.get("playing"))
    check("play", s.get("playing"), f"pos={s.get('position')}")
    ytm("pause"); s = wait(lambda s: not s.get("playing"))
    check("pause", not s.get("playing"))
    ytm("toggle"); s = wait(lambda s: s.get("playing"))
    check("toggle", s.get("playing"))
    rc, out = ytm("open", f"https://www.youtube.com/watch?v={VIDEO2}")
    s = wait(lambda s: s.get("videoId") == VIDEO2, 25)
    check("open switches the video (SPA, no reload)", s.get("videoId") == VIDEO2, f"rc={rc} {out} {s.get('videoId')}")
    check("plays after open", wait(lambda s: s.get("playing")).get("playing"))
    ytm("next"); s = wait(lambda s: s.get("videoId") not in (VIDEO2, None), 20)
    check("next", s.get("videoId") not in (VIDEO2, None), str(s.get("videoId")))
    print("final:", ytm("status")[1])
finally:
    try: m.cmd("WebDriver:DeleteSession", {})
    except Exception: pass
    proc.terminate(); bridge.terminate()
    try: proc.wait(10)
    except Exception: proc.kill()
sys.exit(1 if fails else 0)
