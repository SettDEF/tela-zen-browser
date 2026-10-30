#!/usr/bin/env python3
"""Does a full disk cost the cookie jar? (#74)

Re-executes itself inside a user+mount namespace so it can put the test profile
on a tiny tmpfs, fills that filesystem mid-session, keeps setting cookies, then
frees the space and restarts on the same profile. Upstream Gecko treats the
failed write as corruption and rebuilds the database, which on a full disk
leaves an empty one: the restart comes back logged out of everything.
Usage: REGRESS_ALLOW_MAIN_SCREEN=1 python3 scripts/cookie_diskfull_test.py
"""
import os, pathlib, socket, subprocess, sys, time

ROOT = pathlib.Path(__file__).resolve().parent.parent
MNT = "/tmp/claude-1000/cookie-diskfull"
if os.environ.get("_COOKIE_NS") != "1":
    os.makedirs(MNT, exist_ok=True)
    os.execvp("unshare", ["unshare", "--user", "--map-root-user", "--mount",
                          "env", "_COOKIE_NS=1", sys.executable, __file__])

sys.path.insert(0, str(ROOT / "scripts"))
import regress

subprocess.run(["mount", "-t", "tmpfs", "-o", "size=400m", "tmpfs", MNT], check=True)
PROFILE = MNT + "/prof"
LOG = "/tmp/claude-1000/cookie-diskfull-browser.log"
open(LOG, "w").close()
N = 300


def start(port):
    """Launched directly: regress.launch goes through the compositor, which
    would run the browser outside this namespace and off the tmpfs."""
    os.makedirs(PROFILE, exist_ok=True)
    (pathlib.Path(PROFILE) / "user.js").write_text(
        'user_pref("marionette.port", %d);\n'
        'user_pref("browser.shell.checkDefaultBrowser", false);\n'
        'user_pref("zen.behavior.restoreSession", false);\n' % port)
    proc = subprocess.Popen([str(regress.BINARY), "--marionette", "-remote-allow-system-access",
                             "--profile", PROFILE, "--no-remote"],
                            stdout=subprocess.DEVNULL, stderr=open(LOG, "a"),
                            env=dict(os.environ, MOZ_DISABLE_CONTENT_SANDBOX="1"))
    for _ in range(90):
        time.sleep(1)
        try:
            socket.create_connection(("127.0.0.1", port), timeout=2).close()
            time.sleep(4)
            return proc
        except OSError:
            pass
    proc.kill()
    raise RuntimeError("no marionette port")


def add(m, prefix, n):
    return m.js("""
      const far = Date.now() + 86400e3 * 300;
      for (let i = 0; i < %d; i++) {
        Services.cookies.add("site" + i + ".example", "/", "%s" + i, "v".repeat(200),
          false, false, false, far, {}, Ci.nsICookie.SAMESITE_LAX,
          Ci.nsICookie.SCHEME_HTTPS);
      }
      await new Promise(r => setTimeout(r, 4000));
      return JSON.stringify(Services.cookies.cookies.length);
    """ % (n, prefix))


def fill():
    # Unbuffered: a buffered close() re-raises ENOSPC after the loop.
    with open(MNT + "/filler", "wb", buffering=0) as f:
        for chunk in (1 << 20, 4096, 1):
            try:
                while True:
                    f.write(b"\0" * chunk)
            except OSError:
                pass


def ls():
    return sorted(x for x in os.listdir(PROFILE) if x.startswith("cookies"))


# Phase 1: set the cookies, then quit so they are checkpointed into the main
# file. Left in the WAL they survive a rebuild by accident, since Gecko moves
# cookies.sqlite aside but not its -wal, which the new file then replays.
port = regress.free_port()
proc = start(port)
try:
    m = regress.Marionette(port)
    print("set:", add(m, "a", N), "cookies")
finally:
    proc.terminate(); proc.wait(30)
wal = pathlib.Path(PROFILE, "cookies.sqlite-wal")
print("after checkpoint: main", pathlib.Path(PROFILE, "cookies.sqlite").stat().st_size,
      "bytes, wal", wal.stat().st_size if wal.exists() else 0, "bytes")

# Phase 2: the disk fills mid-session while cookies keep arriving.
port = regress.free_port()
proc = start(port)
try:
    m = regress.Marionette(port)
    fill()
    print("disk filled; free now", os.statvfs(MNT).f_bavail * os.statvfs(MNT).f_frsize, "bytes")
    print("while full:", add(m, "b", N), "cookies in memory")
    time.sleep(5)
    print("files while full:", ls())
finally:
    proc.terminate(); proc.wait(30)
os.remove(MNT + "/filler")
print("files after exit:", ls())
import sqlite3, shutil
def rows(name):
    src = os.path.join(PROFILE, name)
    if not os.path.exists(src):
        return "absent"
    tmp = "/tmp/claude-1000/cookie-diskfull-peek"
    shutil.rmtree(tmp, ignore_errors=True); os.makedirs(tmp)
    for tail in ("", "-wal"):
        if os.path.exists(src + tail):
            shutil.copy(src + tail, os.path.join(tmp, "c.sqlite" + tail))
    try:
        c = sqlite3.connect(os.path.join(tmp, "c.sqlite"))
        return c.execute("select count(*), sum(name like 'a%'), sum(name like 'b%') from moz_cookies").fetchone()
    except Exception as e:
        return str(e)
print("rows (total, a, b): live", rows("cookies.sqlite"), "| bak", rows("cookies.sqlite.bak"))

# Phase 3: space is back. ZenCookieGuard runs after delayed startup, so wait
# for it rather than reading the jar at the first possible moment.
COUNT_A = """
  for (let i = 0; i < 60; i++) {
    const n = Services.cookies.cookies.filter(c => c.name.startsWith('a')).length;
    if (n >= %d) return JSON.stringify(n);
    await new Promise(r => setTimeout(r, 500));
  }
  return JSON.stringify(Services.cookies.cookies.filter(c => c.name.startsWith('a')).length);
""" % N
port = regress.free_port()
proc = start(port)
try:
    mm = regress.Marionette(port)
    after = mm.js(COUNT_A)
finally:
    proc.terminate(); proc.wait(30)
print(f"after restart: {after}/{N} earlier cookies")

# Phase 4: a restore held only in memory would vanish here.
port = regress.free_port()
proc = start(port)
try:
    persisted = regress.Marionette(port).js(COUNT_A)
finally:
    proc.terminate(); proc.wait(30)
rescue = sorted(os.listdir(os.path.join(PROFILE, "cookie-rescue"))) if os.path.isdir(
    os.path.join(PROFILE, "cookie-rescue")) else []
kept = after >= N and persisted >= N
print(("PASS" if kept else "FAIL") +
      f": {persisted}/{N} earlier cookies survive the wipe and a second restart; rescued: {rescue or 'nothing'}")
sys.exit(0 if kept else 1)
