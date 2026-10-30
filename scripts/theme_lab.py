#!/usr/bin/env python3
"""Theme lab: see the Android theme without touching the user's screen.

A single-process browser runs inside headless loom (this build crashes with --headless and under
Xvfb, but renders there) with Marionette on. Start it once:

    python3 scripts/theme_lab.py &            # prints "ready <port>"

then, for each look at it, write a request - the Android Sass is recompiled and injected over the
loaded sheet, optional chrome JS runs, and the window is saved as a PNG (chrome only; for popups
use theme_popup_shot.py):

    python3 scripts/theme_lab_req.py out.png ["chrome JS returning JSON.stringify(...)"]

LAB_PREFS="user_pref(...);" adds profile prefs (the real profile uses zen.ui.layout-preset=minimal,
zen.tabs.style=compact, zen.view.compact.enable-at-startup=true). Requests are files in /tmp/claude-1000/theme-lab/go; {"quit": true} stops it. Needs loom built at
/mnt/storage/dev-cache/targets/release/loom. Never opens anything on a real monitor.
"""
import json, os, pathlib, subprocess, sys, time, glob, shutil, signal
sys.path.insert(0, "/mnt/storage/dev/projects/tela-zen/scripts")
import regress

GO = pathlib.Path("/tmp/claude-1000/theme-lab/go"); GO.mkdir(parents=True, exist_ok=True)
ROOT = pathlib.Path("/mnt/storage/dev/projects/tela-zen")
BIN = ROOT / "engine/obj-x86_64-pc-linux-gnu/dist/bin/zen"
LOOM = "/mnt/storage/dev-cache/targets/release/loom"
SIZE = os.environ.get("SIZE", "1588x948")


def sass():
    out = subprocess.run([str(ROOT / "node_modules/.bin/sass"), "--no-source-map", "--no-charset", "--load-path",
                          str(ROOT / "src"), str(ROOT / "src/zen/common/styles/zen-theme-android.scss")],
                         capture_output=True, text=True)
    if out.returncode:
        raise RuntimeError(out.stderr)
    return out.stdout


port = regress.free_port(2915)
prof = "/tmp/claude-1000/lab-%d" % port
shutil.rmtree(prof, ignore_errors=True)
os.makedirs(prof)
open(prof + "/user.js", "w").write("""
user_pref("marionette.port", %d);
user_pref("zen.config.file","/nonexistent/c.toml");
user_pref("browser.tabs.remote.autostart",false);
user_pref("fission.autostart",false);
user_pref("zen.theme.style","android");
user_pref("zen.welcome-screen.seen",true);
user_pref("browser.shell.checkDefaultBrowser",false);
user_pref("marionette.enabled", true);
""" % port + os.environ.get("LAB_PREFS", ""))
env = dict(os.environ, MOZ_FORCE_DISABLE_E10S="1", MOZ_CRASHREPORTER_DISABLE="1", MOZ_ENABLE_WAYLAND="1")
loom = subprocess.Popen([LOOM, "--headless", "--size", SIZE, "--wait", "3000000", "--", str(BIN), "--marionette",
                         "-remote-allow-system-access", "--no-remote", "--profile", prof,
                         "about:robots", "about:rights", "about:license", "about:buildconfig"],
                        env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
try:
    for _ in range(90):
        time.sleep(1)
        try:
            import socket; socket.create_connection(("127.0.0.1", port), timeout=2).close(); break
        except OSError:
            continue
    time.sleep(6)
    m = regress.Marionette(port)
    print("ready", port, flush=True)
    inject = """const css = %s; let s = document.getElementById('lab'); if (!s) { s = document.createElement('style'); s.id='lab'; document.documentElement.appendChild(s); } s.textContent = css; return '1';"""
    while True:
        reqs = sorted(GO.glob("*.req"))
        if not reqs:
            time.sleep(0.5); continue
        for r in reqs:
            req = json.loads(r.read_text()); r.unlink()
            try:
                if req.get("quit"):
                    raise SystemExit
                m.js(inject % json.dumps(sass()))
                if req.get("js"):
                    print("js ->", m.js(req["js"]))
                time.sleep(req.get("wait", 1.5))
                m.screenshot(req["out"])
                print("shot", req["out"], flush=True)
            except SystemExit:
                raise
            except Exception as e:
                print("ERR", e, flush=True)
finally:
    try: os.killpg(loom.pid, signal.SIGTERM)
    except Exception: pass
    shutil.rmtree(prof, ignore_errors=True)
