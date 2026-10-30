#!/usr/bin/env python3
"""Hand someone a real browser to drive, and record what the chrome does.

Some chrome bugs only appear under a real pointer. A compact-mode sidebar that
slid out from under an extension's permission prompt survived every synthetic
reproduction - dispatched mouseleave, PopupNotifications.show from chrome, a
faked `deactivate` - and showed up immediately once a human moved the mouse.
This launches the built browser against a COPY of a real profile, installs a
recorder, and streams the trace to disk so it can be read afterwards.

Four things cost hours to learn and are why this file exists:

  * The browser shuts down cleanly when the Marionette client disconnects.
    A launcher that connects, prints and exits leaves nothing on screen, and
    the log says "Saving closed window session data" - which reads exactly
    like the user closed it. This process therefore HOLDS the session open
    for as long as you want the window. That is its main job.

  * regress.launch() rmtree's the profile directory before starting. Handing
    it a real profile path would delete that profile. This does its own
    launch for that reason; never route a real profile through launch().

  * `pkill -f zen` matches both the shell running it and the user's own
    browser. Stop this one by the pid printed at startup, nothing else.

  * A profile's `lock` / `.parentlock` must be stripped from the copy, or the
    copy refuses to start while the original is open.

Writes: <outdir>/profile-copy (the copy), <outdir>/browser.log (stdout+stderr),
<outdir>/trace.json (the recorder, refreshed every 2s).

The window opens on the current screen on purpose - somebody has to use it.
"""

import argparse
import json
import os
import pathlib
import shutil
import socket
import subprocess
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import regress  # noqa: E402  (same directory, and it owns BINARY/Marionette)

DEFAULT_PROFILE = "~/.zen/woimiwmt.Default (unofficial)"

# Caches make the copy slow and are rebuilt anyway. storage/ and extensions/
# are NOT excluded: that is where an extension's login lives, and without it
# the thing you are trying to reproduce needs signing in again.
SKIP = [
    "cache2/", "startupCache/", "minidumps/", "crashes/",
    "datareporting/", "saved-telemetry-pings/", "sessionstore-backups/",
    "lock", ".parentlock",
]

# Records every popup open/close with the stack of whoever closed it, every
# pointer crossing of the sidebar, and the sidebar's position - the four
# things needed to tell "our chrome closed it" from "the extension did".
RECORDER = """
  const w = Services.wm.getMostRecentWindow("navigator:browser");
  const d = w.document;
  const tb = d.getElementById("navigator-toolbox");
  w.__zenDrive = { log: [], t0: Date.now() };
  const L = w.__zenDrive;
  const st = () => ({
    sidebarX: Math.round(tb.getBoundingClientRect().x),
    hover: tb.hasAttribute("zen-has-hover"),
    active: tb.hasAttribute("zen-compact-mode-active"),
    ownPopup: w.gZenCompactModeManager?._hasOwnPopupOpen?.() ?? null,
  });
  /* For a doorhanger, whether the NOTIFICATION survives the panel hiding is
     the whole question: still there means dismissed and re-openable from the
     urlbar icon, gone means the request itself was cancelled. */
  const notifications = () => {
    try {
      return (w.PopupNotifications._currentNotifications || []).map(n => n.id);
    } catch (ex) {
      return ["<unreadable: " + ex + ">"];
    }
  };
  const note = (kind, e) => {
    const t = e.target;
    L.log.push({ ms: Date.now() - L.t0, kind,
      popup: t?.id || t?.className || String(t?.nodeName),
      anchor: t?.anchorNode?.id || null,
      notifications: notifications(),
      stack: (new Error().stack || "").split(String.fromCharCode(10)).slice(1, 10),
      ...st() });
    if (kind === "popuphiding" && /notification/.test(t?.id || "")) {
      // And again once the teardown has settled.
      w.setTimeout(() => L.log.push({ ms: Date.now() - L.t0,
        kind: "after-hide", notifications: notifications(), ...st() }), 400);
    }
  };
  for (const ev of ["popupshown", "popuphiding"]) {
    d.addEventListener(ev, e => note(ev, e), true);
  }
  /* Who actually hides the doorhanger. The popuphiding stack bottoms out in
     native code, so the answer has to come from PopupNotifications itself. */
  try {
    const PN = w.PopupNotifications;
    for (const fn of ["_hidePanel", "_update", "_dismiss", "_onPopupHidden"]) {
      if (typeof PN?.[fn] !== "function" || PN["__wrapped_" + fn]) { continue; }
      PN["__wrapped_" + fn] = true;
      const orig = PN[fn].bind(PN);
      PN[fn] = function (...a) {
        L.log.push({ ms: Date.now() - L.t0, kind: "PN." + fn,
          args: a.map(x => (x && x.id) || String(x).slice(0, 40)),
          stack: (new Error().stack || "").split(String.fromCharCode(10)).slice(1, 9),
          notifications: notifications(), ...st() });
        return orig(...a);
      };
    }
  } catch (ex) {
    L.log.push({ ms: 0, kind: "instrument-failed", args: [String(ex)] });
  }
  for (const ev of ["mouseleave", "mouseenter"]) {
    tb.addEventListener(ev, () => L.log.push(
      { ms: Date.now() - L.t0, kind: "sidebar:" + ev, ...st() }));
  }
  for (const ev of ["deactivate", "activate"]) {
    w.addEventListener(ev, () => L.log.push(
      { ms: Date.now() - L.t0, kind: "window:" + ev, ...st() }));
  }
  // Only on change, or the log is thousands of identical samples.
  w.setInterval(() => {
    const s = st(); const k = JSON.stringify(s);
    if (k === L._prev) { return; }
    L._prev = k;
    L.log.push({ ms: Date.now() - L.t0, kind: "state", ...s });
  }, 100);
  return JSON.stringify({ hooked: true, tabs: w.gBrowser.tabs.length, ...st() });
"""


def copy_profile(src, dst):
    """rsync the profile, minus caches and locks. Never writes to src."""
    src = pathlib.Path(os.path.expanduser(src))
    if not (src / "prefs.js").exists():
        sys.exit("not a profile (no prefs.js): %s" % src)
    if dst.exists():
        shutil.rmtree(dst)
    dst.mkdir(parents=True)
    argv = ["rsync", "-a"]
    for skip in SKIP:
        argv += ["--exclude", skip]
    argv += ["%s/" % src, "%s/" % dst]
    if subprocess.run(argv).returncode != 0:
        sys.exit("profile copy failed")
    return dst


def launch(profile, port, log_path):
    """Start the built browser on `profile`. Deliberately not regress.launch():
    that deletes the profile directory first."""
    (profile / "user.js").write_text(
        'user_pref("marionette.port", %d);\n'
        'user_pref("browser.shell.checkDefaultBrowser", false);\n' % port
    )
    for stale in ("lock", ".parentlock"):
        (profile / stale).unlink(missing_ok=True)
    return subprocess.Popen(
        [str(regress.BINARY), "--marionette", "-remote-allow-system-access",
         "--profile", str(profile), "--no-remote"],
        stdout=open(log_path, "wb"), stderr=subprocess.STDOUT,
        env=dict(os.environ, MOZ_DISABLE_CONTENT_SANDBOX="1"),
        start_new_session=True,
    )


def main():
    ap = argparse.ArgumentParser(
        description=__doc__.split("\n\n")[0],
        epilog="example: scripts/drive.py --profile '~/.zen/woimiwmt.Default "
               "(unofficial)'\n"
               "then drive the window; read the trace with --dump while it runs "
               "or after it exits.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--profile", default=DEFAULT_PROFILE,
                    help="profile to COPY and run against (default: %(default)s). "
                         "The original is only ever read.")
    ap.add_argument("--outdir", default=None,
                    help="where the copy, log and trace go (default: a temp dir, "
                         "printed at startup)")
    ap.add_argument("--fresh", action="store_true",
                    help="empty profile instead of a copy - faster, but no "
                         "extensions, logins or layout")
    ap.add_argument("--dump", metavar="TRACE",
                    help="print a saved trace.json and exit; does not launch")
    args = ap.parse_args()

    if args.dump:
        dump(args.dump)
        return

    if not regress.BINARY.exists():
        sys.exit("no built browser at %s - run `npm run build:ui` first"
                 % regress.BINARY)

    outdir = pathlib.Path(args.outdir) if args.outdir else pathlib.Path(
        "/tmp/zen-drive-%d" % os.getpid())
    outdir.mkdir(parents=True, exist_ok=True)
    profile = outdir / "profile-copy"

    if args.fresh:
        if profile.exists():
            shutil.rmtree(profile)
        profile.mkdir(parents=True)
    else:
        print("copying profile (the original is not touched)...", flush=True)
        copy_profile(args.profile, profile)

    port = regress.free_port()
    proc = launch(profile, port, outdir / "browser.log")

    for _ in range(90):
        time.sleep(1)
        try:
            socket.create_connection(("127.0.0.1", port), timeout=2).close()
            time.sleep(5)
            break
        except OSError:
            continue
    else:
        proc.kill()
        sys.exit("browser never opened a Marionette port; see %s/browser.log"
                 % outdir)

    m = regress.Marionette(port)
    info = m.js(RECORDER)
    trace = outdir / "trace.json"
    print("\nREADY  pid=%d  port=%d  %s" % (proc.pid, port, json.dumps(info)))
    print("window is yours - drive it.")
    print("trace:  %s   (refreshed every 2s)" % trace)
    print("stop:   kill %d     <- this pid only; never `pkill -f zen`,"
          " it matches your own browser" % proc.pid)
    print("\nHolding the Marionette session open. The browser exits when this "
          "does, so leave it running.\n", flush=True)

    try:
        while proc.poll() is None:
            try:
                log = m.js("""
                  const w = Services.wm.getMostRecentWindow("navigator:browser");
                  return JSON.stringify(w.__zenDrive?.log || []);
                """)
                trace.write_text(json.dumps(log))
            except Exception as ex:  # window closed, or chrome went away
                print("recorder stopped: %s" % ex, flush=True)
                break
            time.sleep(2)
    except KeyboardInterrupt:
        pass
    finally:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(20)
            except subprocess.TimeoutExpired:
                proc.kill()
    print("browser exited; trace kept at %s" % trace)


def dump(path):
    """Print a trace readably: popup stacks indented under their event."""
    entries = json.loads(pathlib.Path(path).read_text())
    for e in entries:
        kind = e.get("kind", "state")
        line = "%7dms %-18s" % (e.get("ms", 0), kind)
        if e.get("popup"):
            line += " popup=%-30s" % e["popup"][:30]
        line += " sidebarX=%-5s hover=%-5s active=%-5s own=%-5s" % (
            e.get("sidebarX"), e.get("hover"), e.get("active"), e.get("ownPopup"))
        print(line)
        if e.get("notifications") is not None:
            print("            notifications=%s anchor=%s"
                  % (e["notifications"], e.get("anchor")))
        if kind == "popuphiding":
            for frame in e.get("stack") or []:
                if frame.strip():
                    print("            %s" % frame.strip()[:110])
    print("\n%d entries" % len(entries))


if __name__ == "__main__":
    main()
