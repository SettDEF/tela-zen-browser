#!/usr/bin/env python3
"""The dock's download feed (#37): downloads.json while a download runs,
rewritten about twice a second, gone on pause, finish and quit. A local server
sends a file slowly; the test browser writes to a test path via
zen.downloads.progress-file, never the user's real dock file. Second monitor."""
import http.server, json, os, sys, threading, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import regress

SIZE = 6 * 1024 * 1024
OUT = "/tmp/claude-1000/dl-test"
FEED = f"{OUT}/downloads.json"
RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append(ok)
    print(("ok    " if ok else "FAIL  ") + f"{name:38} {detail}", flush=True)


class Slow(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        if self.path.startswith("/big"):
            self.send_header("Content-Length", str(SIZE))
        self.end_headers()
        sent = 0
        try:
            while sent < SIZE:
                self.wfile.write(b"\0" * 65536); sent += 65536
                time.sleep(0.1)  # ~640 KB/s: about ten seconds for the file
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, *a):
        pass


srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Slow)
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{srv.server_address[1]}"
os.makedirs(OUT, exist_ok=True)
for f in os.listdir(OUT):
    os.remove(os.path.join(OUT, f))


def feed():
    try:
        return json.load(open(FEED))
    except (OSError, ValueError):
        return None


def sample(seconds):
    rows, last_m = [], None
    end = time.time() + seconds
    while time.time() < end:
        try:
            mt = os.stat(FEED).st_mtime_ns
        except OSError:
            mt = None
        if mt and mt != last_m:
            last_m = mt
            rows.append((time.time(), feed()))
        time.sleep(0.05)
    return rows


START = """
  const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
  const list = await Downloads.getList(Downloads.ALL);
  const d = await Downloads.createDownload({ source: %s, target: %s });
  await list.add(d); d.start().catch(() => {});
  globalThis.__dl = globalThis.__dl || []; globalThis.__dl.push(d);
  return JSON.stringify(globalThis.__dl.length - 1);"""

port = regress.free_port()
proc = regress.launch("/tmp/claude-1000/dl-profile", port, prefs=f'user_pref("zen.downloads.progress-file", "{FEED}");\n')
try:
    m = regress.Marionette(port)
    time.sleep(3)
    i = m.js(START % (json.dumps(BASE + "/big"), json.dumps(f"{OUT}/big.bin")))
    rows = sample(4)
    first = rows[0][1] if rows else None
    check("feed appears while downloading", bool(first), (first or [None])[0])
    if rows:
        cur = [r[1][0]["currentBytes"] for r in rows if r[1]]
        rate = (len(rows) - 1) / (rows[-1][0] - rows[0][0]) if len(rows) > 1 else 0
        # The first write lands when the download is added, before any header.
        flowing = [r[1][0] for r in rows if r[1] and r[1][0]["currentBytes"] > 0]
        check("file name and total size", bool(flowing) and flowing[-1]["file"] == "big.bin"
              and flowing[-1]["totalBytes"] == SIZE,
              f"file={flowing and flowing[-1]['file']} total={flowing and flowing[-1]['totalBytes']}")
        check("currentBytes grows", cur == sorted(cur) and cur[-1] > cur[0], f"{cur[0]} -> {cur[-1]}")
        check("rewritten about twice a second", 1.2 <= rate <= 2.6, f"{rate:.2f} writes/s")
        check("speed reported", rows[-1][1][0]["speed"] > 0, f"{rows[-1][1][0]['speed']} B/s")
    m.js("""await globalThis.__dl[%s].cancel(); return "1";""" % i)
    time.sleep(1.5)
    check("paused: feed removed", feed() is None, feed())
    m.js("""globalThis.__dl[%s].start().catch(() => {}); return "1";""" % i)
    time.sleep(1.5)
    check("resumed: feed back", bool(feed()), "")
    end = time.time() + 30
    while time.time() < end and feed():
        time.sleep(0.5)
    time.sleep(1)
    ok = m.js("""return JSON.stringify(globalThis.__dl[%s].succeeded);""" % i)
    check("finished: feed removed", ok and feed() is None, f"succeeded={ok}")
    m.js(START % (json.dumps(BASE + "/nolength"), json.dumps(f"{OUT}/nolength.bin")))
    time.sleep(2)
    f = feed()
    check("unknown size reads as 0", bool(f) and f[0]["totalBytes"] == 0, f)
    m.cmd("Marionette:Quit", {})
    time.sleep(4)
    check("quit: feed removed", feed() is None, "")
finally:
    try:
        proc.terminate(); proc.wait(15)
    except Exception:
        pass
    srv.shutdown()
print(f"{sum(RESULTS)}/{len(RESULTS)} passed")
sys.exit(0 if all(RESULTS) else 1)
