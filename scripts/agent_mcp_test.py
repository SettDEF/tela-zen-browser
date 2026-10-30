#!/usr/bin/env python3
"""The MCP bridge, driven over real stdio JSON-RPC as a client would (#72).

Every assertion is about what the CALLER SEES: a refusal must arrive as a tool
error carrying the browser's machine code verbatim, and must never be dressed
up as a failure or a success. The exact text is printed for each case so it can
be read rather than inferred.
"""
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from agent_harness import (Marionette, free_port, launch, check, report,
                           PROFILE, ROOT)

MCP = os.path.join(ROOT, "tools/zen-agent-mcp/server.mjs")
SEEN = {}


class McpClient:
    """Minimal MCP stdio client: newline-delimited JSON-RPC 2.0."""

    def __init__(self, env):
        self.proc = subprocess.Popen(
            ["node", MCP],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, env=env, text=True, bufsize=1,
        )
        self.next_id = 0
        self.stderr = []
        threading.Thread(target=self._drain, daemon=True).start()
        self.request("initialize", {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "agent-mcp-test", "version": "1"},
        })
        self.notify("notifications/initialized")

    def _drain(self):
        for line in self.proc.stderr:
            self.stderr.append(line.rstrip())

    def notify(self, method, params=None):
        msg = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            msg["params"] = params
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()

    def request(self, method, params=None, timeout=180):
        self.next_id += 1
        rid = self.next_id
        msg = {"jsonrpc": "2.0", "id": rid, "method": method}
        if params is not None:
            msg["params"] = params
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()
        deadline = time.time() + timeout
        while time.time() < deadline:
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError("mcp server closed stdout")
            try:
                got = json.loads(line)
            except json.JSONDecodeError:
                continue
            if got.get("id") == rid:
                return got
        raise RuntimeError(f"timeout waiting for {method}")

    def call_async(self, name, args):
        """Fire a tools/call without waiting, so the kill switch can land
        while it is genuinely in flight."""
        self.next_id += 1
        rid = self.next_id
        self.proc.stdin.write(json.dumps({
            "jsonrpc": "2.0", "id": rid, "method": "tools/call",
            "params": {"name": name, "arguments": args}}) + "\n")
        self.proc.stdin.flush()
        return rid

    def await_id(self, rid, timeout=180):
        deadline = time.time() + timeout
        while time.time() < deadline:
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError("mcp server closed stdout")
            try:
                got = json.loads(line)
            except json.JSONDecodeError:
                continue
            if got.get("id") == rid:
                return got
        raise RuntimeError("timeout")

    def call(self, name, **args):
        return self.request("tools/call",
                            {"name": name, "arguments": args})

    def close(self):
        try:
            self.proc.terminate()
            self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()


def text_of(reply):
    result = reply.get("result") or {}
    return "\n".join(c.get("text", "") for c in result.get("content", []))


def is_error(reply):
    return bool((reply.get("result") or {}).get("isError"))


def record(label, reply):
    SEEN[label] = (is_error(reply), text_of(reply))
    return SEEN[label]


def main():
    port = free_port(3440)
    proc = launch(port)
    mcp = None
    try:
        m = Marionette(port)
        started = m.js("""
          const { ZenAgentChannel } = ChromeUtils.importESModule(
            "resource:///modules/zen/agent/ZenAgentChannel.sys.mjs");
          return JSON.stringify(await ZenAgentChannel.start("attended"));
        """)
        sock = started["socket"]
        env = dict(os.environ, ZEN_AGENT_SOCKET=sock)

        # --- the states that are not errors, before anything is connected ---
        absent = McpClient(dict(os.environ,
                                ZEN_AGENT_SOCKET="/tmp/claude-1000/nope.sock"))
        r = absent.call("status")
        err, txt = record("socket-absent", r)
        check("socket-absent-is-error", err, "isError set")
        check("socket-absent-names-cause",
              "socket-absent" in txt and "not running" in txt.lower(),
              txt.split("\n")[0])
        absent.close()

        mcp = McpClient(env)

        # --- the server must open no port, ever ---
        listening = subprocess.run(
            ["ss", "-ltnp"], capture_output=True, text=True).stdout
        check("bridge-opens-no-tcp-port",
              f"pid={mcp.proc.pid}" not in listening,
              "no listening socket owned by the bridge")

        tools = mcp.request("tools/list")
        names = sorted(t["name"] for t in tools["result"]["tools"])
        check("tools-listed", len(names) == 10, f"{len(names)}: {','.join(names)}")
        check("hello-not-exposed", "hello" not in names,
              "the handshake is the bridge's job, not a caller's tool")
        schemas_ok = all(
            isinstance(t.get("inputSchema"), dict) for t in tools["result"]["tools"])
        check("tools-have-schemas", schemas_ok, "every tool has an inputSchema")

        # --- success path ---
        r = mcp.call("status")
        err, txt = record("status", r)
        check("status-succeeds", not err and '"mode"' in txt,
              txt.replace("\n", " ")[:60])

        r = mcp.call("navigate", url="https://example.com/")
        err, txt = record("navigate-ok", r)
        check("navigate-succeeds", not err and "example.com" in txt,
              txt.replace("\n", " ")[:60])

        r = mcp.call("read_page")
        err, txt = record("read", r)
        check("read-page-succeeds", not err and "Example Domain" in txt,
              f"{len(txt)} chars of markdown")

        r = mcp.call("list_tabs")
        check("list-tabs-succeeds", not is_error(r) and '"tabId"' in text_of(r), "")

        r = mcp.call("screenshot")
        check("screenshot-succeeds",
              not is_error(r) and "data:image/png;base64," in text_of(r), "")

        # --- refusal paths: each must be an error, with the code verbatim ---
        for label, tool, args, code in [
            ("guarded", "navigate", {"url": "https://github.com/x"}, "origin-guarded"),
            ("scheme", "navigate", {"url": "about:config"}, "scheme-refused"),
            ("file", "navigate", {"url": "file:///etc/passwd"}, "scheme-refused"),
            ("badurl", "navigate", {"url": "not a url"}, "bad-url"),
            ("notab", "close_agent_tab", {"tabId": 9999}, "no-such-tab"),
            ("notimpl", "click", {"selector": "a"}, "not-implemented"),
        ]:
            r = mcp.call(tool, **args)
            err, txt = record(label, r)
            check(f"refusal-{label}-is-error", err, "isError set")
            check(f"refusal-{label}-carries-code",
                  txt.startswith(f"REFUSED {tool if tool != 'click' else 'click'}")
                  or f": {code}" in txt,
                  txt.split("\n")[0])
            check(f"refusal-{label}-code-verbatim", code in txt, f"code={code}")
            check(f"refusal-{label}-says-final",
                  "Do not retry" in txt, "tells the caller not to route around it")

        # A refused read must not look like an empty success. Drive the tab
        # onto a guarded host directly - the agent itself cannot get there.
        m.js("""
          const w = Services.wm.getMostRecentWindow("navigator:browser");
          w.gBrowser.selectedBrowser.loadURI(Services.io.newURI("https://github.com/"),
            {triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()});
          await new Promise(r => w.setTimeout(r, 6000));
          return JSON.stringify({url: w.gBrowser.selectedBrowser.currentURI.spec});
        """)
        r = mcp.call("read_page")
        err, txt = record("read-guarded", r)
        check("guarded-read-is-error-not-empty",
              err and "origin-guarded" in txt,
              "refused, not a blank page")

        # --- kill switch pulled while a call is in flight ---
        # Move off the guarded host first: while the tab sits on one the agent
        # is refused before anything can be in flight, which is the point.
        m.js("""
          const w = Services.wm.getMostRecentWindow("navigator:browser");
          w.gBrowser.selectedBrowser.loadURI(Services.io.newURI("https://example.com/"),
            {triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()});
          await new Promise(r => w.setTimeout(r, 5000));
          return JSON.stringify({url: w.gBrowser.selectedBrowser.currentURI.spec});
        """)
        rid = mcp.call_async("navigate", {"url": "https://httpbin.org/delay/10"})
        time.sleep(1.2)
        m.js("""
          const { ZenAgentChannel } = ChromeUtils.importESModule(
            "resource:///modules/zen/agent/ZenAgentChannel.sys.mjs");
          await ZenAgentChannel.revoke("test");
          return JSON.stringify({ok: true});
        """)
        r = mcp.await_id(rid)
        err, txt = record("revoked-midcall", r)
        check("killswitch-midcall-is-error", err, "isError set")
        check("killswitch-midcall-explains",
              "revoked" in txt or "session-ended" in txt,
              txt.split("\n")[0])
        check("killswitch-midcall-says-tell-user",
              "tell the user" in txt.lower() or "deliberate" in txt.lower(),
              "does not invite a reconnect")

        # After a revoke the socket is gone: the next call must say so.
        r = mcp.call("status")
        err, txt = record("after-revoke", r)
        check("after-revoke-is-error", err, "isError set")
        check("after-revoke-names-cause",
              "socket-absent" in txt or "session-ended" in txt,
              txt.split("\n")[0])

        # --- agent control switched off entirely ---
        m.js("""
          const { ZenAgentChannel } = ChromeUtils.importESModule(
            "resource:///modules/zen/agent/ZenAgentChannel.sys.mjs");
          Services.prefs.setBoolPref("zen.agent.enabled", false);
          const r = await ZenAgentChannel.start("attended");
          return JSON.stringify(r);
        """)
        r = mcp.call("status")
        err, txt = record("disabled", r)
        check("disabled-is-error", err, "isError set")

        # --- browser closed out from under the bridge ---
        m.js("""
          const { ZenAgentChannel } = ChromeUtils.importESModule(
            "resource:///modules/zen/agent/ZenAgentChannel.sys.mjs");
          Services.prefs.setBoolPref("zen.agent.enabled", true);
          await ZenAgentChannel.start("attended");
          return JSON.stringify({ok: true});
        """)
        mcp.call("status")
        proc.terminate()
        try:
            proc.wait(timeout=20)
        except subprocess.TimeoutExpired:
            proc.kill()
        time.sleep(2)
        r = mcp.call("status")
        err, txt = record("browser-gone", r)
        check("browser-gone-is-error", err, "isError set")
        check("browser-gone-names-cause",
              "socket" in txt.lower() or "session-ended" in txt,
              txt.split("\n")[0])
        check("bridge-survived-browser-exit",
              mcp.proc.poll() is None,
              "the bridge stayed up rather than crashing")
    finally:
        if mcp:
            mcp.close()
        try:
            if proc.poll() is None:
                proc.terminate()
                proc.wait(timeout=15)
        except Exception:
            proc.kill()

    print("\n================ WHAT THE CALLER SEES ================")
    for label in ("status", "navigate-ok", "guarded", "scheme", "notimpl",
                  "revoked-midcall", "after-revoke", "disabled",
                  "browser-gone", "socket-absent"):
        if label not in SEEN:
            continue
        err, txt = SEEN[label]
        print(f"\n--- {label}  (isError={err}) ---")
        print("\n".join(txt.split("\n")[:6]))
    return report()


if __name__ == "__main__":
    sys.exit(main())
