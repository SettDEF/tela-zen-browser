#!/usr/bin/env python3
"""Real glass (#38): glass.json switches the chrome see-through live, the
opacity follows the file, pages stay solid, and off restores the opaque window.
Measured on screen, from the sidebar's mean colour in each state. The test window gets
its own class, so the shell's Hyprland rules for Zen do not touch it."""
import http.server, json, os, subprocess, sys, threading, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import regress
from PIL import Image, ImageStat

OUT = "/tmp/claude-1000/glass-test"
FILE = f"{OUT}/glass.json"
RESULTS = []
SIDEBAR = (20, 300, 160, 800)  # tab list, empty below the new-tab row
CONTENT = (400, 300, 800, 800)


def check(name, ok, detail=""):
    RESULTS.append(ok)
    print(("ok    " if ok else "FAIL  ") + f"{name:38} {detail}", flush=True)


def write(enabled, opacity, pages=False):
    tmp = FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"enabled": enabled, "opacity": opacity, "pages": pages}, f)
    os.replace(tmp, FILE)


# A page that paints no background, as the tinct userscript leaves them.
class Bare(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(b'<!doctype html><html style="background:transparent">'
                         b'<body style="background:transparent">glass page</body>')

    def log_message(self, *a):
        pass


srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Bare)
threading.Thread(target=srv.serve_forever, daemon=True).start()
BARE = f"http://127.0.0.1:{srv.server_address[1]}/"
OPEN = ("gBrowser.selectedTab = gBrowser.addTab(%s, {triggeringPrincipal: "
        "Services.scriptSecurityManager.getSystemPrincipal()}); return '1';" % json.dumps(BARE))
TRANSPARENT = ("return JSON.stringify(gBrowser.tabs.filter(t => !t.hasAttribute('zen-empty-tab'))"
               ".map(t => t.linkedBrowser.getAttribute('transparent')));")


os.makedirs(OUT, exist_ok=True)
if os.path.exists(FILE):
    os.remove(FILE)
port = regress.free_port()
proc = regress.launch("/tmp/claude-1000/glass-profile", port,
                      prefs=f'user_pref("zen.glass.file", "{FILE}");\n',
                      extra_args=("--name", "telaglass"))
shots = {}
try:
    m = regress.Marionette(port)
    time.sleep(3)
    pid = m.js("return JSON.stringify(Services.appinfo.processID);")
    c = [c for c in regress._hypr_json("clients") if c.get("pid") == pid][0]
    (x, y), (w, h) = c["at"], c["size"]

    def grab(tag):
        path = f"{OUT}/{tag}.png"
        subprocess.run(["grim", "-g", f"{x},{y} {w}x{h}", path], env=regress._hypr_env())
        shots[tag] = Image.open(path).convert("RGB")

    grab("opaque")
    write(True, 0.5)
    time.sleep(2.5)
    grab("half")
    var = m.js("return JSON.stringify(document.documentElement.style.getPropertyValue('--tela-glass-opacity'));")
    write(True, 0.7)
    time.sleep(2.5)
    grab("seventy")
    write(True, 0.9)
    time.sleep(2.5)
    grab("ninety")
    m.js(OPEN)
    time.sleep(2.5)
    grab("page-solid")
    write(True, 0.9, pages=True)
    time.sleep(2.5)
    grab("page-glass")
    m.js(OPEN)
    time.sleep(2.5)
    attrs_on = m.js(TRANSPARENT)
    grab("page-new")
    write(True, 0.9, pages=False)
    time.sleep(2.5)
    attrs_off = m.js(TRANSPARENT)
    grab("page-off")
    write(False, 0.9)
    time.sleep(2.5)
    grab("off")
finally:
    try:
        proc.terminate(); proc.wait(15)
    except Exception:
        pass


def mean(tag, box):
    return [v for v in ImageStat.Stat(shots[tag].crop(box)).mean]


def dist(a, b):
    return sum((p - q) ** 2 for p, q in zip(a, b)) ** 0.5


# What is behind the window cannot be grabbed (Hyprland re-tiles another
# window into the spot once it closes), so the shots are checked against each
# other: colour is linear in the opacity, so 0.7 sits halfway from 0.5 to 0.9.
T = mean("opaque", SIDEBAR)
s50, s70, s90 = (mean(t, SIDEBAR) for t in ("half", "seventy", "ninety"))
check("file sets the opacity variable", var == "50%", var)
check("on at 0.5: desktop shows through", dist(s50, T) > 15, f"moved {dist(s50, T):.0f} from opaque")
mid = [(a + b) / 2 for a, b in zip(s50, s90)]
check("opacity follows the file live", dist(s50, s90) > 10 and dist(mid, s70) < 3,
      f"0.5={[round(v) for v in s50]} 0.7={[round(v) for v in s70]} 0.9={[round(v) for v in s90]}")
off = dist(mean("off", SIDEBAR), T)
check("off: opaque again", off < 2, f"distance={off:.1f}")
page = max(dist(mean(t, CONTENT), mean("opaque", CONTENT)) for t in ("half", "seventy", "ninety"))
check("page stays solid", page < 2, f"max distance={page:.1f}")
moved = dist(mean("page-glass", CONTENT), mean("page-solid", CONTENT))
check("pages: bare page shows the glass", moved > 15, f"moved {moved:.0f}")
check("pages: open and new tabs follow", attrs_on and all(a == "true" for a in attrs_on), attrs_on)
new = dist(mean("page-new", CONTENT), mean("page-glass", CONTENT))
check("pages: new tab is glass too", new < 3, f"distance={new:.1f}")
back = dist(mean("page-off", CONTENT), mean("page-solid", CONTENT))
check("pages off: every tab solid again", back < 2 and not any(attrs_off), f"distance={back:.1f} {attrs_off}")
srv.shutdown()
print(f"{sum(RESULTS)}/{len(RESULTS)} passed")
sys.exit(0 if all(RESULTS) else 1)
