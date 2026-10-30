#!/usr/bin/env python3
"""theme_popup_shot.py OUT.png JS - one-shot like theme_lab.py, but the picture is the compositor's, so
popups show. JS runs in the chrome window after the Android CSS is injected, e.g.
  "document.getElementById('tabContextMenu').openPopupAtScreen(420,260,true); await new Promise(r=>setTimeout(r,2500)); return '1'"
Out must be an absolute path."""
import json, os, pathlib, shutil, signal, subprocess, sys, time, socket
sys.path.insert(0, "/mnt/storage/dev/projects/tela-zen/scripts")
import regress
ROOT = pathlib.Path("/mnt/storage/dev/projects/tela-zen")
out, js = sys.argv[1], sys.argv[2]
css = subprocess.run([str(ROOT / "node_modules/.bin/sass"), "--no-source-map", "--no-charset", "--load-path", str(ROOT / "src"),
                      str(ROOT / "src/zen/common/styles/zen-theme-android.scss")], capture_output=True, text=True, check=True).stdout
port = regress.free_port(2915)
prof = "/tmp/claude-1000/pl-%d" % port
shutil.rmtree(prof, ignore_errors=True); os.makedirs(prof)
open(prof + "/user.js", "w").write("""user_pref("marionette.port", %d);
user_pref("zen.config.file","/nonexistent/c.toml");
user_pref("browser.tabs.remote.autostart",false);
user_pref("fission.autostart",false);
user_pref("zen.theme.style","android");
user_pref("zen.welcome-screen.seen",true);
user_pref("browser.shell.checkDefaultBrowser",false);
""" % port + os.environ.get("LAB_PREFS", ""))
env = dict(os.environ, MOZ_FORCE_DISABLE_E10S="1", MOZ_CRASHREPORTER_DISABLE="1", MOZ_ENABLE_WAYLAND="1")
loom = subprocess.Popen(["/mnt/storage/dev-cache/targets/release/loom", "--headless", "--size", "1588x948", "--wait", "36000",
    "--snapshot", out, "--", str(ROOT / "engine/obj-x86_64-pc-linux-gnu/dist/bin/zen"), "--marionette", "-remote-allow-system-access",
    "--no-remote", "--profile", prof, "about:robots", "about:rights", "about:license"],
    env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
try:
    for _ in range(60):
        time.sleep(1)
        try: socket.create_connection(("127.0.0.1", port), timeout=2).close(); break
        except OSError: pass
    time.sleep(6)
    m = regress.Marionette(port)
    m.js("const css = %s; const s = document.createElement('style'); s.textContent = css; document.documentElement.appendChild(s); return '1';" % json.dumps(css))
    time.sleep(1)
    print(m.js(js))
    loom.wait(timeout=60)
finally:
    try: os.killpg(loom.pid, signal.SIGTERM)
    except Exception: pass
    shutil.rmtree(prof, ignore_errors=True)
