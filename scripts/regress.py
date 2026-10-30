#!/usr/bin/env python3
"""Chrome regression checks, driven over Marionette.

Everything here broke at least once and was found by a human looking at a
screenshot. Run it after touching chrome JS/CSS:

    python3 scripts/regress.py                 # all checks
    python3 scripts/regress.py --only urlbar   # substring match on check name
    python3 scripts/regress.py --keep          # leave the browser running

Exit status is non-zero if any check fails, so it is CI-usable as is.
"""

import argparse
import base64
import json
import os
import pathlib
import shutil
import socket
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
BINARY = pathlib.Path(os.environ.get("REGRESS_BINARY") or ROOT / "engine/obj-x86_64-pc-linux-gnu/dist/bin/zen")


def free_port(start=2915):
    """Two agents running the suite at once must not fight over one port, and
    the low ports belong to interactive sessions."""
    for port in range(start, start + 40):
        with socket.socket() as probe:
            try:
                probe.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError("no free Marionette port in %d..%d" % (start, start + 40))


class Marionette:
    def __init__(self, port):
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=180)
        self.buf = b""
        self.msg_id = 0
        self._recv()
        self.cmd("WebDriver:NewSession", {})
        self.cmd("Marionette:SetContext", {"value": "chrome"})
        # The scriptTimeout parameter on ExecuteAsyncScript is ignored; it has
        # to be set here. The Tor check does three real page loads, and an onion
        # descriptor fetch is the slowest thing in the suite by far.
        self.cmd("WebDriver:SetTimeouts", {"script": 600000})

    def _recv(self):
        while b":" not in self.buf:
            self.buf += self.sock.recv(65536)
        n, _, rest = self.buf.partition(b":")
        n = int(n)
        while len(rest) < n:
            rest += self.sock.recv(65536)
        self.buf = rest[n:]
        return json.loads(rest[:n])

    def cmd(self, name, params):
        self.msg_id += 1
        raw = json.dumps([0, self.msg_id, name, params]).encode()
        self.sock.sendall(str(len(raw)).encode() + b":" + raw)
        reply = self._recv()
        return reply[3] if len(reply) > 3 else reply

    def js(self, body):
        """Run chrome JS; `body` may await and must return a JSON string."""
        wrapper = (
            "const __r = arguments[arguments.length - 1];"
            "(async () => { %s })().then(v => __r(v), e => __r('ERR ' + e));" % body
        )
        out = self.cmd(
            "WebDriver:ExecuteAsyncScript",
            {"script": wrapper, "args": [], "sandbox": "system"},
        )
        value = out.get("value") if isinstance(out, dict) else out
        if isinstance(value, str) and value.startswith("ERR "):
            raise RuntimeError(value)
        return json.loads(value) if isinstance(value, str) else value

    def screenshot(self, path):
        out = self.cmd("WebDriver:TakeScreenshot", {"full": True})
        data = out["value"] if isinstance(out, dict) else out
        pathlib.Path(path).write_bytes(base64.b64decode(data))


_HYPR_SIG = None


def _hypr_env():
    """An environment pointing hyprctl at the Hyprland that is running now. A
    restarted compositor leaves shells holding a dead instance signature, and
    then every query fails - which previously read as "not fullscreen" and "no
    spare monitor", so runs went ahead blind and onto the user's own screen."""
    global _HYPR_SIG
    env = dict(os.environ)
    if _HYPR_SIG:
        env["HYPRLAND_INSTANCE_SIGNATURE"] = _HYPR_SIG
        return env
    base = pathlib.Path(os.environ.get("XDG_RUNTIME_DIR", "/run/user/%d" % os.getuid())) / "hypr"
    live = [d for d in base.glob("*") if (d / ".socket.sock").exists()] if base.exists() else []
    # Nested and headless compositors (loom speaks Hyprland's IPC) leave dead
    # sockets, or live ones with only HEADLESS outputs: take the first that
    # answers with a real monitor, non-loom first.
    for d in sorted(live, key=lambda d: (d.name.startswith("loom"), -d.stat().st_mtime)):
        probe = dict(env, HYPRLAND_INSTANCE_SIGNATURE=d.name)
        try:
            out = subprocess.run(["hyprctl", "-j", "monitors"], capture_output=True, text=True,
                                 env=probe, timeout=2).stdout
            ok = any(not m.get("name", "").startswith("HEADLESS") for m in json.loads(out))
        except (subprocess.TimeoutExpired, ValueError, AttributeError):
            ok = False
        if ok:
            _HYPR_SIG = d.name
            env["HYPRLAND_INSTANCE_SIGNATURE"] = d.name
            break
    return env


def _hypr_json(*args):
    out = subprocess.run(["hyprctl", "-j", *args], capture_output=True, text=True,
                         env=_hypr_env())
    return json.loads(out.stdout) if out.returncode == 0 and out.stdout.strip() else None


def _user_fullscreen():
    """True when the user is fullscreen - or when that cannot be established. The
    user games on this machine; an unreachable compositor is not a green light."""
    active = _hypr_json("activewindow")
    if active is None:
        return True
    return bool(active.get("fullscreen"))


class _PidProc:
    """What launch() returns when Hyprland started the browser: the process is
    not our child, so it is tracked and stopped by pid, like subprocess.Popen."""

    def __init__(self, pid):
        self.pid = pid

    def poll(self):
        try:
            os.kill(self.pid, 0)
            return None
        except OSError:
            return 0

    def terminate(self):
        try:
            os.kill(self.pid, 15)
        except OSError:
            pass

    def kill(self):
        try:
            os.kill(self.pid, 9)
        except OSError:
            pass

    def wait(self, timeout=None):
        end = time.time() + (timeout or 0)
        while self.poll() is None:
            if timeout is not None and time.time() > end:
                raise subprocess.TimeoutExpired("browser", timeout)
            time.sleep(0.2)
        return 0


def _spare_workspace():
    """The workspace on a monitor the user is not focused on, or None. The user
    asked for test browsers there, so nothing opens over what they are doing."""
    mons = _hypr_json("monitors") or []
    spare = [m for m in mons if not m.get("focused") and not m.get("disabled")]
    return (spare[0].get("activeWorkspace") or {}).get("name") if spare else None


def _launch_on(workspace, argv, env, profile):
    """One launch pinned to `workspace` by a rule scoped to that launch - not a
    windowrule, which would outlive the test and catch the user's own windows.
    Silent, so the user's focus and active workspace never move."""
    envs = " ".join("%s=%s" % (k, env[k]) for k in ("MOZ_DISABLE_CONTENT_SANDBOX", "MOZ_LOG", "MOZ_LOG_FILE")
                    if env.get(k))
    cmd = "[workspace %s silent] env %s %s" % (workspace, envs, " ".join(argv))
    subprocess.run(["hyprctl", "dispatch", 'hl.dsp.exec_cmd("%s")' % cmd.replace('"', '\\"')],
                   capture_output=True, env=_hypr_env())
    for _ in range(40):
        time.sleep(0.5)
        for pid in _pids_for(profile):
            return _PidProc(pid)
    return None


def _pids_for(profile):
    """Main browser processes whose command line names this profile."""
    out = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            cl = open("/proc/%s/cmdline" % entry, "rb").read().replace(b"\0", b" ").decode()
        except OSError:
            continue
        if profile in cl and "-contentproc" not in cl and "--marionette" in cl:
            out.append(int(entry))
    return out


def launch(profile, port, prefs="", extra_args=(), seed=None):
    """`prefs` is appended to user.js - the only way to test a *cold* start
    into a layout, since applying the preset afterwards never reproduces what
    the window does while it is opening."""
    shutil.rmtree(profile, ignore_errors=True)
    os.makedirs(profile)
    (pathlib.Path(profile) / "user.js").write_text(
        'user_pref("marionette.port", %d);\n'
        'user_pref("browser.shell.checkDefaultBrowser", false);\n'
        'user_pref("zen.behavior.restoreSession", false);\n'
        # The card-stack check needs real audio to raise a media card, but
        # nobody wants to hear a 220Hz tone every run.
        'user_pref("media.volume_scale", "0.0");\n'
        'user_pref("zen.media.bridge.url", "");\n'
        # Never the user's own dotfile: tests that want one set their own.
        'user_pref("zen.config.file", "/nonexistent/config.toml");\n' % port + prefs
    )
    # Files placed in the profile before first start, e.g. a copy of a real one.
    for name, data in (seed or {}).items():
        (pathlib.Path(profile) / name).write_bytes(data)
    # Not headless, though it opens a window on the user's session: this build
    # crashes with --headless (minidump, "channel error") and under Xvfb, so a
    # real Wayland display is required. The fullscreen guard in main() is what
    # keeps a run from starting mid-game.
    env = dict(os.environ, MOZ_DISABLE_CONTENT_SANDBOX="1")
    argv = [str(BINARY), "--marionette", "-remote-allow-system-access",
            "--profile", profile, "--no-remote", *extra_args]
    spare = _spare_workspace()
    proc = _launch_on(spare, argv, env, profile) if spare else None
    if proc is None:
        # Opening on the user's own screen needs saying so, never a fallback.
        if not os.environ.get("REGRESS_ALLOW_MAIN_SCREEN"):
            raise RuntimeError("no spare monitor to open the test browser on; set "
                               "REGRESS_ALLOW_MAIN_SCREEN=1 to use the focused one")
        proc = subprocess.Popen(argv, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, env=env)
    for _ in range(60):
        time.sleep(1)
        try:
            socket.create_connection(("127.0.0.1", port), timeout=2).close()
            time.sleep(3)
            return proc
        except OSError:
            continue
    proc.kill()
    raise RuntimeError("browser did not open a Marionette port")


# ---- checks -----------------------------------------------------------------
# Each returns (ok, detail). Raising counts as a failure with the exception text.

CHECKS = {}


def check(name):
    def wrap(fn):
        CHECKS[name] = fn
        return fn
    return wrap


SET_LAYOUT = """
Services.prefs.setStringPref("zen.ui.layout-preset", "%s");
await new Promise(r => setTimeout(r, 2200));
"""


@check("urlbar-sidebar-geometry")
def urlbar_sidebar_geometry(m):
    """Field matches its sibling rows and never overhangs the sidebar."""
    r = m.js(SET_LAYOUT % "minimal" + """
      Services.prefs.setStringPref("zen.urlbar.behavior", "sidebar");
      await new Promise(r => setTimeout(r, 1500));
      const w = Services.wm.getMostRecentWindow("navigator:browser");
      const d = w.document;
      const tb = d.getElementById("navigator-toolbox");
      const url = d.getElementById("urlbar");
      const row = d.getElementById("zen-sidebar-top-buttons");
      const snap = () => {
        const t = tb.getBoundingClientRect(), u = url.getBoundingClientRect();
        const w = row.getBoundingClientRect();
        return { tb: Math.round(t.width), url: Math.round(u.width),
                 row: Math.round(w.width),
                 overhang: Math.round(u.right - t.right),
                 dLeft: Math.round(u.left - w.left), dRight: Math.round(w.right - u.right) };
      };
      const out = [snap()];
      for (const step of ["focus", "blur", "focus", "blur"]) {
        w.gURLBar[step]();
        await new Promise(r => setTimeout(r, 1200));
        out.push(snap());
      }
      return JSON.stringify(out);
    """)
    # Samples alternate rest, focus, rest, focus, rest. Focused, the field
    # is an overlay (zen.urlbar.sidebar.overlay): it may reach over the page,
    # but the sidebar keeps its width and the field keeps its left edge.
    rest = r[0]["tb"]
    bad = []
    for i, s in enumerate(r):
        if i % 2:
            if s["tb"] != rest or abs(s["dLeft"]) > 1 or s["url"] < s["row"]:
                bad.append(s)
        elif (s["url"] != s["row"] or s["overhang"] > 0
              or abs(s["dLeft"]) > 1 or abs(s["dRight"]) > 1):
            bad.append(s)
    return not bad, "samples=%s bad=%s" % (len(r), bad or "none")


@check("layout-switch-holds")
def layout_switch_holds(m):
    """Horizontal survives switching; Zen's toolbar manager must not win."""
    r = m.js("""
      const w = Services.wm.getMostRecentWindow("navigator:browser");
      const d = w.document;
      const out = [];
      for (const p of ["comfortable", "horizontal", "compact", "horizontal", "minimal", "horizontal"]) {
        Services.prefs.setStringPref("zen.ui.layout-preset", p);
        await new Promise(r => setTimeout(r, 1800));
        const nav = d.getElementById("nav-bar");
        const u = d.getElementById("urlbar-container").getBoundingClientRect();
        out.push({ set: p, layout: d.documentElement.getAttribute("zen-layout"),
                   navParent: nav.parentElement?.id, urlW: Math.round(u.width) });
      }
      out.push({ reasserts: w.gZenHorizontalTabs?._reclaimCount ?? null });
      return JSON.stringify(out);
    """)
    horiz = [s for s in r if s.get("set") == "horizontal"]
    bad = [s for s in horiz if s["navParent"] != "zen-horizontal-chrome"]
    loops = r[-1].get("reasserts")
    ok = not bad and (loops is None or loops < 10)
    return ok, "horizontal=%d bad=%s reasserts=%s" % (len(horiz), bad or "none", loops)


@check("right-rail-paints")
def right_rail_paints(m, tmp=None):
    """Laid out and hit-testable is not enough - it painted nothing once."""
    geo = m.js(SET_LAYOUT % "horizontal" + """
      const w = Services.wm.getMostRecentWindow("navigator:browser");
      const d = w.document;
      w.CustomizableUI.addWidgetToArea("home-button", "zen-right-rail");
      await new Promise(r => setTimeout(r, 1200));
      const b = d.getElementById("home-button");
      if (!b) { return JSON.stringify({ missing: true }); }
      const r = b.getBoundingClientRect();
      const hit = d.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return JSON.stringify({
        rect: [r.x, r.y, r.width, r.height],
        hit: hit ? (hit.id || hit.className || hit.tagName) : null,
        dpr: w.devicePixelRatio, win: [w.innerWidth, w.innerHeight],
      });
    """)
    if geo.get("missing"):
        return False, "home-button never appeared in the rail"
    tmp = tmp or "/tmp/claude-1000/regress-rail-%d.png" % os.getpid()
    m.screenshot(tmp)
    try:
        from PIL import Image
    except ImportError:
        return None, "hit=%s (pixel probe skipped: no PIL)" % geo["hit"]
    im = Image.open(tmp).convert("RGB")
    scale = im.size[0] / geo["win"][0]
    x, y, wd, ht = geo["rect"]
    box = im.crop((int((x + 4) * scale), int((y + 4) * scale),
                   int((x + wd - 4) * scale), int((y + ht - 4) * scale)))
    colours = len(set(box.getdata()))
    return colours > 1, "hit=%s distinct-colours=%d" % (geo["hit"], colours)


@check("urlbar-centres-and-returns")
def urlbar_centres_and_returns(m):
    """Focus lifts the field to the middle of the window; blur puts it back.

    The return is the half that regressed over and over while a JS FLIP owned
    the geometry, so the resting rect is compared for equality rather than
    tolerance. Two viewport sizes, because the first CSS attempt derived the
    resting point from wherever the toolbar row happened to lay the slot out
    and was 29px wrong as soon as that row overflowed. Sized with
    devPixelsPerPx and not resizeTo: a tiling compositor ignores the latter,
    and the window drifting mid-run read as the field failing to return.
    """
    r = m.js(SET_LAYOUT % "horizontal" + """
      const w = Services.wm.getMostRecentWindow("navigator:browser");
      const d = w.document;
      const u = d.getElementById("urlbar");
      const wrap = d.getElementById("zen-appcontent-wrapper");
      /* Nothing ever clears this, so the sidebar check that ran earlier in
         this session left its own behind. Reset it here and it becomes a
         record of whether the widen ran during *these* cycles. */
      d.getElementById("navigator-toolbox").style.removeProperty("--zen-urlbar-wide");
      const snap = () => {
        const b = u.getBoundingClientRect();
        const chrome = d.getElementById("zen-horizontal-chrome").getBoundingClientRect();
        const pill = u.querySelector(".urlbar-background");
        return { x: +b.x.toFixed(1), y: +b.y.toFixed(1),
                 w: +b.width.toFixed(1), h: +b.height.toFixed(1),
                 cx: +(b.x + b.width / 2).toFixed(1), cy: +(b.y + b.height / 2).toFixed(1),
                 winx: +(w.innerWidth / 2).toFixed(1), winy: +(w.innerHeight / 2).toFixed(1),
                 // #urlbar's own background is transparent; the pill is what
                 // is actually painted, and it must not change colour on the
                 // way home - that half of the old jump regressed too.
                 bg: pill ? w.getComputedStyle(pill).backgroundColor : "no-pill",
                 tb: +d.getElementById("navigator-toolbox").getBoundingClientRect()
                       .width.toFixed(1),
                 /* _anchorWide writes this and nothing ever removes it, so it
                    is a durable record that the sidebar widen ran at all -
                    sharper than the width, which a sub-frame widen escapes. */
                 wide: d.getElementById("navigator-toolbox").style
                        .getPropertyValue("--zen-urlbar-wide") || "",
                 scrim: w.getComputedStyle(wrap, "::after").opacity,
                 inChrome: b.y >= chrome.top - 1 && b.bottom <= chrome.bottom + 1,
                 // No JS may own the field's width here: an inline !important
                 // outranks the sheet and the glide would fight it.
                 pinned: /(^|;)\\s*(width|max-width):/.test(u.getAttribute("style") || "") };
      };
      /* Sample the settled rect, not a moment inside the glide. Firefox grows
         the focused field a beat after focus, and `translate` carries the
         field's own half-size, so a late resize starts a second glide - a
         fixed wait caught one at 86% and read it as 57px of error. */
      const same = (a, b) => a && b && a.x === b.x && a.y === b.y &&
        a.w === b.w && a.h === b.h && a.winx === b.winx && a.winy === b.winy;
      /* Three consecutive matches, not two. The viewport counts as geometry
         here - devPixelsPerPx resizes it over several frames and the
         compositor retiles a beat later, so a single quiet interval was not
         enough and a window still settling read as the field failing to
         return. */
      const settled = async () => {
        const t0 = w.performance.now();
        const seen = [];
        while (w.performance.now() - t0 < 6000) {
          seen.push(snap());
          const n = seen.length;
          if (n >= 3 && same(seen[n - 1], seen[n - 2]) && same(seen[n - 2], seen[n - 3])) {
            return { ...seen[n - 1], settleMs: Math.round(w.performance.now() - t0) };
          }
          await new Promise(r => setTimeout(r, 120));
        }
        return { ...snap(), settleMs: 6000 };
      };
      /* The lift and the scrim are deliberately suppressed while
         zen-startup-settling is up, so a cycle begun inside that window
         measures the suppression, not the glide. Wait it out rather than
         reading intended behaviour as a failure. */
      for (let i = 0; i < 40 && d.documentElement.hasAttribute("zen-startup-settling"); i++) {
        await new Promise(r => setTimeout(r, 100));
      }
      const runs = [];
      const DPPX = "layout.css.devPixelsPerPx";
      try {
        for (const dppx of ["-1.0", "2.6"]) {
          Services.prefs.setCharPref(DPPX, dppx);
          await new Promise(r => setTimeout(r, 3000));
          const cycles = [];
          for (let i = 0; i < 3; i++) {
            /* Baselined per cycle, not per run: this machine tiles its
               windows, so an unrelated window opening re-tiles this one and a
               run-wide baseline then reads as the field failing to return.
               A window that moves *during* a cycle is retried rather than
               failed - that is the compositor, not the field - but only a few
               times, so a viewport that will not hold still is still a fail. */
            let before, on, off, tbs, steady = false;
            for (let attempt = 0; attempt < 3 && !steady; attempt++) {
            before = await settled();
            /* Per frame, not at the endpoints: the sidebar widen this used to
               trigger in horizontal ran and reverted inside the transition, so
               both endpoints matched while the user watched a 460px band open
               down the window. */
            tbs = [];
            const tb = d.getElementById("navigator-toolbox");
            let raf = w.requestAnimationFrame(function tick() {
              tbs.push(+tb.getBoundingClientRect().width.toFixed(1));
              raf = w.requestAnimationFrame(tick);
            });
            w.gURLBar.focus();
            on = await settled();
            w.gURLBar.blur();
            off = await settled();
            w.cancelAnimationFrame(raf);
            steady = on.winx === before.winx && on.winy === before.winy &&
                     off.winx === before.winx && off.winy === before.winy;
            }
            /* Explicit null, not Math.min of nothing: that is Infinity, which
               JSON.stringify writes as null and the reader then subtracts. */
            cycles.push({ before, on, off, steady, frames: tbs.length,
                          tbMin: tbs.length ? Math.min.apply(null, tbs) : null,
                          tbMax: tbs.length ? Math.max.apply(null, tbs) : null });
          }
          runs.push({ dppx, width: cycles[0].before.winx * 2, cycles });
        }
      } finally {
        Services.prefs.clearUserPref(DPPX);
      }
      return JSON.stringify(runs);
    """)
    bad = []
    for run in r:
        tag = "vw=%d" % run["width"]
        for i, c in enumerate(run["cycles"]):
            rest, on, off = c["before"], c["on"], c["off"]
            if not c["steady"]:
                bad.append("%s cycle %d: viewport would not hold still over "
                           "three attempts" % (tag, i))
                continue
            if rest["pinned"]:
                bad.append("%s cycle %d: inline width pin on #urlbar" % (tag, i))
            # Catches --zen-urlbar-rest-y drifting away from the rows it is
            # derived from: at rest the field belongs in the toolbar.
            if not rest["inChrome"]:
                bad.append("%s cycle %d: resting field outside the chrome bar (y=%s h=%s)"
                           % (tag, i, rest["y"], rest["h"]))
            if rest["scrim"] != "0" or off["scrim"] != "0":
                bad.append("%s cycle %d: scrim up at rest" % (tag, i))
            if on["scrim"] == "0":
                bad.append("%s cycle %d: scrim never came up" % (tag, i))
            for axis, got, want in (("x", on["cx"], on["winx"]), ("y", on["cy"], on["winy"])):
                if abs(got - want) > 2:
                    bad.append("%s cycle %d: focused centre %s=%s vs window %s"
                               % (tag, i, axis, got, want))
            drop = lambda d: {k: v for k, v in d.items() if k != "settleMs"}
            if drop(off) != drop(rest):
                bad.append("%s cycle %d: returned to %s, rests at %s"
                           % (tag, i, drop(off), drop(rest)))
            # Width only: Firefox grows the focused field's height itself
            # (measured 38 -> 52), and the -50% terms are the field's own box,
            # so the centring follows it.
            if on["w"] != rest["w"]:
                bad.append("%s cycle %d: width moved %s -> %s" % (tag, i, rest["w"], on["w"]))
            if on["bg"] != rest["bg"]:
                bad.append("%s cycle %d: pill colour %s -> %s" % (tag, i, rest["bg"], on["bg"]))
            # A settle this slow is a fight, not a transition.
            if off["settleMs"] > 2500 or on["settleMs"] > 2500:
                bad.append("%s cycle %d: settle took %s/%sms"
                           % (tag, i, on["settleMs"], off["settleMs"]))
            # The sidebar must not move at all while the field is away.
            # No frames means the per-frame widen check measured nothing, so
            # it is a failure, not something to compute over. rAF does not run
            # at all when the window is on an inactive workspace.
            if c["tbMin"] is None or c["tbMax"] is None:
                bad.append("%s cycle %d: no frames sampled - the per-frame toolbox "
                           "check measured nothing (window not rendering?)" % (tag, i))
                continue
            if c["frames"] < 10:
                bad.append("%s cycle %d: only %d frames sampled" % (tag, i, c["frames"]))
            if abs(c["tbMax"] - c["tbMin"]) > 1 or abs(c["tbMax"] - rest["tb"]) > 1:
                bad.append("%s cycle %d: toolbox width moved %s..%s, rests at %s"
                           % (tag, i, c["tbMin"], c["tbMax"], rest["tb"]))
            if on["wide"] or off["wide"]:
                bad.append("%s cycle %d: _anchorWide ran (--zen-urlbar-wide=%s)"
                           % (tag, i, on["wide"] or off["wide"]))
    slow = max(c[k]["settleMs"] for run in r for c in run["cycles"] for k in ("on", "off"))
    return not bad, "widths=%s slowest-settle=%dms bad=%s" % (
        [int(x["width"]) for x in r], slow, bad[:2] or "none")


@check("urlbar-quiet-on-cold-start")
def urlbar_quiet_on_cold_start(_m):
    """The address bar must not move while the browser is opening.

    Firefox focuses it on the startup blank tab at ~+70ms, which is earlier
    than anything here can connect to watch - so the assertion that sees that
    far back is `--zen-urlbar-wide`: _anchorWide writes it and nothing removes
    it, so an empty one proves the focus never reached the widen. Both layouts,
    because the focus is layout-independent; horizontal is only where the
    result lands over the page and reads as a stray search box.

    Its own browsers, cold-started into each preset: applying the preset after
    launch does not reproduce the condition, which is how this was missed.
    """
    out = []
    for preset in ("horizontal", "comfortable"):
        port = free_port(2870)
        profile = "/tmp/claude-1000/regress-cold-%d" % port
        proc = launch(profile, port,
                      'user_pref("zen.ui.layout-preset", "%s");\n' % preset)
        try:
            m = Marionette(port)
            out.append((preset, m.js("""
              const w = Services.wm.getMostRecentWindow("navigator:browser");
              const d = w.document;
              const tb = d.getElementById("navigator-toolbox");
              const u = d.getElementById("urlbar");
              const snap = () => { const b = u.getBoundingClientRect(); return {
                x: +b.x.toFixed(1), y: +b.y.toFixed(1),
                w: +b.width.toFixed(1), h: +b.height.toFixed(1),
                f: !!w.gURLBar.focused || u.matches(":focus-within"),
                tb: +tb.getBoundingClientRect().width.toFixed(1),
                win: w.innerWidth + "x" + w.innerHeight,
                wide: tb.style.getPropertyValue("--zen-urlbar-wide") || "" }; };
              const seen = [];
              const t0 = w.performance.now();
              const tick = () => { seen.push(snap());
                if (w.performance.now() - t0 < 4000) { w.requestAnimationFrame(tick); } };
              w.requestAnimationFrame(tick);
              await new Promise(r => setTimeout(r, 4400));
              const idle = snap();
              // The suppression must not outlive the startup focus: a
              // deliberate focus straight afterwards still has to move it.
              w.gURLBar.focus();
              await new Promise(r => setTimeout(r, 900));
              const onFocus = snap();
              w.gURLBar.blur();
              // Sidebar mode releases its widen on a 420ms timer plus the
              // transition, so a shorter wait samples mid-return.
              await new Promise(r => setTimeout(r, 1600));
              return JSON.stringify({
                frames: seen.length,
                focused: seen.filter(s => s.f).length,
                seen: seen.map(s => [s.win, s.x, s.w, s.tb]),
                wide: idle.wide, idle, onFocus, afterBlur: snap(),
              });
            """)))
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                proc.kill()
    bad = []
    for preset, r in out:
        if r["focused"]:
            bad.append("%s: focused for %d of %d frames" % (preset, r["focused"], r["frames"]))
        # The compositor sizes a new window over its first frames, and layout
        # follows a frame or two behind: only movement at a size that has
        # held for 3 frames is the chrome's own.
        runs, prev, held = {}, None, 0
        for win, x, w, tb in r["seen"]:
            held = held + 1 if win == prev else 0
            prev = win
            if held >= 3:
                runs.setdefault(win, set()).add((x, w, tb))
        for win, boxes in runs.items():
            if len({(x, w) for x, w, _ in boxes}) > 1:
                bad.append("%s: field moved while opening at %s (%s)" % (preset, win, sorted(boxes)))
            if len({tb for _, _, tb in boxes}) > 1:
                bad.append("%s: sidebar moved while opening at %s" % (preset, win))
        if r["wide"]:
            bad.append("%s: startup focus reached the widen (--zen-urlbar-wide=%s)"
                       % (preset, r["wide"]))
        moved = (r["onFocus"]["x"] != r["idle"]["x"] or r["onFocus"]["w"] != r["idle"]["w"])
        if not moved:
            bad.append("%s: a deliberate focus no longer moves the field" % preset)
        # Geometry only: a deliberate focus in sidebar mode is *supposed* to
        # run the widen, so --zen-urlbar-wide is set by then and rightly so.
        box = lambda d: [d["x"], d["y"], d["w"], d["h"], d["tb"]]
        if box(r["afterBlur"]) != box(r["idle"]):
            bad.append("%s: returned to %s, rests at %s"
                       % (preset, box(r["afterBlur"]), box(r["idle"])))
    return not bad, "presets=%s bad=%s" % ([p for p, _ in out], bad[:2] or "none")


@check("presets-apply-and-order")
def presets_apply_and_order(m):
    """Reordering must move the cycle, not just the cards."""
    r = m.js("""
      const w = Services.wm.getMostRecentWindow("navigator:browser");
      const { ZenLayoutPresetData: D } = ChromeUtils.importESModule(
        "chrome://browser/content/zen-components/ZenLayoutPresetData.mjs");
      const before = D.order.slice();
      const moved = before.slice(1).concat(before[0]);
      D.order = moved;
      await new Promise(r => setTimeout(r, 600));
      const after = D.order.slice();
      const cycle = w.gZenLayoutPresets?.cycle?.slice?.() ?? null;
      D.order = before;
      // cycle is order minus unconfigured slots, so it must be a subsequence
      // of the new order in the same relative sequence - not equal to it.
      const expected = cycle ? moved.filter(id => cycle.includes(id)) : null;
      return JSON.stringify({ before, moved, after, cycle, expected,
                              orderFollowed: JSON.stringify(after) === JSON.stringify(moved),
                              cycleFollowed: cycle ? JSON.stringify(cycle) === JSON.stringify(expected) : null });
    """)
    ok = r["orderFollowed"] and (r["cycleFollowed"] in (True, None))
    return ok, "order=%s cycle=%s" % (r["orderFollowed"], r["cycleFollowed"])


@check("no-chrome-errors")
def no_chrome_errors(m):
    """A top-level throw in a settings module killed every Zen pane once."""
    r = m.js("""
      const msgs = Services.console.getMessageArray() || [];
      const text = x => (x.errorMessage || x.message || "");
      const ours = msgs.filter(x => /zen|Zen/.test(text(x)));
      const isWarning = x => /JavaScript Warning/.test(text(x));
      return JSON.stringify({
        errors: ours.filter(x => x.logLevel >= 2 && !isWarning(x)).map(x => text(x).slice(0, 200)).slice(-6),
        warnings: ours.filter(isWarning).map(x => text(x).slice(0, 120)).slice(-4),
      });
    """)
    return not r["errors"], "errors=%s warnings=%d %s" % (
        r["errors"] or "none", len(r["warnings"]), r["warnings"][:1])


TONE_PAGE = "/tmp/claude-1000/regress-tone-%d.html" % os.getpid()


def _write_tone_page():
    """An autoplaying tone that declares a MediaSession - without one Zen never
    raises a media card at all, which cost two attempts to discover."""
    import math, struct, base64
    sr, secs = 8000, 30
    frames = b"".join(
        struct.pack("<h", int(9000 * math.sin(2 * math.pi * 220 * i / sr)))
        for i in range(sr * secs)
    )
    hdr = (b"RIFF" + struct.pack("<I", 36 + len(frames)) + b"WAVEfmt "
           + struct.pack("<IHHIIHH", 16, 1, 1, sr, sr * 2, 2, 16)
           + b"data" + struct.pack("<I", len(frames)))
    wav = base64.b64encode(hdr + frames).decode()
    pathlib.Path(TONE_PAGE).write_text(
        '<!doctype html><title>Tone</title><body><audio id=a autoplay loop '
        'src="data:audio/wav;base64,%s"></audio><script>'
        'document.getElementById("a").play().then(() => {'
        '  navigator.mediaSession.metadata = new MediaMetadata('
        '    {title:"Regress Tone", artist:"tela-zen"});'
        '  navigator.mediaSession.playbackState = "playing";'
        '});</script>' % wav
    )


@check("card-stack-and-peek")
def card_stack_and_peek(m):
    """Media and Activity cards must share one stack, one peeking behind."""
    _write_tone_page()
    r = m.js("""
      Services.prefs.setIntPref("media.autoplay.default", 0);
      Services.prefs.setIntPref("media.autoplay.blocking_policy", 0);
      const w = Services.wm.getMostRecentWindow("navigator:browser");
      const d = w.document;
      const tab = w.gBrowser.addTab("file://%s", {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      w.gBrowser.selectedTab = tab;
      await new Promise(r => setTimeout(r, 8000));
      // A media card hides while its own tab is selected, by upstream design.
      w.gBrowser.selectedTab = w.gBrowser.tabs[0];
      await new Promise(r => setTimeout(r, 1500));
      w.gZenPageCards?.setWindowCard?.({ id: "regress-activity", title: "Activity",
        subtitle: "1 running", accent: "#7aa2f7", rows: [{ label: "Probe", detail: "Active" }] });
      await new Promise(r => setTimeout(r, 2000));
      const S = w.gZenCardStack;
      if (!S) { return JSON.stringify({ skip: "no gZenCardStack" }); }
      const cards = (S.cards() || []).map(c => ({
        cls: (c.className || "").toString().slice(0, 40),
        behind: c.hasAttribute("stacked-behind"),
        h: Math.round(c.getBoundingClientRect().height),
      }));
      return JSON.stringify({ audible: tab.hasAttribute("soundplaying"), cards });
    """ % TONE_PAGE)
    if isinstance(r, dict) and r.get("skip"):
        return None, r["skip"]
    cards = r["cards"]
    media = [c for c in cards if "media" in c["cls"]]
    behind = [c for c in cards if c["behind"]]
    ok = r["audible"] and len(cards) >= 2 and media and behind
    return ok, "audible=%s cards=%d media=%d behind=%d" % (
        r["audible"], len(cards), len(media), len(behind))


@check("external-player-hands-off")
def external_player_hands_off(m):
    """"Open in another app" must reach the media helper with the video's own
    address. A stub command stands in for the player, so no window opens."""
    out = "/tmp/claude-1000/regress-external-%d.txt" % os.getpid()
    helper = os.path.expanduser("~/.scripts/media")
    if not os.access(helper, os.X_OK):
        return None, "no ~/.scripts/media"
    r = m.js("""
      const w = Services.wm.getMostRecentWindow("navigator:browser");
      Services.prefs.setStringPref("zen.media.external.player", "custom");
      Services.prefs.setStringPref("zen.media.external.helper", "%s");
      Services.prefs.setStringPref("zen.media.external.command", "printf '%%s\\n' {url} {referer} > %s");
      const page = "data:text/html,<video src='https://download.samplelib.com/mp4/sample-5s.mp4' muted autoplay></video>";
      const tab = w.gBrowser.addTab(page, {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      w.gBrowser.selectedTab = tab;
      await new Promise(r => setTimeout(r, 5000));
      const { TelaExternalPlayer } = ChromeUtils.importESModule("resource:///modules/zen/TelaMediaBridge.sys.mjs");
      const opened = await TelaExternalPlayer.open(tab.linkedBrowser);
      await new Promise(r => setTimeout(r, 1500));
      // the frame helper: a playing video's own time, from the page that plays it
      const vtab = w.gBrowser.addTab("https://download.samplelib.com/mp4/sample-5s.mp4", {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      w.gBrowser.selectedTab = vtab;
      await new Promise(r => setTimeout(r, 4000));
      const live = await TelaExternalPlayer.playingFrame(vtab.linkedBrowser);
      let dbg = "";
      try { dbg = JSON.stringify(await vtab.linkedBrowser.browsingContext.currentWindowGlobal.getActor("TelaMediaSource").sendQuery("Query")); } catch (e) { dbg = String(e); }
      const d = w.document;
      return JSON.stringify({ dbg, live, opened,
        menu: !!d.getElementById("context-video-open-external") && !!d.getElementById("context-pip-toggle-open-external"),
        template: !!d.getElementById("zen-media-card-template")?.content.querySelector(".zen-media-external-button") });
    """ % (helper, out))
    got = pathlib.Path(out).read_text().split("\n") if os.path.exists(out) else []
    live = r.get("live") or {}
    ok = (r["opened"] and r["menu"] and r["template"] and got[:1] == ["https://download.samplelib.com/mp4/sample-5s.mp4"]
          and live.get("time", 0) > 0.5)
    return ok, "opened=%s menu=%s button=%s live-time=%s helper got=%s dbg=%s" % (
        r["opened"], r["menu"], r["template"], live.get("time"), got[:1], r.get("dbg"))


@check("tor-routes-and-does-not-leak")
def tor_routes_and_does_not_leak(m):
    """The third assertion is the leak check and must never silently pass."""
    import socket as _s
    try:
        _s.create_connection(("127.0.0.1", 9050), timeout=2).close()
    except OSError:
        return None, "no tor on 127.0.0.1:9050"
    r = m.js("""
      const w = Services.wm.getMostRecentWindow("navigator:browser");
      const { ZenTorProxy } = ChromeUtils.importESModule(
        "resource:///modules/zen/tor/ZenTorProxy.sys.mjs");
      const { ContextualIdentityService } = ChromeUtils.importESModule(
        "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs");
      Services.prefs.setBoolPref("zen.tor.enabled", true);
      let ident = ContextualIdentityService.getPublicIdentities().find(i => i.name === "regress-tor");
      if (!ident) { ident = ContextualIdentityService.create("regress-tor", "circle", "purple"); }
      ZenTorProxy.addWindowContext(ident.userContextId);
      const load = async (url, ctx) => {
        const opts = { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() };
        if (ctx) { opts.userContextId = ctx; }
        const tab = w.gBrowser.addTab(url, opts);
        const b = tab.linkedBrowser;
        const stopped = new Promise(res => {
          const l = { onStateChange(_p, _q, f) {
            if ((f & Ci.nsIWebProgressListener.STATE_STOP) &&
                (f & Ci.nsIWebProgressListener.STATE_IS_NETWORK)) { b.removeProgressListener(l); res(); }
          }, QueryInterface: ChromeUtils.generateQI(["nsIWebProgressListener","nsISupportsWeakReference"]) };
          b.addProgressListener(l, Ci.nsIWebProgress.NOTIFY_STATE_ALL);
        });
        await Promise.race([stopped, new Promise(res => setTimeout(res, 90000))]);
        await new Promise(res => setTimeout(res, 1200));
        const out = { title: b.contentTitle, doc: b.documentURI?.spec || "" };
        w.gBrowser.removeTab(tab);
        return out;
      };
      const ONION = "http://2gzyxa5ihm7nsggfxnu52rck2vv4rvmdlkiu3zzui5du4xyclen53wid.onion/";
      // A descriptor fetch fails often enough to have failed a whole suite
      // run for network reasons; the leak probe below gets no retry, since
      // "it did not load" is exactly what it asserts.
      let onionRouted = await load(ONION, ident.userContextId);
      if ((onionRouted.doc || "").includes("neterror")) {
        onionRouted = await load(ONION, ident.userContextId);
      }
      const res = {
        clearnet: await load("https://check.torproject.org/", ident.userContextId),
        onionRouted,
        onionDirect: await load(ONION, 0),
      };
      ZenTorProxy.removeWindowContext(ident.userContextId);
      try { ContextualIdentityService.remove(ident.userContextId); } catch (e) {}
      return JSON.stringify(res);
    """)
    routed = "Congratulations" in (r["clearnet"]["title"] or "")
    onion_ok = "neterror" not in r["onionRouted"]["doc"]
    leaked = "neterror" not in r["onionDirect"]["doc"]
    return (routed and onion_ok and not leaked), (
        "routed=%s onion=%s leaked=%s" % (routed, onion_ok, leaked))


@check("agent-control-refuses")
def agent_control_refuses(m):
    """The agent channel's permission model, asserted without a socket.

    The verbs, the guarded-host rule and the kill switch are all decidable in
    chrome context, so they belong here; only the transport needs a real
    client. The lookalike case is the one that matters most - a substring
    test would let github.com.attacker.net through as github.com.
    """
    r = m.js("""
      const w = Services.wm.getMostRecentWindow("navigator:browser");
      const { ZenAgentPolicy } = ChromeUtils.importESModule(
        "resource:///modules/zen/agent/ZenAgentPolicy.sys.mjs");
      const { ZenAgentChannel } = ChromeUtils.importESModule(
        "resource:///modules/zen/agent/ZenAgentChannel.sys.mjs");
      const { ZenAgentLog } = ChromeUtils.importESModule(
        "resource:///modules/zen/agent/ZenAgentLog.sys.mjs");

      const bad = [];
      const want = (label, got, expected) => {
        if (got !== expected) bad.push(label + "=" + got);
      };

      // Off by default: nothing listens and every verb refuses.
      want("default-enabled", Services.prefs.getBoolPref("zen.agent.enabled", false), false);
      want("listening-when-off", ZenAgentChannel.listening, false);
      want("verb-when-off",
        ZenAgentPolicy.checkVerb("navigate", {authenticated: true}).reason,
        "agent-disabled");

      Services.prefs.setBoolPref("zen.agent.enabled", true);
      try {
        want("unknown-verb",
          ZenAgentPolicy.checkVerb("evaluate", {authenticated: true}).reason,
          "unknown-verb");
        want("unauthenticated",
          ZenAgentPolicy.checkVerb("navigate", {authenticated: false}).reason,
          "not-authenticated");
        want("read-only",
          ZenAgentPolicy.checkVerb("navigate", {authenticated: true, readOnly: true}).reason,
          "read-only-session");

        // Guarded hosts: exact, subdomain, and the lookalike that must NOT match.
        want("guarded-exact", ZenAgentPolicy.isGuardedHost("github.com"), true);
        want("guarded-subdomain", ZenAgentPolicy.isGuardedHost("api.github.com"), true);
        want("guarded-uppercase", ZenAgentPolicy.isGuardedHost("GitHub.COM"), true);
        want("lookalike-suffix", ZenAgentPolicy.isGuardedHost("github.com.attacker.net"), false);
        want("lookalike-prefix", ZenAgentPolicy.isGuardedHost("evil-github.com"), false);
        want("unguarded", ZenAgentPolicy.isGuardedHost("example.com"), false);

        want("guarded-url", ZenAgentPolicy.checkUrl("https://accounts.google.com/x").reason,
          "origin-guarded");
        want("privileged-scheme", ZenAgentPolicy.checkUrl("about:config").reason,
          "scheme-refused");
        want("file-scheme", ZenAgentPolicy.checkUrl("file:///etc/passwd").reason,
          "scheme-refused");
        want("chrome-scheme", ZenAgentPolicy.checkUrl("chrome://browser/content/browser.xhtml").reason,
          "scheme-refused");
        want("plain-https", ZenAgentPolicy.checkUrl("https://example.com/").ok, true);
        // A tab resting on an internal page is still navigable away from.
        want("current-internal-ok",
          ZenAgentPolicy.checkCurrent("chrome://browser/content/zen-newtab.html").ok, true);

        // Revoking invalidates a generation captured before it.
        const gen = ZenAgentPolicy.generation;
        want("gen-current-before", ZenAgentPolicy.isCurrent(gen), true);
        ZenAgentPolicy.revoke();
        want("gen-stale-after", ZenAgentPolicy.isCurrent(gen), false);

        // The socket appears on start and is gone after revoke.
        const started = await ZenAgentChannel.start("silent");
        want("start-ok", started.ok, true);
        want("listening-after-start", ZenAgentChannel.listening, true);
        const sock = started.socket;
        want("socket-exists", await IOUtils.exists(sock), true);
        await ZenAgentChannel.revoke("regress");
        want("listening-after-revoke", ZenAgentChannel.listening, false);
        want("socket-gone", await IOUtils.exists(sock), false);

        // Refusals are logged, not just returned.
        await ZenAgentLog.init();
        const refusals = ZenAgentLog.entries.filter(e => e.outcome === "refused").length;
        return JSON.stringify({bad, logged: ZenAgentLog.entries.length, refusals});
      } finally {
        Services.prefs.setBoolPref("zen.agent.enabled", false);
      }
    """)
    return not r["bad"], "bad=%s log=%d" % (r["bad"] or "none", r["logged"])


@check("agent-identity-derives")
def agent_identity_derives(m):
    """One colour per assistant, derived from its name and not requestable.

    Fixed lightness and chroma are the point: only the hue varies, so no name
    can hash to something illegible against either theme. The container colour
    is snapped to the nearest of Firefox's eight so the stripe on the tab does
    not contradict the badge beside it.
    """
    r = m.js("""
      const { ZenAgentIdentity } = ChromeUtils.importESModule(
        "resource:///modules/zen/agent/ZenAgentIdentity.sys.mjs");
      const bad = [];
      const want = (label, got, expected) => {
        if (got !== expected) bad.push(label + "=" + got);
      };

      // Deterministic, and the same name is the same identity.
      want("stable", ZenAgentIdentity.accentFor("claude-code"),
        ZenAgentIdentity.accentFor("claude-code"));
      want("case-insensitive", ZenAgentIdentity.accentFor("Claude-Code"),
        ZenAgentIdentity.accentFor("claude-code"));
      if (ZenAgentIdentity.accentFor("a") === ZenAgentIdentity.accentFor("b")) {
        bad.push("distinct-names-collide");
      }

      // Only the hue moves.
      const hues = new Set();
      for (const name of ["a", "b", "c", "claude-code", "codex", "zed", "x"]) {
        const accent = ZenAgentIdentity.accentFor(name);
        const parts = /^oklch\\(([0-9.]+) ([0-9.]+) ([0-9]+)\\)$/.exec(accent);
        if (!parts) { bad.push("shape:" + accent); continue; }
        if (parts[1] !== "0.52" || parts[2] !== "0.13") {
          bad.push("L/C moved:" + accent);
        }
        hues.add(parts[3]);
      }
      if (hues.size < 5) bad.push("hues-clustered:" + hues.size);

      // No claimed identity, no identity colour.
      want("anonymous", ZenAgentIdentity.accentFor(""), "oklch(0.52 0.02 0)");
      want("anonymous-container", ZenAgentIdentity.containerColourFor(""),
        "toolbar");

      // Names are bounded and stripped before they can ever be displayed.
      want("bounded", ZenAgentIdentity.clean("y".repeat(200)).length, 40);
      want("stripped", ZenAgentIdentity.clean("a\\u0000b\\u001fc"), "abc");
      want("not-a-string", ZenAgentIdentity.clean(null), "");

      // Container colour is one of the eight the platform accepts.
      const allowed = new Set(["red", "orange", "yellow", "green",
                               "turquoise", "blue", "purple", "pink"]);
      for (const name of ["claude-code", "codex", "zed", "a", "b"]) {
        const colour = ZenAgentIdentity.containerColourFor(name);
        if (!allowed.has(colour)) bad.push("colour:" + colour);
      }

      // describe() takes a name and nothing else - there is no colour input.
      const described = ZenAgentIdentity.describe("claude-code");
      want("describe-keys", Object.keys(described).sort().join(","),
        "accent,containerColour,name");
      want("describe-derives", described.accent,
        ZenAgentIdentity.accentFor("claude-code"));

      return JSON.stringify({bad});
    """)
    return not r["bad"], "bad=%s" % (r["bad"] or "none")


@check("settings-panes-load")
def settings_panes_load(m):
    """A top-level bad import in zen-settings.js took every gZen* pane object
    with it, so all Zen preference panes were silently dead."""
    r = m.js("""
      const w = Services.wm.getMostRecentWindow("navigator:browser");
      const tab = w.gBrowser.addTab("about:preferences", {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      w.gBrowser.selectedTab = tab;
      await new Promise(r => setTimeout(r, 6000));
      const win = tab.linkedBrowser.contentWindow;
      const doc = win.document;
      const panes = [...doc.querySelectorAll("groupbox[data-category], .pane-container > *[data-category]")]
        .map(e => e.getAttribute("data-category"));
      const objects = Object.keys(win).filter(k => /^gZen/.test(k));
      const navs = [...doc.querySelectorAll("#categories richlistitem")].map(e => e.id);
      w.gBrowser.removeTab(tab);
      return JSON.stringify({ zenObjects: objects.sort(), zenNavs: navs.filter(i => /[Zz]en/.test(i)) });
    """)
    ok = len(r["zenObjects"]) >= 3
    return ok, "gZen* objects=%d %s | zen nav entries=%d" % (
        len(r["zenObjects"]), r["zenObjects"][:4], len(r["zenNavs"]))


@check("sidebar-results-render")
def sidebar_results_render(m):
    """The rows the sidebar draws, and the settings that shape them. A pref
    the renderer ignores, or a control with no string, both read as 'fine'
    from a screenshot of an empty list."""
    r = m.js(SET_LAYOUT % "minimal" + """
      Services.prefs.setStringPref("zen.urlbar.behavior", "sidebar");
      const w = Services.wm.getMostRecentWindow("navigator:browser");
      const d = w.document;
      const { PlacesUtils } = ChromeUtils.importESModule(
        "resource://gre/modules/PlacesUtils.sys.mjs");
      for (const u of ["https://example.org/alpha", "https://example.org/beta",
                       "https://example.org/gamma", "https://example.net/one"]) {
        await PlacesUtils.history.insert({ url: u, title: "Example " + u.slice(-5),
          visits: [{ date: new Date(), transition: PlacesUtils.history.TRANSITION_TYPED }] });
      }
      /* A bookmark and an open tab, so the kinds that carry a tag are
         actually in the list - history alone never produces one. */
      await PlacesUtils.bookmarks.insert({ parentGuid: PlacesUtils.bookmarks.unfiledGuid,
        url: "https://elsewhere.test/kept-page", title: "Kept bookmark" });
      const probe = PathUtils.join(PathUtils.tempDir, "zen-regress-kept.html");
      await IOUtils.writeUTF8(probe, "<title>Kept probe page</title>");
      const spare = w.gBrowser.addTab(PathUtils.toFileURI(probe), {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      await new Promise(r => setTimeout(r, 2500));

      const list = () => d.getElementById("zen-sidebar-results");
      const type = async (text) => {
        w.gURLBar.focus();
        await new Promise(r => setTimeout(r, 400));
        w.gURLBar.search(text);
        await new Promise(r => setTimeout(r, 2500));
      };
      const shape = () => {
        const el = list();
        if (!el) { return { missing: true }; }
        return {
          open: el.hasAttribute("open"),
          density: el.getAttribute("zen-density"),
          rows: [...el.querySelectorAll(".zen-sidebar-result")].map(row => ({
            kind: row.getAttribute("zen-result-kind"),
            title: row.querySelector(".zen-sidebar-result-title")?.getAttribute("value") || "",
            url: row.querySelector(".zen-sidebar-result-url")?.getAttribute("value") || null,
            tag: row.querySelector(".zen-sidebar-result-tag")?.textContent || null,
          })),
          chips: el.querySelectorAll(".zen-sidebar-result-chip").length,
        };
      };
      const out = {};
      await type("kept");
      out.kinds = shape();
      w.gBrowser.removeTab(spare);
      await new Promise(r => setTimeout(r, 500));

      w.gURLBar.blur();
      await new Promise(r => setTimeout(r, 400));
      await type("example.org");
      out.grouped = shape();

      Services.prefs.setIntPref("zen.urlbar.sidebar.max-paths", 1);
      w.gURLBar.blur();
      await new Promise(r => setTimeout(r, 400));
      await type("example.org");
      out.onePath = shape();

      Services.prefs.setBoolPref("zen.urlbar.sidebar.show-paths", false);
      Services.prefs.setBoolPref("zen.urlbar.sidebar.show-source", false);
      w.gURLBar.blur();
      await new Promise(r => setTimeout(r, 400));
      await type("kept");
      out.noPathsNoTags = shape();
      for (const p of ["show-paths", "show-source", "max-paths"]) {
        Services.prefs.clearUserPref("zen.urlbar.sidebar." + p);
      }

      Services.prefs.setBoolPref("zen.urlbar.sidebar.show-url", false);
      Services.prefs.setBoolPref("zen.urlbar.sidebar.group-by-site", false);
      Services.prefs.setStringPref("zen.urlbar.sidebar.density", "compact");
      Services.prefs.setIntPref("zen.urlbar.sidebar.max-rows", 2);
      w.gURLBar.blur();
      await new Promise(r => setTimeout(r, 400));
      await type("example.org");
      out.flat = shape();

      for (const p of ["show-url", "group-by-site"]) {
        Services.prefs.clearUserPref("zen.urlbar.sidebar." + p);
      }
      Services.prefs.clearUserPref("zen.urlbar.sidebar.density");
      Services.prefs.clearUserPref("zen.urlbar.sidebar.max-rows");
      w.gURLBar.blur();

      const tab = w.gBrowser.addTab("about:preferences#zenLooks", {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      w.gBrowser.selectedTab = tab;
      await new Promise(r => setTimeout(r, 7000));
      const pdoc = tab.linkedBrowser.contentWindow.document;
      out.settings = ["zenUrlbarSidebarMaxRows", "zenUrlbarSidebarGroup",
                      "zenUrlbarSidebarPaths", "zenUrlbarSidebarMaxPaths",
                      "zenUrlbarSidebarUrl", "zenUrlbarSidebarSource"]
        .map(id => {
          const el = pdoc.getElementById(id);
          if (!el) { return { id, missing: true }; }
          return { id, label: el.label || el.value || "",
                   bound: el.hasAttribute("preference") || el.value !== "" };
        });
      out.header = pdoc.querySelector("[data-l10n-id='zen-urlbar-sidebar-header']")?.textContent || "";

      /* The path controls do nothing while results are not grouped. A control
         that accepts a change and discards it is the failure being checked. */
      const dep = () => ["zenUrlbarSidebarPaths", "zenUrlbarSidebarMaxPaths"]
        .map(id => !!pdoc.getElementById(id)?.hasAttribute("disabled"));
      Services.prefs.setBoolPref("zen.urlbar.sidebar.group-by-site", true);
      Services.prefs.setBoolPref("zen.urlbar.sidebar.show-paths", true);
      await new Promise(r => setTimeout(r, 600));
      out.depWhenGrouped = dep();
      Services.prefs.setBoolPref("zen.urlbar.sidebar.group-by-site", false);
      await new Promise(r => setTimeout(r, 600));
      out.depWhenUngrouped = dep();
      Services.prefs.setBoolPref("zen.urlbar.sidebar.group-by-site", true);
      Services.prefs.setBoolPref("zen.urlbar.sidebar.show-paths", false);
      await new Promise(r => setTimeout(r, 600));
      out.depWhenPathsOff = dep();
      for (const p of ["group-by-site", "show-paths"]) {
        Services.prefs.clearUserPref("zen.urlbar.sidebar." + p);
      }
      w.gBrowser.removeTab(tab);
      return JSON.stringify(out);
    """)
    g, f, k = r["grouped"], r["flat"], r["kinds"]
    bad = []
    tagged = {row["kind"]: row["tag"] for row in k["rows"] if row["tag"]}
    for kind in ("tab", "bookmark"):
        if not tagged.get(kind):
            bad.append("%s row carries no tag" % kind)
    if not any(row["kind"] == "search" for row in k["rows"]):
        bad.append("no row identified as a search")
    if not g.get("open") or not g["rows"]:
        bad.append("grouped list empty")
    if not any(row["url"] for row in g["rows"]):
        bad.append("no address line")
    if not g["chips"]:
        bad.append("grouping produced no path chips")
    if f.get("density") != "compact":
        bad.append("density pref ignored")
    if any(row["url"] for row in f["rows"]):
        bad.append("show-url=false still drew addresses")
    if f["chips"]:
        bad.append("group-by-site=false still chipped")
    if len(f["rows"]) > 2:
        bad.append("max-rows=2 gave %d" % len(f["rows"]))
    if r["onePath"]["chips"] > 1:
        bad.append("max-paths=1 gave %d chips" % r["onePath"]["chips"])
    if r["noPathsNoTags"]["chips"]:
        bad.append("show-paths=false still chipped")
    if any(row["tag"] for row in r["noPathsNoTags"]["rows"]):
        bad.append("show-source=false still tagged")
    if r["depWhenGrouped"] != [False, False]:
        bad.append("path controls disabled while grouping is on: %s" % r["depWhenGrouped"])
    if r["depWhenUngrouped"] != [True, True]:
        bad.append("path controls still live with grouping off: %s" % r["depWhenUngrouped"])
    if r["depWhenPathsOff"] != [False, True]:
        bad.append("max-paths not disabled with paths off: %s" % r["depWhenPathsOff"])
    missing = [s["id"] for s in r["settings"] if s.get("missing")]
    blank = [s["id"] for s in r["settings"] if not s.get("missing") and not s["label"] and not s["bound"]]
    if missing:
        bad.append("settings missing: %s" % missing)
    if blank:
        bad.append("settings unlabelled: %s" % blank)
    if not r["header"].strip():
        bad.append("section header has no string")
    return not bad, "rows=%d chips=%d flat=%d tags=%s bad=%s" % (
        len(g["rows"]), g["chips"], len(f["rows"]),
        sorted(tagged) or "none", bad or "none")


@check("compact-holds-across-popups")
def compact_holds_across_popups(m):
    """A popup closing and the next opening is two mutations. Releasing on the
    first slid the sidebar out from under the popup about to open - which is
    what made an extension's second prompt lose the sidebar."""
    r = m.js("""
      Services.prefs.setBoolPref("zen.view.compact.hide-tabbar", true);
      Services.prefs.setBoolPref("zen.view.compact.hide-toolbar", false);
      Services.prefs.setBoolPref("zen.view.compact.enabled", true);
      await new Promise(r => setTimeout(r, 1200));
      const w = Services.wm.getMostRecentWindow("navigator:browser");
      const d = w.document;
      const tb = d.getElementById("navigator-toolbox");
      const M = w.gZenCompactModeManager;
      const probe = PathUtils.join(PathUtils.tempDir, "zen-regress-compact.html");
      await IOUtils.writeUTF8(probe, "<title>compact probe</title>");
      const t = w.gBrowser.addTab(PathUtils.toFileURI(probe), {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      w.gBrowser.selectedTab = t;
      await new Promise(r => setTimeout(r, 2500));
      if (!M.preference) { M.toggle(true); await new Promise(r => setTimeout(r, 1500)); }
      const SEL = ":where([panelopen],[open],[breakout-extend])" +
        ":not(#urlbar[zen-floating-urlbar='true']):not(tab):not(.zen-compact-mode-ignore)";
      const x = () => +tb.getBoundingClientRect().x.toFixed(1);
      /* A stray [open] in the urlbar holds the sidebar out and would make
         every later reading meaningless, so the baseline is established, not
         assumed. */
      let hidden = false;
      for (let i = 0; i < 25; i++) {
        for (const el of tb.querySelectorAll(SEL)) { el.removeAttribute("open"); }
        M._setElementExpandAttribute(tb, false);
        await new Promise(r => setTimeout(r, 400));
        if (x() < -100) { hidden = true; break; }
      }
      const out = { baselineHidden: hidden, hiddenX: x() };
      if (!hidden) { return JSON.stringify(out); }
      w.PanelUI.show();
      await new Promise(r => setTimeout(r, 1600));
      out.openX = x();
      w.PanelUI.hide();
      await new Promise(r => setTimeout(r, 120));
      out.gapX = x();
      out.gapMatches = tb.querySelectorAll(SEL).length;
      w.PanelUI.show();
      await new Promise(r => setTimeout(r, 900));
      out.reopenX = x();
      w.PanelUI.hide();
      await new Promise(r => setTimeout(r, 1800));
      out.releasedX = x();
      out.releasedHover = tb.hasAttribute("zen-has-hover");
      return JSON.stringify(out);
    """)
    if not r.get("baselineHidden"):
        return False, "could not get a hidden sidebar to test against (x=%s)" % r.get("hiddenX")
    bad = []
    if r["openX"] > -100 and r["hiddenX"] > -100:
        bad.append("sidebar never moved")
    if r["gapX"] < -100:
        bad.append("slid out during the popup gap (x=%s)" % r["gapX"])
    if r["reopenX"] < -100:
        bad.append("did not come back for the second popup")
    if r["releasedX"] > -100:
        # A pointer resting over the test window pins the sidebar open, and a
        # red from that is the harness lying, not a regression.
        if r.get("releasedHover"):
            return False, ("VOID: pointer was over the sidebar at the release "
                           "sample (zen-has-hover set); move it off and re-run")
        bad.append("stayed out after every popup closed (x=%s)" % r["releasedX"])
    return not bad, "hidden=%s open=%s gap=%s(matches=%s) reopen=%s released=%s bad=%s" % (
        r["hiddenX"], r["openX"], r["gapX"], r.get("gapMatches"),
        r["reopenX"], r["releasedX"], bad or "none")


@check("compact-survives-own-popup-focus")
def compact_survives_own_popup_focus(m):
    """On Linux a doorhanger is its own surface, so an extension's permission
    prompt taking focus fires `deactivate` on the window - and collapsing then
    pulled the sidebar out from under the prompt anchored to it."""
    r = m.js("""
      Services.prefs.setBoolPref("zen.view.compact.hide-tabbar", true);
      Services.prefs.setBoolPref("zen.view.compact.hide-toolbar", false);
      Services.prefs.setBoolPref("zen.view.compact.enabled", true);
      Services.prefs.setBoolPref("zen.view.compact.show-sidebar-and-toolbar-on-hover", true);
      await new Promise(r => setTimeout(r, 1200));
      const w = Services.wm.getMostRecentWindow("navigator:browser");
      const d = w.document;
      const tb = d.getElementById("navigator-toolbox");
      const M = w.gZenCompactModeManager;
      const probe = PathUtils.join(PathUtils.tempDir, "zen-regress-deact.html");
      await IOUtils.writeUTF8(probe, "<title>deactivate probe</title>");
      const t = w.gBrowser.addTab(PathUtils.toFileURI(probe), {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      w.gBrowser.selectedTab = t;
      await new Promise(r => setTimeout(r, 2500));
      if (!M.preference) { M.toggle(true); await new Promise(r => setTimeout(r, 1500)); }
      const SEL = ":where([panelopen],[open],[breakout-extend])" +
        ":not(#urlbar[zen-floating-urlbar='true']):not(tab):not(.zen-compact-mode-ignore)";
      const x = () => +tb.getBoundingClientRect().x.toFixed(1);
      let hidden = false;
      for (let i = 0; i < 25; i++) {
        for (const el of tb.querySelectorAll(SEL)) { el.removeAttribute("open"); }
        M._setElementExpandAttribute(tb, false);
        await new Promise(r => setTimeout(r, 400));
        if (x() < -100) { hidden = true; break; }
      }
      const out = { baselineHidden: hidden };
      if (!hidden) { return JSON.stringify(out); }
      const hold = async () => {
        M._setElementExpandAttribute(tb, true);
        M._outsideTrackedElement = tb;
        await new Promise(r => setTimeout(r, 900));
      };
      await hold();
      out.heldByHover = tb.hasAttribute("zen-has-hover");
      out.heldX = x();
      w.PopupNotifications.show(w.gBrowser.selectedBrowser, "zen-perm-probe",
        "Extension requests additional settings", "unified-extensions-button",
        { label: "Allow", accessKey: "A", callback: () => {} },
        [{ label: "Deny", accessKey: "D", callback: () => {} }],
        { persistent: true, dismissed: false });
      await new Promise(r => setTimeout(r, 1000));
      w.dispatchEvent(new w.Event("deactivate"));
      await new Promise(r => setTimeout(r, 1200));
      out.withPopupX = x();
      w.PopupNotifications
        .getNotification("zen-perm-probe", w.gBrowser.selectedBrowser)?.remove();
      await new Promise(r => setTimeout(r, 900));
      await hold();
      out.reheldByHover = tb.hasAttribute("zen-has-hover");
      w.dispatchEvent(new w.Event("deactivate"));
      await new Promise(r => setTimeout(r, 1200));
      out.noPopupX = x();
      out.noPopupHover = tb.hasAttribute("zen-has-hover");
      return JSON.stringify(out);
    """)
    if not r.get("baselineHidden"):
        return False, "no hidden sidebar to test against"
    bad = []
    # A reading taken from a sidebar that was never really held proves nothing.
    if not r.get("heldByHover") or not r.get("reheldByHover"):
        bad.append("sidebar was not actually held by hover; readings are void")
    if r["withPopupX"] < -100:
        bad.append("collapsed while our own popup held focus (x=%s)" % r["withPopupX"])
    if r["noPopupX"] > -100:
        if r.get("noPopupHover"):
            return False, ("VOID: pointer was over the sidebar (zen-has-hover "
                           "set); move it off and re-run")
        bad.append("no longer collapses on a real switch away (x=%s)" % r["noPopupX"])
    return not bad, "withPopup=%s noPopup=%s bad=%s" % (
        r["withPopupX"], r["noPopupX"], bad or "none")


@check("sidebar-holds-for-anchored-popup")
def sidebar_holds_for_anchored_popup(m):
    """A doorhanger lives in the popup set and is only ANCHORED to the sidebar,
    so nothing inside carries [open] for it. The hold ignored that, the sidebar
    slid away, and an extension's permission prompt closed with its anchor."""
    r = m.js("""
      Services.prefs.setBoolPref("zen.view.compact.hide-tabbar", true);
      Services.prefs.setBoolPref("zen.view.compact.hide-toolbar", false);
      Services.prefs.setBoolPref("zen.view.compact.enabled", true);
      await new Promise(r => setTimeout(r, 1200));
      const w = Services.wm.getMostRecentWindow("navigator:browser");
      const d = w.document;
      const tb = d.getElementById("navigator-toolbox");
      const M = w.gZenCompactModeManager;
      const probe = PathUtils.join(PathUtils.tempDir, "zen-anchored.html");
      await IOUtils.writeUTF8(probe, "<title>anchored</title>");
      const t = w.gBrowser.addTab(PathUtils.toFileURI(probe), {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      w.gBrowser.selectedTab = t;
      await new Promise(r => setTimeout(r, 2500));
      if (!M.preference) { M.toggle(true); await new Promise(r => setTimeout(r, 1500)); }
      const SEL = ":where([panelopen],[open],[breakout-extend])" +
        ":not(#urlbar[zen-floating-urlbar='true']):not(tab):not(.zen-compact-mode-ignore)";
      const x = () => +tb.getBoundingClientRect().x.toFixed(1);
      let hidden = false;
      for (let i = 0; i < 25; i++) {
        for (const el of tb.querySelectorAll(SEL)) { el.removeAttribute("open"); }
        M._setElementExpandAttribute(tb, false);
        await new Promise(r => setTimeout(r, 400));
        if (x() < -100) { hidden = true; break; }
      }
      const out = { baselineHidden: hidden };
      if (!hidden) { return JSON.stringify(out); }
      w.PopupNotifications.show(w.gBrowser.selectedBrowser, "zen-anchor-probe",
        "Extension requests additional settings", "unified-extensions-button",
        { label: "Allow", accessKey: "A", callback: () => {} },
        [{ label: "Deny", accessKey: "D", callback: () => {} }],
        { persistent: true, dismissed: false });
      await new Promise(r => setTimeout(r, 1500));
      out.promptX = x();
      /* Nothing inside carries [open] for a doorhanger - that is the whole
         point - so this proves the hold came from the anchor, not a descendant. */
      out.descendantsWithOpen = tb.querySelectorAll(SEL).length;
      // The pointer leaving is what used to let it slide out from under.
      M._setElementExpandAttribute(tb, false);
      await new Promise(r => setTimeout(r, 2000));
      out.afterLeaveX = x();
      out.promptStillOpen = d.getElementById("notification-popup")?.state === "open";
      w.PopupNotifications
        .getNotification("zen-anchor-probe", w.gBrowser.selectedBrowser)?.remove();
      await new Promise(r => setTimeout(r, 2000));
      out.releasedX = x();
      out.releasedHover = tb.hasAttribute("zen-has-hover");
      return JSON.stringify(out);
    """)
    if not r.get("baselineHidden"):
        return False, "no hidden sidebar to test against"
    bad = []
    if r["promptX"] < -100:
        bad.append("sidebar did not come out for the prompt (x=%s)" % r["promptX"])
    if r["afterLeaveX"] < -100:
        bad.append("slid away under the open prompt (x=%s)" % r["afterLeaveX"])
    if not r["promptStillOpen"]:
        bad.append("prompt closed while the sidebar moved")
    if r["releasedX"] > -100 and not r.get("releasedHover"):
        bad.append("stayed out after the prompt closed (x=%s)" % r["releasedX"])
    return not bad, "prompt=%s afterLeave=%s released=%s descendants=%s bad=%s" % (
        r["promptX"], r["afterLeaveX"], r["releasedX"],
        r["descendantsWithOpen"], bad or "none")


@check("sidebar-opens-for-new-tab")
def sidebar_opens_for_new_tab(m):
    """Ctrl+T focuses the urlbar, which in the vertical layout lives INSIDE the
    collapsed sidebar - so without this you type into a field that is off
    screen. :focus-within is a pseudo-class, so the attribute observer never
    re-reads it on its own; the focus listeners are what make it work."""
    r = m.js("""
      Services.prefs.setBoolPref("zen.view.compact.hide-tabbar", true);
      Services.prefs.setBoolPref("zen.view.compact.hide-toolbar", false);
      Services.prefs.setBoolPref("zen.view.compact.enabled", true);
      Services.prefs.setBoolPref("zen.urlbar.replace-newtab", false);
      await new Promise(r => setTimeout(r, 1200));
      const w = Services.wm.getMostRecentWindow("navigator:browser");
      const d = w.document;
      const tb = d.getElementById("navigator-toolbox");
      const M = w.gZenCompactModeManager;
      const probe = PathUtils.join(PathUtils.tempDir, "zen-newtab-check.html");
      await IOUtils.writeUTF8(probe, "<title>newtab</title>");
      const t = w.gBrowser.addTab(PathUtils.toFileURI(probe), {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      w.gBrowser.selectedTab = t;
      await new Promise(r => setTimeout(r, 2500));
      if (!M.preference) { M.toggle(true); await new Promise(r => setTimeout(r, 1200)); }
      const SEL = ":where([panelopen],[open],[breakout-extend])" +
        ":not(#urlbar[zen-floating-urlbar='true']):not(tab):not(.zen-compact-mode-ignore)";
      const x = () => Math.round(tb.getBoundingClientRect().x);
      let hidden = false;
      for (let i = 0; i < 25; i++) {
        for (const el of tb.querySelectorAll(SEL)) { el.removeAttribute("open"); }
        M._setElementExpandAttribute(tb, false);
        w.gURLBar.blur();
        await new Promise(r => setTimeout(r, 400));
        if (x() < -100) { hidden = true; break; }
      }
      const out = { baselineHidden: hidden, hiddenX: x() };
      if (!hidden) { return JSON.stringify(out); }
      w.BrowserCommands.openTab();
      await new Promise(r => setTimeout(r, 1800));
      out.afterNewTabX = x();
      out.urlbarFocused = d.activeElement?.id === "urlbar-input";
      w.gURLBar.blur();
      await new Promise(r => setTimeout(r, 1800));
      out.afterBlurX = x();
      out.afterBlurHover = tb.hasAttribute("zen-has-hover");
      return JSON.stringify(out);
    """)
    if not r.get("baselineHidden"):
        return False, "could not get a hidden sidebar to test against"
    bad = []
    if not r["urlbarFocused"]:
        bad.append("new tab did not focus the urlbar; reading is void")
    if r["afterNewTabX"] < -100:
        bad.append("sidebar stayed hidden with the urlbar focused (x=%s)"
                   % r["afterNewTabX"])
    # A hold that never releases is worse than the bug it fixes.
    if r["afterBlurX"] > -100 and not r.get("afterBlurHover"):
        bad.append("sidebar stayed out after blur (x=%s)" % r["afterBlurX"])
    return not bad, "hidden=%s newTab=%s afterBlur=%s bad=%s" % (
        r["hiddenX"], r["afterNewTabX"], r["afterBlurX"], bad or "none")


def check_patches():
    """A corrupt patch file breaks `npm run import` and nothing else notices:
    the engine tree already has the change, so builds keep working."""
    import glob
    bad = []
    for path in sorted(glob.glob(str(ROOT / "src/**/*.patch"), recursive=True)):
        rel = os.path.relpath(path, ROOT / "engine")
        applied = subprocess.run(["git", "apply", "--check", "--reverse", rel],
                                 cwd=ROOT / "engine", capture_output=True)
        if applied.returncode == 0:
            continue
        clean = subprocess.run(["git", "apply", "--check", rel],
                               cwd=ROOT / "engine", capture_output=True)
        if clean.returncode != 0:
            bad.append((os.path.basename(path),
                        clean.stderr.decode().strip().splitlines()[:1]))
    for name, why in bad:
        print("FAIL  %-26s %s" % ("patch:" + name, why), flush=True)
    if not bad:
        print("ok    %-26s %s" % ("patches-apply", "all src/**/*.patch valid"), flush=True)
    return len(bad)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="substring of the check name")
    ap.add_argument("--keep", action="store_true", help="leave the browser running")
    ap.add_argument("--port", type=int, default=0, help="0 picks a free one")
    args = ap.parse_args()

    if _user_fullscreen() and not os.environ.get("REGRESS_IGNORE_FULLSCREEN"):
        sys.exit("user is fullscreen - not starting a suite run; "
                 "set REGRESS_IGNORE_FULLSCREEN=1 to override")

    if not BINARY.exists():
        sys.exit("no build at %s - run `npm run build:ui` first" % BINARY)

    failures = skipped = 0
    if not args.only:
        failures += check_patches()

    port = args.port or free_port()
    profile = "/tmp/claude-1000/regress-profile-%d" % port
    proc = launch(profile, port)
    try:
        m = Marionette(port)
        for name, fn in CHECKS.items():
            if args.only and args.only not in name:
                continue
            try:
                ok, detail = fn(m)
            except Exception as exc:  # a raising check is a failing check
                ok, detail = False, "raised: %s" % exc
                # A script timeout wedges the session, which then failed every
                # check after it. Reconnect so one slow check stays one failure.
                try:
                    m.cmd("WebDriver:DeleteSession", {})
                except Exception:
                    pass
                try:
                    m = Marionette(port)
                except Exception as exc2:
                    detail += " (session unrecoverable: %s)" % exc2
                    break
            if ok is None:
                mark, skipped = "SKIP", skipped + 1
            elif ok:
                mark = "ok  "
            else:
                mark, failures = "FAIL", failures + 1
            print("%s  %-26s %s" % (mark, name, detail), flush=True)
    finally:
        if not args.keep:
            proc.terminate()
            try:
                proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                proc.kill()

    print("\n%d failed, %d skipped" % (failures, skipped))
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
