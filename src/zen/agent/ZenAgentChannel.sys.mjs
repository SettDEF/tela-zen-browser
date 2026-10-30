/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ZenAgentPolicy } from "resource:///modules/zen/agent/ZenAgentPolicy.sys.mjs";
import { ZenAgentLog } from "resource:///modules/zen/agent/ZenAgentLog.sys.mjs";
import { ZenAgentActions } from "resource:///modules/zen/agent/ZenAgentActions.sys.mjs";
import { ZenAgentTabs } from "resource:///modules/zen/agent/ZenAgentTabs.sys.mjs";
import { ZenAgentIdentity } from "resource:///modules/zen/agent/ZenAgentIdentity.sys.mjs";
import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";

const SOCKET_NAME = "zen-agent.sock";
const TOKEN_NAME = "zen-agent.token";
const MAX_LINE = 1 << 20;
const HELLO_TIMEOUT_MS = 5000;
const REVOKE_GRACE_MS = 500;

/* A Unix socket, not a loopback port, and the difference is not cosmetic: page
   JavaScript can reach http://127.0.0.1:<port> but has no way to address an
   AF_UNIX path at all — no URL scheme maps to one. The channel being
   unreachable from content is therefore structural, not a filter that has to
   hold. */
function socketPath() {
  return PathUtils.join(PathUtils.profileDir, SOCKET_NAME);
}

function tokenPath() {
  return PathUtils.join(PathUtils.profileDir, TOKEN_NAME);
}

function encodeLatin1(text) {
  const bytes = new TextEncoder().encode(text);
  let out = "";
  for (const byte of bytes) {
    out += String.fromCharCode(byte);
  }
  return out;
}

class AgentSession {
  constructor(transport) {
    this.transport = transport;
    this.authenticated = false;
    this.readOnly = true;
    this.client = "";
    this.accent = "";
    this.closed = false;
    this.generation = ZenAgentPolicy.generation;
    this._buffer = "";
    this._outgoing = "";
    this._writing = false;
    this._closeAfterDrain = null;
    this._decoder = new TextDecoder();

    this._output = transport
      .openOutputStream(Ci.nsITransport.OPEN_UNBUFFERED, 0, 0)
      .QueryInterface(Ci.nsIAsyncOutputStream);
    this._input = transport
      .openInputStream(0, 0, 0)
      .QueryInterface(Ci.nsIAsyncInputStream);
    this._scriptable = Cc[
      "@mozilla.org/scriptableinputstream;1"
    ].createInstance(Ci.nsIScriptableInputStream);
    this._scriptable.init(this._input);

    /* An unauthenticated connection is not allowed to sit and hold the socket
       open; the handshake is the first thing or the connection goes. */
    this._helloTimer = setTimeout(() => {
      if (!this.authenticated) {
        this.close("hello-timeout");
      }
    }, HELLO_TIMEOUT_MS);

    this._read();
  }

  /* Refusals are the last thing a rejected connection ever hears, so the
     transport has to stay up until the reply has drained — closing on the
     spot loses the reason code and the peer just sees a dropped socket. */
  closeWhenDrained(reason) {
    if (this.closed) {
      return;
    }
    this._closeAfterDrain = reason;
    if (!this._outgoing) {
      this.close(reason);
    }
  }

  close(reason) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    clearTimeout(this._helloTimer);
    try {
      this.transport.close(Cr.NS_OK);
    } catch {}
    ZenAgentChannel._sessions.delete(this);
    ZenAgentChannel._onSessionChange(reason);
  }

  send(payload) {
    if (this.closed) {
      return;
    }
    this._outgoing += encodeLatin1(JSON.stringify(payload) + "\n");
    this._write();
  }

  _write() {
    if (this._writing || this.closed || !this._outgoing) {
      return;
    }
    this._writing = true;
    this._output.asyncWait(
      {
        onOutputStreamReady: stream => {
          this._writing = false;
          if (this.closed) {
            return;
          }
          try {
            const written = stream.write(this._outgoing, this._outgoing.length);
            this._outgoing = this._outgoing.slice(written);
          } catch {
            this.close("write-failed");
            return;
          }
          if (!this._outgoing && this._closeAfterDrain) {
            this.close(this._closeAfterDrain);
            return;
          }
          this._write();
        },
      },
      0,
      0,
      Services.tm.mainThread
    );
  }

  _read() {
    if (this.closed) {
      return;
    }
    this._input.asyncWait(
      {
        onInputStreamReady: () => {
          if (this.closed) {
            return;
          }
          let chunk = "";
          try {
            const count = this._input.available();
            chunk = count ? this._scriptable.read(count) : "";
          } catch {
            this.close("read-failed");
            return;
          }
          if (!chunk) {
            this.close("peer-closed");
            return;
          }
          const bytes = Uint8Array.from(chunk, c => c.charCodeAt(0));
          this._buffer += this._decoder.decode(bytes, { stream: true });
          if (this._buffer.length > MAX_LINE) {
            this.close("line-too-long");
            return;
          }
          for (;;) {
            const end = this._buffer.indexOf("\n");
            if (end < 0) {
              break;
            }
            const line = this._buffer.slice(0, end);
            this._buffer = this._buffer.slice(end + 1);
            if (line.trim()) {
              this._handle(line);
            }
          }
          this._read();
        },
      },
      0,
      0,
      Services.tm.mainThread
    );
  }

  async _handle(line) {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      this.send({ ok: false, code: "bad-json" });
      return;
    }
    const id = request?.id ?? null;
    const verb = request?.verb;
    const params = request?.params ?? {};

    const allowed = ZenAgentPolicy.checkVerb(verb, this);
    if (!allowed.ok) {
      await this._refuse(id, verb, allowed.reason, params);
      return;
    }

    if (verb === "hello") {
      await this._hello(id, params);
      return;
    }

    /* The generation is captured before the action runs and re-checked after,
       so a revoke that lands mid-action drops the result instead of handing
       back a page the user has already withdrawn consent for. */
    const generation = ZenAgentPolicy.generation;
    ZenAgentChannel.lastActive = this;
    ZenAgentChannel._onSessionChange("active");
    let outcome;
    try {
      outcome = await ZenAgentActions.run(verb, params, this);
    } catch (ex) {
      outcome = { ok: false, reason: "action-failed", detail: String(ex) };
    }
    if (!ZenAgentPolicy.isCurrent(generation)) {
      await this._refuse(id, verb, "revoked", params);
      return;
    }
    if (!outcome.ok) {
      await this._refuse(id, verb, outcome.reason, params, outcome.detail);
      return;
    }
    await ZenAgentLog.record({
      verb,
      url: outcome.url,
      host: outcome.host,
      outcome: "ok",
      mode: ZenAgentChannel.mode,
      client: this.client,
      tabId: params.tabId ?? outcome.tabId,
    });
    this.send({ id, ok: true, result: outcome.result ?? null });
  }

  async _hello(id, params) {
    const token = await ZenAgentChannel.readToken();
    if (!token || params?.token !== token) {
      await this._refuse(id, "hello", "bad-token", params);
      this.closeWhenDrained("bad-token");
      return;
    }
    this.authenticated = true;
    this.readOnly = params?.write !== true;
    /* Derived from the name, never taken from the client: a client that could
       name its own colour could wear another's. */
    const identity = ZenAgentIdentity.describe(params?.client);
    this.client = identity.name;
    this.accent = identity.accent;
    clearTimeout(this._helloTimer);
    await ZenAgentLog.record({
      verb: "hello",
      outcome: "ok",
      mode: ZenAgentChannel.mode,
      client: this.client,
    });
    ZenAgentChannel._onSessionChange("hello");
    this.send({
      id,
      ok: true,
      result: {
        mode: ZenAgentChannel.mode,
        readOnly: this.readOnly,
        client: this.client,
        accent: this.accent,
        guardedHosts: ZenAgentPolicy.guardedHosts,
      },
    });
  }

  async _refuse(id, verb, reason, params, detail) {
    await ZenAgentLog.record({
      verb: verb || "?",
      url: params?.url || "",
      outcome: "refused",
      code: reason,
      mode: ZenAgentChannel.mode,
      client: this.client,
      tabId: params?.tabId ?? null,
      detail: detail || "",
    });
    this.send({ id, ok: false, code: reason });
  }
}

export const ZenAgentChannel = {
  _server: null,
  _sessions: new Set(),
  _token: null,
  mode: "off",
  /* The session that acted most recently. One window has one indicator, so it
     shows who is driving now; each agent tab carries its own client's colour. */
  lastActive: null,
  onChange: null,

  get listening() {
    return !!this._server;
  },

  get sessionCount() {
    return this._sessions.size;
  },

  /* Distinct identities currently connected, for the panel to list. */
  get clients() {
    const seen = new Map();
    for (const session of this._sessions) {
      if (session.authenticated) {
        seen.set(session.client, session.accent);
      }
    }
    return [...seen].map(([name, accent]) => ({ name, accent }));
  },

  async readToken() {
    if (this._token) {
      return this._token;
    }
    try {
      this._token = (await IOUtils.readUTF8(tokenPath())).trim();
    } catch {
      this._token = null;
    }
    return this._token;
  },

  /* The token is a courtesy boundary, not a security one: any process running
     as this user can read it, exactly as it can read the socket. It exists so
     an unrelated program cannot drive the browser by accident, and so the
     handle can be rotated without restarting. */
  async _writeToken() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    this._token = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join(
      ""
    );
    await IOUtils.writeUTF8(tokenPath(), this._token);
    await IOUtils.setPermissions(tokenPath(), 0o600);
    return this._token;
  },

  /* Listening in the background once the pref is on, so nothing has to be
     connected by hand. Silent only: attended means driving the tab the user is
     looking at, which should never begin without them asking. */
  async autoStart() {
    ZenAgentPolicy.observePref?.();
    /* Turning the setting on starts it now, as a launch would: before, it only
       cleared the suppression and waited for the next restart. */
    if (!this._prefWatched) {
      this._prefWatched = true;
      Services.prefs.addObserver("zen.agent.enabled", () => {
        if (ZenAgentPolicy.enabled && !this.listening && !this._starting) {
          this.start("silent");
        }
      });
    }
    if (this._autoStarted || this.listening || !ZenAgentPolicy.autoStartable) {
      return;
    }
    this._autoStarted = true;
    await this.start("silent");
  },

  async start(mode) {
    if (!ZenAgentPolicy.enabled) {
      return { ok: false, reason: "agent-disabled" };
    }
    if (mode !== "attended" && mode !== "silent") {
      return { ok: false, reason: "bad-mode" };
    }
    if (this._server) {
      this.mode = mode;
      ZenAgentTabs.mode = mode;
      this._onSessionChange("mode");
      return { ok: true, socket: socketPath() };
    }

    // The setting's observer and a Start button can both ask at once.
    if (this._starting) {
      await this._starting;
      if (this._server && this.mode !== mode) {
        this.mode = mode;
        ZenAgentTabs.mode = mode;
        this._onSessionChange("mode");
      }
      return { ok: !!this._server, socket: socketPath() };
    }
    let done;
    this._starting = new Promise(r => (done = r));
    try {
      return await this._startServer(mode).then(res => (done(res), res));
    } finally {
      this._starting = null;
    }
  },

  async _startServer(mode) {
    await ZenAgentLog.init();
    await this._writeToken();
    try {
      await IOUtils.remove(socketPath(), { ignoreAbsent: true });
    } catch {}

    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(socketPath());
    const server = Cc["@mozilla.org/network/server-socket;1"].createInstance(
      Ci.nsIServerSocket
    );
    try {
      server.initWithFilename(file, 0o600, 4);
    } catch (ex) {
      return { ok: false, reason: "socket-failed", detail: String(ex) };
    }
    server.asyncListen({
      onSocketAccepted: (serv, transport) => {
        this._sessions.add(new AgentSession(transport));
        this._onSessionChange("accept");
      },
      onStopListening: () => {},
    });
    this._server = server;
    this.mode = mode;
    ZenAgentTabs.mode = mode;
    ZenAgentTabs.sweepStaleContainers();
    ZenAgentTabs.sweepRestoredTabs();
    await ZenAgentLog.record({ verb: "start", outcome: "ok", mode });
    this._onSessionChange("start");
    return { ok: true, socket: socketPath() };
  },

  /* The kill switch. Order matters: bump the generation first so anything
     already awaiting fails its post-check, then stop in-flight loads, then
     drop the transports and the listening socket. */
  async revoke(reason = "user") {
    ZenAgentPolicy.revoke();
    try {
      ZenAgentActions.abortAll();
    } catch {}
    try {
      ZenAgentTabs.releaseAll();
    } catch {}
    /* Sessions are de-authenticated at once, so nothing new is accepted, but
       the transports linger briefly: the in-flight verb's own continuation
       still has to enqueue its `revoked` reply, and a peer that learns the
       reason beats a peer that just sees a dropped socket. */
    for (const session of [...this._sessions]) {
      session.authenticated = false;
      session.send({ ok: false, code: "revoked" });
      setTimeout(() => session.closeWhenDrained("revoked"), REVOKE_GRACE_MS);
    }
    this._sessions.clear();
    this.lastActive = null;
    if (this._server) {
      try {
        this._server.close();
      } catch {}
      this._server = null;
    }
    try {
      await IOUtils.remove(socketPath(), { ignoreAbsent: true });
      await IOUtils.remove(tokenPath(), { ignoreAbsent: true });
    } catch {}
    this._token = null;
    this.mode = "off";
    await ZenAgentLog.record({ verb: "revoke", outcome: "ok", detail: reason });
    await ZenAgentLog.flush();
    this._onSessionChange("revoke");
    return { ok: true };
  },

  _onSessionChange(reason) {
    try {
      this.onChange?.(reason);
    } catch {}
    Services.obs.notifyObservers(null, "zen-agent-state-changed", reason);
  },
};
