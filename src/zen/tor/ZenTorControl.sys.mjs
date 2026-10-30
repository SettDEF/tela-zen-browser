/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Onion routing, phase 5: Tor's control port. Every hop the panel draws is
 * read here from a live connection; no control port means no circuit, never a
 * plausible-looking one. */

import { clearTimeout, setTimeout } from "resource://gre/modules/Timer.sys.mjs";
import { ZenTorDaemon } from "resource:///modules/zen/tor/ZenTorDaemon.sys.mjs";

const PREF_ENABLED = "zen.tor.control.enabled";
const PREF_HOST = "zen.tor.control.host";
const PREF_PORT = "zen.tor.control.port";
const PREF_COOKIE = "zen.tor.control.cookie-path";
const PREF_PASSWORD = "zen.tor.control.password";

const TIMEOUT_S = 4;
const TIMEOUT_MS = TIMEOUT_S * 1000;

const SAFECOOKIE_SERVER_KEY =
  "Tor safe cookie authentication server-to-controller hash";
const SAFECOOKIE_CLIENT_KEY =
  "Tor safe cookie authentication controller-to-server hash";

function toHex(bytes) {
  let out = "";
  for (const b of bytes) {
    out += (b & 0xff).toString(16).padStart(2, "0");
  }
  return out;
}

function fromHex(hex) {
  const out = [];
  for (let i = 0; i + 1 < hex.length; i += 2) {
    out.push(parseInt(hex.substr(i, 2), 16));
  }
  return out;
}

function bytesFromString(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    out.push(text.charCodeAt(i) & 0xff);
  }
  return out;
}

function hmacSha256(key, message) {
  const factory = Cc["@mozilla.org/security/keyobjectfactory;1"].getService(
    Ci.nsIKeyObjectFactory
  );
  const hmac = Cc["@mozilla.org/security/hmac;1"].createInstance(
    Ci.nsICryptoHMAC
  );
  hmac.init(Ci.nsICryptoHMAC.SHA256, factory.keyFromString(Ci.nsIKeyObject.HMAC, key));
  hmac.update(message, message.length);
  return bytesFromString(hmac.finish(false));
}

function withTimeout(promise, ms, what) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(what + " timed out")), ms);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/* Reply framing: "250-" continues, "250+" opens a data block ending in a lone
 * ".", and "250 " ends the reply. */
class Connection {
  constructor(host, port, idle) {
    this._host = host;
    this._port = port;
    this._idle = idle;
    this._buffer = "";
    this._pending = [];
    this._outgoing = "";
    this._writing = false;
    this._closed = false;
  }

  open() {
    const service = Cc[
      "@mozilla.org/network/socket-transport-service;1"
    ].getService(Ci.nsISocketTransportService);
    this._transport = service.createTransport(
      [],
      this._host,
      this._port,
      null,
      null
    );
    this._transport.setTimeout(Ci.nsISocketTransport.TIMEOUT_CONNECT, TIMEOUT_S);
    // The event connection sits idle by design; a read timeout would drop it.
    if (!this._idle) {
      this._transport.setTimeout(
        Ci.nsISocketTransport.TIMEOUT_READ_WRITE,
        TIMEOUT_S
      );
    }
    this._output = this._transport
      .openOutputStream(Ci.nsITransport.OPEN_UNBUFFERED, 0, 0)
      .QueryInterface(Ci.nsIAsyncOutputStream);
    this._input = this._transport
      .openInputStream(0, 0, 0)
      .QueryInterface(Ci.nsIAsyncInputStream);
    this._scriptable = Cc[
      "@mozilla.org/scriptableinputstream;1"
    ].createInstance(Ci.nsIScriptableInputStream);
    this._scriptable.init(this._input);
    this._read();
  }

  close() {
    this._fail(new Error("control connection closed"));
  }

  send(line) {
    return new Promise((resolve, reject) => {
      if (this._closed) {
        reject(new Error("control connection closed"));
        return;
      }
      this._pending.push({ resolve, reject });
      this._outgoing += line + "\r\n";
      this._write();
    });
  }

  _fail(error) {
    if (this._closed) {
      return;
    }
    this._closed = true;
    for (const waiter of this._pending.splice(0)) {
      waiter.reject(error);
    }
    try {
      this._transport?.close(Cr.NS_OK);
    } catch {}
    this.onClose?.();
  }

  _write() {
    if (this._writing || this._closed || !this._outgoing) {
      return;
    }
    this._writing = true;
    this._output.asyncWait(
      {
        onOutputStreamReady: stream => {
          this._writing = false;
          if (this._closed) {
            return;
          }
          try {
            const written = stream.write(this._outgoing, this._outgoing.length);
            this._outgoing = this._outgoing.slice(written);
          } catch (ex) {
            this._fail(ex);
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
    if (this._closed) {
      return;
    }
    this._input.asyncWait(
      {
        onInputStreamReady: () => {
          if (this._closed) {
            return;
          }
          let chunk = "";
          try {
            const count = this._input.available();
            chunk = count ? this._scriptable.read(count) : "";
          } catch (ex) {
            this._fail(ex);
            return;
          }
          if (!chunk) {
            this._fail(new Error("control port closed the connection"));
            return;
          }
          this._buffer += chunk;
          for (;;) {
            const reply = this._takeReply();
            if (!reply) {
              break;
            }
            // Async events arrive between replies and answer nobody's command.
            if (reply.code === 650) {
              this.onEvent?.(reply);
            } else {
              this._pending.shift()?.resolve(reply);
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

  _takeReply() {
    let at = 0;
    const lines = [];
    let inData = false;
    for (;;) {
      const end = this._buffer.indexOf("\r\n", at);
      if (end < 0) {
        return null;
      }
      const line = this._buffer.slice(at, end);
      at = end + 2;
      lines.push(line);
      if (inData) {
        inData = line !== ".";
        continue;
      }
      const separator = line[3];
      if (separator === "+") {
        inData = true;
      } else if (separator === " ") {
        this._buffer = this._buffer.slice(at);
        return { code: parseInt(line.slice(0, 3), 10), lines };
      }
    }
  }
}

// "250-key=value" and "250+key=" + block, folded to one map.
function replyValues(lines) {
  const values = new Map();
  let at = 0;
  while (at < lines.length) {
    const line = lines[at++];
    const separator = line[3];
    const rest = line.slice(4);
    const equals = rest.indexOf("=");
    if (separator === "+") {
      const body = [];
      while (at < lines.length && lines[at] !== ".") {
        body.push(lines[at++]);
      }
      at++;
      values.set(equals < 0 ? rest : rest.slice(0, equals), body);
    } else if (equals > 0) {
      values.set(rest.slice(0, equals), rest.slice(equals + 1));
    }
  }
  return values;
}

// "1 BUILT $FP~Nick,$FP~Nick PURPOSE=GENERAL ..."; no path means still building.
function parseCircuits(lines) {
  const circuits = new Map();
  for (const line of lines) {
    const parts = line.trim().split(" ");
    if (parts.length < 2) {
      continue;
    }
    const [id, status] = parts;
    let path = [];
    if (parts[2] && parts[2].startsWith("$")) {
      path = parts[2].split(",").map(entry => {
        const match = /^\$([0-9A-Fa-f]{40})(?:[=~](.*))?$/.exec(entry);
        return {
          fingerprint: match ? match[1].toUpperCase() : null,
          nickname: match?.[2] || null,
        };
      });
    }
    const purpose = /(?:^| )PURPOSE=(\S+)/.exec(line)?.[1] || null;
    // A one-hop tunnel is a directory fetch, not a path anything browses over.
    const oneHop = /BUILD_FLAGS=\S*ONEHOP_TUNNEL/.test(line);
    circuits.set(id, { id, status, purpose, path, oneHop });
  }
  return circuits;
}

// "42 SUCCEEDED 7 example.com:443"
function parseStreams(lines) {
  const streams = [];
  for (const line of lines) {
    const parts = line.trim().split(" ");
    if (parts.length < 4) {
      continue;
    }
    const target = parts[3];
    const colon = target.lastIndexOf(":");
    const host = colon > 0 ? target.slice(0, colon) : target;
    streams.push({
      id: parts[0],
      status: parts[1],
      circuit: parts[2],
      host: host.replace(/^\[|\]$/g, "").toLowerCase(),
    });
  }
  return streams;
}

// "r nickname identity digest date time address ORPort DirPort"
function parseRouterStatus(lines) {
  const router = { nickname: null, address: null, flags: [] };
  for (const line of lines) {
    if (line.startsWith("r ")) {
      const parts = line.split(" ");
      router.nickname = parts[1] || null;
      router.address = parts[6] || null;
    } else if (line.startsWith("s ")) {
      router.flags = line.slice(2).split(" ").filter(Boolean);
    }
  }
  return router;
}

export const ZenTorControl = {
  /* siteHost -> circuit id, only ever used after re-reading circuit-status, so
     a circuit Tor has closed can never be drawn from here. */
  _seen: new Map(),

  get enabled() {
    return Services.prefs.getBoolPref(PREF_ENABLED, true);
  },

  // Our own tor outranks the prefs; they describe an external one.
  get host() {
    return ZenTorDaemon.control?.host ?? Services.prefs.getStringPref(PREF_HOST, "127.0.0.1");
  },

  get port() {
    return ZenTorDaemon.control?.port ?? Services.prefs.getIntPref(PREF_PORT, 9051);
  },

  get cookiePath() {
    return Services.prefs.getStringPref(
      PREF_COOKIE,
      "/run/tor/control.authcookie"
    );
  },

  get password() {
    return Services.prefs.getStringPref(PREF_PASSWORD, "");
  },

  get endpoint() {
    return `${this.host}:${this.port}`;
  },

  // Built from the prefs in force, so it cannot drift from what we dial.
  get torrcHint() {
    return `ControlPort ${this.port}\nCookieAuthentication 1`;
  },

  // ---- connecting --------------------------------------------------------

  async _connect(idle) {
    const connection = new Connection(this.host, this.port, idle);
    connection.open();
    try {
      await withTimeout(this._authenticate(connection), TIMEOUT_MS, "control port");
    } catch (ex) {
      connection.close();
      throw ex;
    }
    return connection;
  },

  async _authenticate(connection) {
    const info = await connection.send("PROTOCOLINFO 1");
    if (info.code !== 250) {
      throw new Error("PROTOCOLINFO refused with " + info.code);
    }
    const auth = info.lines.find(line => line.slice(4).startsWith("AUTH ")) || "";
    const methods = (/METHODS=(\S+)/.exec(auth)?.[1] || "").split(",");
    const cookieFile = /COOKIEFILE="((?:[^"\\]|\\.)*)"/.exec(auth)?.[1];

    let command = null;
    if (this.password && methods.includes("HASHEDPASSWORD")) {
      command = `AUTHENTICATE "${this.password.replace(/(["\\])/g, "\\$1")}"`;
    } else if (methods.includes("COOKIE") || methods.includes("SAFECOOKIE")) {
      const cookie = await this._readCookie(cookieFile);
      command = methods.includes("COOKIE")
        ? "AUTHENTICATE " + toHex(cookie)
        : await this._safeCookie(connection, cookie);
    } else if (methods.includes("NULL")) {
      command = "AUTHENTICATE";
    }
    if (!command) {
      throw new Error("no usable auth method in " + methods.join(","));
    }
    const result = await connection.send(command);
    if (result.code !== 250) {
      throw new Error("AUTHENTICATE refused with " + result.code);
    }
  },

  async _readCookie(fromServer) {
    const path = fromServer ? fromServer.replace(/\\(.)/g, "$1") : this.cookiePath;
    return Array.from(await IOUtils.read(path));
  },

  // The server hash is checked, not skipped: it proves Tor holds the cookie.
  async _safeCookie(connection, cookie) {
    const clientNonce = Cc["@mozilla.org/security/random-generator;1"]
      .createInstance(Ci.nsIRandomGenerator)
      .generateRandomBytes(32);
    const reply = await connection.send(
      "AUTHCHALLENGE SAFECOOKIE " + toHex(clientNonce)
    );
    if (reply.code !== 250) {
      throw new Error("AUTHCHALLENGE refused with " + reply.code);
    }
    const line = reply.lines.at(-1);
    const serverHash = fromHex(/SERVERHASH=([0-9A-Fa-f]+)/.exec(line)?.[1] || "");
    const serverNonce = fromHex(
      /SERVERNONCE=([0-9A-Fa-f]+)/.exec(line)?.[1] || ""
    );
    const message = [...cookie, ...clientNonce, ...serverNonce];
    if (toHex(hmacSha256(SAFECOOKIE_SERVER_KEY, message)) !== toHex(serverHash)) {
      throw new Error("control port failed its own SAFECOOKIE proof");
    }
    return "AUTHENTICATE " + toHex(hmacSha256(SAFECOOKIE_CLIENT_KEY, message));
  },

  /* A page that has finished loading has no stream left, so the circuit it
     used could not be named after the fact. This connection stays open and
     records host -> circuit as tor reports each stream; nothing is drawn from
     it until circuit-status confirms the circuit still exists. */
  async watch() {
    if (this._watcher || !this.enabled) {
      return;
    }
    let connection;
    try {
      connection = await this._connect(true);
    } catch {
      return;
    }
    this._watcher = connection;
    connection.onClose = () => {
      if (this._watcher === connection) {
        this._watcher = null;
      }
    };
    connection.onEvent = reply => this._onStreamEvent(reply);
    try {
      await connection.send("SETEVENTS STREAM");
    } catch {
      connection.close();
    }
  },

  _onStreamEvent(reply) {
    for (const line of reply.lines) {
      const match = /^650 STREAM \S+ \S+ (\S+) (\S+)/.exec(line);
      if (!match || match[1] === "0") {
        continue;
      }
      const target = match[2];
      const colon = target.lastIndexOf(":");
      const host = (colon > 0 ? target.slice(0, colon) : target)
        .replace(/^\[|\]$/g, "")
        .toLowerCase();
      if (host) {
        this._seen.set(host, match[1]);
      }
    }
  },

  /* Asked once at startup: tor writes its control port to a file but not its
     SOCKS port, so the only way to learn an auto-assigned one is to ask. */
  async socksListener() {
    let connection;
    try {
      connection = await this._connect();
    } catch {
      return null;
    }
    try {
      return await this._getinfo(connection, "net/listeners/socks");
    } catch {
      return null;
    } finally {
      connection.close();
    }
  },

  async _getinfo(connection, key) {
    const reply = await withTimeout(
      connection.send("GETINFO " + key),
      TIMEOUT_MS,
      "GETINFO " + key
    );
    if (reply.code !== 250) {
      return null;
    }
    return replyValues(reply.lines).get(key) ?? null;
  },

  // ---- what the panel asks for -------------------------------------------

  /* `circuit` is null unless a live stream for this host named one. */
  async describe(siteHost) {
    if (!this.enabled) {
      return { available: false, reason: "disabled" };
    }
    this.watch();
    let connection;
    try {
      connection = await this._connect();
    } catch (ex) {
      return { available: false, reason: "unreachable", error: String(ex) };
    }
    try {
      const phase = await this._getinfo(connection, "status/bootstrap-phase");
      const bootstrap = parseInt(/PROGRESS=(\d+)/.exec(phase || "")?.[1] ?? "", 10);
      const circuit = await this._circuitFor(connection, siteHost);
      if (!circuit) {
        return { available: true, circuit: null, bootstrap };
      }
      await this._resolvePath(connection, circuit);
      return { available: true, circuit, bootstrap };
    } catch (ex) {
      return { available: false, reason: "failed", error: String(ex) };
    } finally {
      connection.close();
    }
  },

  // No circuit to name falls back to NEWNYM, which re-keys everything.
  async newCircuit(siteHost) {
    if (!this.enabled) {
      return { ok: false };
    }
    let connection;
    try {
      connection = await this._connect();
    } catch {
      return { ok: false };
    }
    try {
      const circuit = await this._circuitFor(connection, siteHost);
      const command = circuit ? "CLOSECIRCUIT " + circuit.id : "SIGNAL NEWNYM";
      const reply = await withTimeout(
        connection.send(command),
        TIMEOUT_MS,
        command
      );
      if (circuit) {
        this._seen.delete(siteHost);
      }
      return { ok: reply.code === 250, scope: circuit ? "circuit" : "session" };
    } catch {
      return { ok: false };
    } finally {
      connection.close();
    }
  },

  async _circuitFor(connection, siteHost) {
    const circuitLines = await this._getinfo(connection, "circuit-status");
    const circuits = parseCircuits(
      Array.isArray(circuitLines) ? circuitLines : []
    );
    const host = (siteHost || "").toLowerCase();
    if (!host) {
      return null;
    }
    const streamLines = await this._getinfo(connection, "stream-status");
    const streams = parseStreams(Array.isArray(streamLines) ? streamLines : []);
    const match =
      streams.find(s => s.host === host && s.status === "SUCCEEDED") ||
      streams.find(s => s.host === host);
    if (match && circuits.get(match.circuit)?.path.length > 1) {
      this._seen.set(host, match.circuit);
      return circuits.get(match.circuit);
    }
    // A loaded page may have no stream left; its circuit is still Tor's.
    const remembered = this._seen.get(host);
    if (remembered && circuits.get(remembered)?.path.length > 1) {
      return circuits.get(remembered);
    }
    this._seen.delete(host);
    return null;
  },

  // A relay absent from the consensus keeps the path string and nothing more.
  async _resolvePath(connection, circuit) {
    for (const hop of circuit.path) {
      if (!hop.fingerprint) {
        continue;
      }
      const lines = await this._getinfo(connection, "ns/id/$" + hop.fingerprint);
      if (!Array.isArray(lines)) {
        continue;
      }
      const router = parseRouterStatus(lines);
      hop.nickname = router.nickname || hop.nickname;
      hop.address = router.address;
      hop.flags = router.flags;
    }
    for (const hop of circuit.path) {
      if (!hop.address) {
        continue;
      }
      const country = await this._getinfo(
        connection,
        "ip-to-country/" + hop.address
      );
      if (typeof country === "string" && country && country !== "??") {
        hop.country = country.toLowerCase();
      }
    }
  },
};

export const gZenTorControl = ZenTorControl;
