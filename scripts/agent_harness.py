#!/usr/bin/env python3
"""Shared harness for the agent-control suites (scripts/agent_*_test.py).

Launches the locally built browser on its own Marionette port and a throwaway
profile, and speaks the agent socket's JSONL protocol as an external client
would. It never touches the user's browser or profile: the binary is the loose
build, the profile is under /tmp, and the window is parked off-screen.
"""
import base64
import json
import os
import shutil
import socket
import subprocess
import sys
import time

import json
import os
import shutil
import socket
import subprocess
import sys
import time

ROOT = "/mnt/storage/dev/projects/tela-zen"
BINARY = f"{ROOT}/engine/obj-x86_64-pc-linux-gnu/dist/bin/zen"
PROFILE = "/tmp/claude-1000/agentdrive-profile"


def free_port(start=2960):
    for port in range(start, start + 40):
        with socket.socket() as probe:
            try:
                probe.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError("no free port")


class Marionette:
    """Minimal Marionette client: <len>:<json> framing, chrome context."""

    def __init__(self, port):
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=120)
        self.buf = b""
        self.msg_id = 0
        self._recv()  # server handshake
        self.cmd("WebDriver:NewSession", {})
        self.cmd("Marionette:SetContext", {"value": "chrome"})
        self.cmd("WebDriver:SetTimeouts", {"script": 120000})

    def _recv(self):
        while b":" not in self.buf:
            self.buf += self.sock.recv(65536)
        length, _, rest = self.buf.partition(b":")
        need = int(length)
        while len(rest) < need:
            rest += self.sock.recv(65536)
        self.buf = rest[need:]
        return json.loads(rest[:need])

    def cmd(self, name, params):
        self.msg_id += 1
        payload = json.dumps([0, self.msg_id, name, params]).encode()
        self.sock.sendall(str(len(payload)).encode() + b":" + payload)
        while True:
            msg = self._recv()
            if isinstance(msg, list) and len(msg) >= 4 and msg[1] == self.msg_id:
                if msg[2]:
                    raise RuntimeError(f"{name}: {msg[2]}")
                return msg[3]

    def js(self, body):
        r = self.cmd(
            "WebDriver:ExecuteAsyncScript",
            {
                "script": "const cb = arguments[arguments.length-1];"
                "(async () => { try { cb(await (async () => {"
                + body
                + "})()); } catch (e) { cb('ERR ' + e); } })();",
                "args": [],
                "sandbox": "system",
            },
        )
        v = r.get("value")
        if isinstance(v, str) and v.startswith("ERR "):
            raise RuntimeError(v)
        return json.loads(v) if isinstance(v, str) else v


class Channel:
    """The external assistant's side of the agent socket."""

    def __init__(self, path):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(60)
        self.sock.connect(path)
        self.buf = b""
        self.next_id = 0

    def call(self, verb, **params):
        self.next_id += 1
        req = {"id": self.next_id, "verb": verb, "params": params}
        self.sock.sendall((json.dumps(req) + "\n").encode())
        return self.read()

    def send_only(self, verb, **params):
        self.next_id += 1
        req = {"id": self.next_id, "verb": verb, "params": params}
        self.sock.sendall((json.dumps(req) + "\n").encode())

    def read(self):
        while b"\n" not in self.buf:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise RuntimeError("channel closed")
            self.buf += chunk
        line, _, rest = self.buf.partition(b"\n")
        self.buf = rest
        return json.loads(line)


def launch(port):
    if os.path.exists(PROFILE):
        shutil.rmtree(PROFILE)
    os.makedirs(PROFILE)
    with open(f"{PROFILE}/user.js", "w") as fh:
        fh.write(f'user_pref("marionette.port", {port});\n')
        fh.write('user_pref("browser.shell.checkDefaultBrowser", false);\n')
        fh.write('user_pref("zen.behavior.restoreSession", false);\n')
        fh.write('user_pref("zen.agent.enabled", true);\n')
        fh.write('user_pref("zen.media.bridge.url", "");\n')
    env = dict(os.environ, MOZ_DISABLE_CONTENT_SANDBOX="1", MOZ_ENABLE_WAYLAND="1")
    argv = [str(BINARY), "--marionette", "-remote-allow-system-access",
            "--profile", PROFILE, "--no-remote"]
    # Pinned to the monitor the user is not on, at launch: started normally it
    # opened on their screen for seconds before being moved away.
    from regress import _spare_workspace, _launch_on
    spare = _spare_workspace()
    proc = _launch_on(spare, argv, env, PROFILE) if spare else None
    parked = proc is not None
    if proc is None:
        proc = subprocess.Popen(argv, env=env, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL)
        time.sleep(4)

    for _ in range(60):
        with socket.socket() as probe:
            if probe.connect_ex(("127.0.0.1", port)) == 0:
                time.sleep(3)
                shape_window(proc.pid, park=not parked)
                return proc
        time.sleep(1)
    proc.kill()
    raise RuntimeError("browser never opened marionette")


def shape_window(pid, park=True):
    """Park the test window off the user's workspace and make it wide.

    Tiling hands out a ~677px window, which overflows toolbar widgets into the
    overflow panel where nothing is laid out and every computed style reads
    empty. The dispatches only bite once the window actually exists.
    """
    for _ in range(10):
        clients = json.loads(subprocess.run(
            ["hyprctl", "clients", "-j"], capture_output=True, text=True).stdout or "[]")
        mine = [c for c in clients if c.get("pid") == pid]
        if mine:
            addr = mine[0]["address"]
            moves = [["movetoworkspacesilent", f"9,address:{addr}"]] if park else []
            for args in moves + [["setfloating", f"address:{addr}"],
                                 ["resizewindowpixel", f"exact 1680 1020,address:{addr}"]]:
                subprocess.run(["hyprctl", "dispatch"] + args, capture_output=True)
            time.sleep(1.5)
            return
        time.sleep(1)


RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append((name, ok, detail))
    print(f"{'ok  ' if ok else 'FAIL'}  {name:<34} {detail}")


SHOTS = "/tmp/claude-1000/agent-shots"


def shot(m, name):
    """Screenshot the chrome window. Wayland renders XUL popups as separate
    surfaces, so a <panel> will NOT appear here - assert its geometry too."""
    os.makedirs(SHOTS, exist_ok=True)
    r = m.cmd("WebDriver:TakeScreenshot", {"full": True})
    path = f"{SHOTS}/{name}.png"
    with open(path, "wb") as fh:
        fh.write(base64.b64decode(r["value"]))
    return path


def report():
    failed = [n for n, ok, _ in RESULTS if not ok]
    print(f"\n{len(failed)} failed of {len(RESULTS)}")
    return 1 if failed else 0
