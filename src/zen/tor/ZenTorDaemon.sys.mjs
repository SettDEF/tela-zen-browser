/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Onion routing, phase 6: our own tor.
 *
 * The distro's tor binary run under our own config and data directory, so the
 * control port exists and the circuit is readable. Started lazily, killed on
 * exit, and every failure falls back to whatever the prefs point at. */

import { Subprocess } from "resource://gre/modules/Subprocess.sys.mjs";
import { setTimeout } from "resource://gre/modules/Timer.sys.mjs";

const PREF_ENABLED = "zen.tor.daemon.enabled";
const PREF_PATH = "zen.tor.daemon.path";
const PREF_BRIDGES_ENABLED = "zen.tor.bridges.enabled";
const PREF_BRIDGES_LINES = "zen.tor.bridges.lines";

const CANDIDATES = ["/usr/bin/tor", "/usr/local/bin/tor", "/bin/tor"];
const PORT_FILE_TIMEOUT_MS = 20000;
const PORT_FILE_POLL_MS = 150;
const EXIT_TIMEOUT_MS = 6000;

/* Where the distro actually puts these, per transport. Not assumed present -
   a bridge line naming a transport we cannot find is reported, never
   silently dropped into a torrc that then fails to connect. */
const TRANSPORT_BINARIES = {
  obfs4: ["/usr/bin/obfs4proxy", "/usr/local/bin/obfs4proxy"],
  snowflake: ["/usr/bin/snowflake-client", "/usr/local/bin/snowflake-client"],
};
const TRANSPORT_BINARY_NAMES = { obfs4: "obfs4proxy", snowflake: "snowflake-client" };

const BRIDGE_ADDR_RE = /^(\[[0-9A-Fa-f:]+\]|[\d.]+):\d{1,5}$/;
const BRIDGE_FP_RE = /^[0-9A-Fa-f]{40}$/;

/* More than one, because none of them is guaranteed: a SIGTERM quit does not
   always reach the later ones. Stopping twice is a no-op. */
const SHUTDOWN_TOPICS = [
  "quit-application",
  "quit-application-granted",
  "profile-before-change",
];

/* "PORT=127.0.0.1:41283" - what ControlPortWriteToFile leaves behind. */
function parsePortFile(text) {
  const match = /PORT=([^:\s]+):(\d+)/.exec(text);
  return match ? { host: match[1], port: parseInt(match[2], 10) } : null;
}

async function firstExisting(paths) {
  for (const path of paths) {
    if (await IOUtils.exists(path)) {
      return path;
    }
  }
  return null;
}

/* One pasted line -> a torrc "Bridge ..." line plus which transport it needs,
   or a reason code (never prose - the UI owns the wording, and picks it from
   this token, not from a message built here). transport is null for a
   vanilla bridge: a plain relay address, no pluggable transport, no binary
   needed. */
function parseBridgeLine(raw, n) {
  const tokens = raw.replace(/^[Bb]ridge\s+/, "").split(/\s+/);
  const transport = Object.hasOwn(TRANSPORT_BINARIES, tokens[0]?.toLowerCase())
    ? tokens.shift().toLowerCase()
    : null;
  if (!tokens[0] || !BRIDGE_ADDR_RE.test(tokens[0])) {
    return { reason: "no-address" };
  }
  if (transport === "obfs4") {
    if (!BRIDGE_FP_RE.test(tokens[1] || "")) {
      return { reason: "obfs4-fingerprint" };
    }
    if (!tokens.some(t => t.startsWith("cert="))) {
      return { reason: "obfs4-cert" };
    }
  } else if (
    transport === "snowflake" &&
    !BRIDGE_FP_RE.test(tokens[1] || "") &&
    !tokens.some(t => t.startsWith("fingerprint="))
  ) {
    return { reason: "snowflake-fingerprint" };
  }
  return {
    transport,
    torrc: "Bridge " + (transport ? transport + " " : "") + tokens.join(" "),
  };
}

/* Every non-blank, non-comment line must parse, or none of them are used - one
   bad Bridge line makes tor refuse to start at all, and that failure has to be
   attributable to the pasted config, not read as an unrelated startup break. */
function parseBridges(text) {
  const lines = [];
  const transports = new Set();
  let n = 0;
  for (const raw of (text || "").split("\n")) {
    n++;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const result = parseBridgeLine(trimmed, n);
    if (result.reason) {
      return { ok: false, reason: result.reason, line: n };
    }
    lines.push(result.torrc);
    if (result.transport) {
      transports.add(result.transport);
    }
  }
  if (!lines.length) {
    return { ok: false, reason: "empty" };
  }
  return { ok: true, lines, transports };
}

export const ZenTorDaemon = {
  _process: null,
  _starting: null,
  control: null,
  socks: null,
  /* {transports: [...], count} once a start actually applied a bridge
     config; null when bridges are off or have not been tried yet. Stays
     from the last successful start until the next attempt, same as
     `control`/`socks` - it describes the running process, not the prefs. */
  bridgeStatus: null,

  get enabled() {
    return Services.prefs.getBoolPref(PREF_ENABLED, true);
  },

  get running() {
    return !!this._process && !!this.socks;
  },

  get _root() {
    return PathUtils.join(PathUtils.profileDir, "tor");
  },

  async _binary() {
    const pinned = Services.prefs.getStringPref(PREF_PATH, "");
    return firstExisting(pinned ? [pinned] : CANDIDATES);
  },

  /* Whether the pluggable-transport binaries a bridge line might need are on
     this machine, independent of whether bridges are even configured - the
     preferences page checks this to tell someone before they paste anything. */
  async checkTransports() {
    const out = {};
    for (const name of Object.keys(TRANSPORT_BINARIES)) {
      out[name] = await firstExisting(TRANSPORT_BINARIES[name]);
    }
    return out;
  },

  // Exposed so the preferences page can validate as someone types, not only
  // discover a bad line when the daemon next fails to start.
  validateBridges(text) {
    return parseBridges(text);
  },

  /* Resolves what bridges.* asks for into torrc lines, or a reason it
     cannot be done - checked, and refused, before tor is ever spawned. */
  async _bridgeConfig() {
    if (!Services.prefs.getBoolPref(PREF_BRIDGES_ENABLED, false)) {
      return { lines: [], status: null };
    }
    const parsed = parseBridges(Services.prefs.getStringPref(PREF_BRIDGES_LINES, ""));
    if (!parsed.ok) {
      return {
        code: "bad-bridge-line",
        detail: `bridge config: ${parsed.reason}${parsed.line ? " (line " + parsed.line + ")" : ""}`,
        meta: { reason: parsed.reason, line: parsed.line },
      };
    }
    const plugins = [];
    for (const transport of parsed.transports) {
      const binary = await firstExisting(TRANSPORT_BINARIES[transport]);
      if (!binary) {
        return {
          code: "no-transport",
          detail: `${TRANSPORT_BINARY_NAMES[transport]} not found in /usr/bin or /usr/local/bin`,
          meta: { transport },
        };
      }
      plugins.push(`ClientTransportPlugin ${transport} exec ${binary}`);
    }
    return {
      lines: ["UseBridges 1", ...plugins, ...parsed.lines],
      status: { transports: [...parsed.transports], count: parsed.lines.length },
    };
  },

  /* Idempotent and safe to call from anywhere; the first caller does the work
     and everyone else waits on the same promise. */
  ensure() {
    if (!this.enabled || this.running) {
      return Promise.resolve(this.running);
    }
    this._starting ??= this._start().finally(() => {
      this._starting = null;
    });
    return this._starting;
  },

  /* Why our own tor is not running, for anything that wants to say so rather
     than falling back to the system daemon silently. Codes, not prose: the
     wording belongs to the UI. */
  lastError: null,

  /* `meta` carries whatever machine-readable detail a UI needs to be precise
     without repeating English prose out of a log line - a reason token and a
     line number for a bad bridge line, a transport name for a missing one. */
  _failed(code, detail, meta) {
    this.lastError = { code, detail, at: Date.now(), ...meta };
    console.error(`[zen-tor] own instance not started (${code}): ${detail}`);
    return false;
  },

  async _start() {
    this.lastError = null;
    this.bridgeStatus = null;
    const binary = await this._binary();
    if (!binary) {
      return this._failed("no-binary", "no tor executable on PATH");
    }
    const root = this._root;
    const data = PathUtils.join(root, "data");
    const portFile = PathUtils.join(root, "control.port");
    try {
      await IOUtils.makeDirectory(data, { createAncestors: true });
      // tor refuses to start on a data directory any other account can read.
      await IOUtils.setPermissions(data, 0o700);
      await IOUtils.remove(portFile, { ignoreAbsent: true });
    } catch (ex) {
      return this._failed("data-dir", String(ex));
    }

    const bridges = await this._bridgeConfig();
    if (bridges.code) {
      return this._failed(bridges.code, bridges.detail, bridges.meta);
    }

    const torrc = PathUtils.join(root, "torrc");
    await IOUtils.writeUTF8(
      torrc,
      [
        "SocksPort auto",
        "ControlPort auto",
        `ControlPortWriteToFile ${portFile}`,
        "CookieAuthentication 1",
        `DataDirectory ${data}`,
        `PidFile ${PathUtils.join(root, "tor.pid")}`,
        // tor polls this and exits on its own if we die without stopping it.
        `__OwningControllerProcess ${Services.appinfo.processID}`,
        `Log notice file ${PathUtils.join(root, "tor.log")}`,
        ...bridges.lines,
        "",
      ].join("\n")
    );
    this.bridgeStatus = bridges.status;

    await this._killPrevious();
    try {
      this._process = await Subprocess.call({
        command: binary,
        arguments: ["-f", torrc],
        stderr: "stdout",
      });
    } catch (ex) {
      return this._failed("spawn", String(ex));
    }
    this._watchExit();
    for (const topic of SHUTDOWN_TOPICS) {
      Services.obs.addObserver(this, topic);
    }

    this.control = await this._readPortFile(portFile);
    if (!this.control) {
      await this.stop();
      return this._failed(
        "no-control-port",
        "tor wrote no control port; see " + PathUtils.join(root, "tor.log")
      );
    }
    return true;
  },

  /* /proc files stat as zero bytes, so IOUtils reads them as empty - which is
     why this shells out to cat rather than reading the cmdline directly. */
  async _run(command, args) {
    const process = await Subprocess.call({
      command,
      arguments: args,
      stderr: "stdout",
    });
    const output = await process.stdout.readString();
    await process.wait();
    return output;
  },

  /* A crash leaves tor holding the data directory, and the next start then
     fails outright. The cmdline check is what makes killing safe: the pid on
     its own may have been reused. */
  async _killPrevious() {
    const pidFile = PathUtils.join(this._root, "tor.pid");
    let pid = 0;
    try {
      pid = parseInt(await IOUtils.readUTF8(pidFile), 10);
    } catch {
      return;
    }
    await IOUtils.remove(pidFile, { ignoreAbsent: true });
    if (!(pid > 0)) {
      return;
    }
    try {
      const cmdline = await this._run("/bin/cat", [`/proc/${pid}/cmdline`]);
      if (!cmdline.includes(PathUtils.join(this._root, "torrc"))) {
        return;
      }
      await this._run("/bin/kill", [String(pid)]);
    } catch {
      return;
    }
    // Starting before it has let go of the lock is the same as not killing it.
    const deadline = Date.now() + EXIT_TIMEOUT_MS;
    while (Date.now() < deadline && (await IOUtils.exists(`/proc/${pid}`))) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  },

  async _readPortFile(path) {
    const deadline = Date.now() + PORT_FILE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const parsed = parsePortFile(await IOUtils.readUTF8(path));
        if (parsed) {
          return parsed;
        }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, PORT_FILE_POLL_MS));
    }
    return null;
  },

  /* The SOCKS port is not written anywhere, so tor is asked for it. Only once
     it answers is `running` true and the filter pointed at us. */
  adoptSocks(listener) {
    const match = /^\s*"?([^":]+):(\d+)"?\s*$/.exec(listener || "");
    if (!match) {
      return false;
    }
    this.socks = { host: match[1], port: parseInt(match[2], 10) };
    Services.obs.notifyObservers(null, "zen-tor-daemon-ports");
    return true;
  },

  _watchExit() {
    const process = this._process;
    process.wait().then(() => {
      if (this._process === process) {
        this._process = null;
        this.control = null;
        this.socks = null;
        this.bridgeStatus = null;
        Services.obs.notifyObservers(null, "zen-tor-daemon-ports");
      }
    });
  },

  observe() {
    this.stop();
  },

  async stop() {
    const process = this._process;
    this._process = null;
    this.control = null;
    this.socks = null;
    this.bridgeStatus = null;
    for (const topic of SHUTDOWN_TOPICS) {
      try {
        Services.obs.removeObserver(this, topic);
      } catch {}
    }
    if (!process) {
      return;
    }
    try {
      process.kill();
      await process.wait();
    } catch (ex) {
      console.error("[zen-tor] could not stop tor", ex);
    }
    Services.obs.notifyObservers(null, "zen-tor-daemon-ports");
  },
};

export const gZenTorDaemon = ZenTorDaemon;
