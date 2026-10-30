/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Onion routing, phase 2: the proxy filter.
 *
 * One question is asked of every channel - is this channel's container a Tor
 * container - and everything else in the feature is only about how long such
 * a container lives. A Tor space registers a permanent id here; a Tor window
 * registers an ephemeral one it destroys on close. There is no second routing
 * path for the two.
 *
 * Fail-closed is the whole point. The filter never hands back the default
 * proxy for a channel it believes is Tor's, the proxyInfo it returns carries
 * no failover, and a channel whose container cannot be read at all is treated
 * as Tor's whenever any Tor container exists. A Tor tab that quietly loads
 * over the real connection is the failure this design exists to prevent, so
 * every ambiguous case resolves towards the proxy. */

import { ZenTorControl } from "resource:///modules/zen/tor/ZenTorControl.sys.mjs";
import { ZenTorDaemon } from "resource:///modules/zen/tor/ZenTorDaemon.sys.mjs";

const PREF_ENABLED = "zen.tor.enabled";
const PREF_HOST = "zen.tor.proxy.host";
const PREF_PORT = "zen.tor.proxy.port";
const PREF_SPACES = "zen.tor.space-containers";
const PREF_LOG = "zen.tor.log";
const PREF_HARDEN = "zen.tor.harden";

/* Gecko has no per-container fingerprinting protection - resistFingerprinting
   and letterboxing are global or nothing. So this is browser-wide and opt-in,
   and the setting has to say so rather than implying it only touches Tor. */
const HARDENED = [
  ["privacy.resistFingerprinting", true],
  ["privacy.resistFingerprinting.letterboxing", true],
];

/* Ephemeral containers are named so a crashed session's leftovers can be
   found again on the next start. Nothing else keys off the name. */
const WINDOW_CONTAINER_PREFIX = "Tor window ";

// nsIProxyInfo.TRANSPARENT_PROXY_RESOLVES_HOST: hand the hostname to the
// proxy rather than resolving it here. Without it every Tor navigation asks
// the local resolver first and tells the network exactly where you are going.
const REMOTE_DNS = 0x01;

// Position among registered filters. High enough that a filter someone else
// installs runs first and ours has the last word on the result.
const FILTER_POSITION = 9999;

export const ZenTorProxy = {
  /* Permanent containers, from the pref a Tor space writes. */
  _spaces: new Set(),
  /* Ephemeral containers, one per open Tor window. Never persisted: a crash
     must not leave an id behind that a later container reuses. */
  _windows: new Set(),
  /* Containers a crashed session left behind. Removing the container does not
     remove the id from tabs the session store is about to restore, so they
     keep being routed for this session rather than quietly going direct. */
  _stale: new Set(),
  /* Handed to the next browser window as it starts; see ZenTor.claim(). */
  pendingWindowContext: null,
  _registered: false,
  /* One nsIProxyInfo per container id, so each carries its own SOCKS
     credentials; key 0 is the bucket for traffic no container could be read
     for. Cleared wholesale wherever the single proxyInfo used to be reset. */
  _proxyInfoCache: new Map(),

  WINDOW_CONTAINER_PREFIX,

  QueryInterface: ChromeUtils.generateQI(["nsIProtocolProxyChannelFilter"]),

  init() {
    if (this._inited) {
      return;
    }
    this._inited = true;
    this._readSpaces();
    this._sweepStaleWindowContexts();
    this._applyHardening();
    for (const pref of [PREF_ENABLED, PREF_HOST, PREF_PORT, PREF_SPACES, PREF_HARDEN]) {
      Services.prefs.addObserver(pref, this);
    }
    Services.obs.addObserver(this, "zen-tor-daemon-ports");
    this._sync();
  },

  observe(subject, topic, data) {
    if (topic === "zen-tor-daemon-ports") {
      this._proxyInfoCache.clear();
      return;
    }
    if (data === PREF_SPACES) {
      this._readSpaces();
    }
    if (data === PREF_HARDEN) {
      this._applyHardening();
    }
    // Host or port moving invalidates every cached proxyInfo, not just the
    // registration - a stale one would keep routing to the old port.
    this._proxyInfoCache.clear();
    this._sync();
  },

  get enabled() {
    return Services.prefs.getBoolPref(PREF_ENABLED, false);
  },

  /* Our own tor when it is up, the prefs otherwise: the filter never needs to
     know which, and the panel shows whichever is really carrying traffic. */
  get host() {
    return (
      ZenTorDaemon.socks?.host ??
      Services.prefs.getStringPref(PREF_HOST, "127.0.0.1")
    );
  },

  get port() {
    return ZenTorDaemon.socks?.port ?? Services.prefs.getIntPref(PREF_PORT, 9150);
  },

  get harden() {
    return Services.prefs.getBoolPref(PREF_HARDEN, false);
  },

  /* Only ever undoes what it did: a user who turned resistFingerprinting on
     themselves keeps it when this is switched off again. */
  _applyHardening() {
    const on = this.harden;
    for (const [pref, value] of HARDENED) {
      if (on) {
        if (!Services.prefs.prefHasUserValue(pref)) {
          this._hardened ??= new Set();
          this._hardened.add(pref);
        }
        Services.prefs.setBoolPref(pref, value);
      } else if (this._hardened?.has(pref)) {
        Services.prefs.clearUserPref(pref);
        this._hardened.delete(pref);
      }
    }
  },

  get logging() {
    return Services.prefs.getBoolPref(PREF_LOG, false);
  },

  /* Every container the filter will route, whatever its lifetime. */
  get contexts() {
    return new Set([...this._spaces, ...this._windows, ...this._stale]);
  },

  /* Hot path: applyFilter runs for every channel, so it must not build a Set. */
  get _routing() {
    return (
      this._spaces.size > 0 || this._windows.size > 0 || this._stale.size > 0
    );
  },

  isTorContext(userContextId) {
    const id = parseInt(userContextId, 10);
    return this._spaces.has(id) || this._windows.has(id) || this._stale.has(id);
  },

  /* Claimed once, by the first window to start after openTorWindow(). */
  takePendingWindowContext() {
    const id = this.pendingWindowContext;
    this.pendingWindowContext = null;
    return id;
  },

  /* Runs before the session store restores anything, so any container still
     named as a Tor window's belongs to a session that died. */
  _sweepStaleWindowContexts() {
    const { ContextualIdentityService } = ChromeUtils.importESModule(
      "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs"
    );
    for (const identity of ContextualIdentityService.getPublicIdentities()) {
      if (!identity.name?.startsWith(WINDOW_CONTAINER_PREFIX)) {
        continue;
      }
      this._stale.add(identity.userContextId);
      try {
        ContextualIdentityService.remove(identity.userContextId);
      } catch (ex) {
        console.error("[zen-tor] could not sweep stale container", ex);
      }
    }
  },

  // ---- container registry ------------------------------------------------

  _readSpaces() {
    let ids = [];
    try {
      ids = JSON.parse(Services.prefs.getStringPref(PREF_SPACES, "[]"));
    } catch {
      // A hand-edited value that no longer parses means no Tor spaces, which
      // is the safe reading: nothing claims to be routed that is not.
      ids = [];
    }
    this._spaces = new Set(
      (Array.isArray(ids) ? ids : []).map(id => parseInt(id, 10)).filter(id => id > 0)
    );
  },

  _writeSpaces() {
    Services.prefs.setStringPref(PREF_SPACES, JSON.stringify([...this._spaces]));
  },

  setSpaceRouted(userContextId, routed) {
    const id = parseInt(userContextId, 10);
    // Container 0 is the default container every direct tab shares; routing
    // it would route the whole browser.
    if (!(id > 0)) {
      return false;
    }
    if (routed) {
      this._spaces.add(id);
    } else {
      this._spaces.delete(id);
    }
    this._writeSpaces();
    this._sync();
    return true;
  },

  addWindowContext(userContextId) {
    const id = parseInt(userContextId, 10);
    if (!(id > 0)) {
      return false;
    }
    this._windows.add(id);
    this._sync();
    return true;
  },

  removeWindowContext(userContextId) {
    const removed = this._windows.delete(parseInt(userContextId, 10));
    this._sync();
    return removed;
  },

  // ---- registration ------------------------------------------------------

  /* Registered while there is something to route, and deliberately not gated
     on `enabled`: a container that is still marked but whose master switch is
     off must fail to load, not quietly go direct. `enabled` gates making new
     Tor containers, never routing existing ones. */
  _sync() {
    const want = this._routing;
    if (want === this._registered) {
      return;
    }
    const pps = Cc["@mozilla.org/network/protocol-proxy-service;1"].getService(
      Ci.nsIProtocolProxyService
    );
    if (want) {
      pps.registerChannelFilter(this, FILTER_POSITION);
      this.ensureDaemon();
    } else {
      pps.unregisterChannelFilter(this);
    }
    this._registered = want;
  },

  /* Lazy on purpose: nothing starts a tor until something is actually routed
     through one. A failure leaves the prefs' endpoint in charge, and the
     window's heartbeat calls this again rather than giving up for the session. */
  async ensureDaemon() {
    try {
      if (!(await ZenTorDaemon.ensure())) {
        return;
      }
      const listener = await ZenTorControl.socksListener();
      if (ZenTorDaemon.adoptSocks(listener)) {
        this._proxyInfoCache.clear();
      }
      ZenTorControl.watch();
    } catch (ex) {
      console.error("[zen-tor] could not bring up our own tor", ex);
    }
  },

  /* Tor isolates streams by SOCKS credentials (IsolateSOCKSAuth, on by
     default): distinct username/password pairs get distinct circuits. A
     pair derived from the container id, stable for the life of the
     container, is what keeps two spaces a user deliberately kept apart from
     ever sharing a circuit. */
  _credentialsFor(userContextId) {
    const tag = `tela-${userContextId}`;
    return [tag, tag];
  },

  /* One proxyInfo per container, memoised so repeated channels for the same
     container reuse an object. `userContextId` 0 is the bucket for a channel
     no real container could be attributed to - it gets no credentials of its
     own, only every other unattributable channel to share a circuit with. */
  proxyInfoFor(userContextId) {
    const key =
      typeof userContextId === "number" && userContextId > 0 ? userContextId : 0;
    let info = this._proxyInfoCache.get(key);
    if (!info) {
      const pps = Cc["@mozilla.org/network/protocol-proxy-service;1"].getService(
        Ci.nsIProtocolProxyService
      );
      const [username, password] = key ? this._credentialsFor(key) : ["", ""];
      /* newProxyInfo's signature has no username/password slots - those
         landed silently in aProxyAuthorizationHeader and
         aConnectionIsolationKey instead, neither of which reaches Tor.
         newProxyInfoWithAuth is the one that actually sets SOCKS auth.
         No failover proxy and no failover timeout: the last argument being
         null is what makes an unreachable proxy an error page rather than a
         silent direct load. */
      info = pps.newProxyInfoWithAuth(
        "socks", // "socks" is SOCKS5 in Gecko; "socks4" is the older one
        this.host,
        this.port,
        username,
        password,
        "", // aProxyAuthorizationHeader: HTTP proxies only
        "", // aConnectionIsolationKey: necko-local, never reaches the proxy
        REMOTE_DNS,
        4294967295,
        null
      );
      this._proxyInfoCache.set(key, info);
    }
    return info;
  },

  // ---- the filter --------------------------------------------------------

  /* No loadInfo at all means nothing in content asked for it. A system
     principal marks the rest, except a document load - that is a tab, and a tab
     can be Tor's. */
  isBrowserOwnChannel(channel) {
    const loadInfo = channel?.loadInfo;
    if (!loadInfo) {
      return true;
    }
    try {
      if (
        loadInfo.externalContentPolicyType ===
        Ci.nsIContentPolicy.TYPE_DOCUMENT
      ) {
        return false;
      }
      return !!(
        loadInfo.loadingPrincipal?.isSystemPrincipal ||
        loadInfo.triggeringPrincipal?.isSystemPrincipal
      );
    } catch {
      // Unreadable means unknown, and unknown content still fails closed.
      return false;
    }
  },

  applyFilter(channel, defaultProxy, callback) {
    let result = defaultProxy;
    let why = "direct";
    try {
      if (this._routing) {
        const id = channel?.loadInfo?.originAttributes?.userContextId;
        if (typeof id !== "number") {
          /* Fail closed, but only for content. An unattributable channel that
             is the browser's own - favicons, list updates, OCSP, the portal
             probe - was never going to be a Tor tab, and routing it was both a
             leak of unrelated traffic and, against an unresponsive proxy, an
             unbounded pile-up of channels that never complete. */
          if (this.isBrowserOwnChannel(channel)) {
            why = "chrome";
          } else {
            result = this.proxyInfoFor(0);
            why = "unattributed";
          }
        } else if (this.isTorContext(id)) {
          result = this.proxyInfoFor(id);
          why = this._spaces.has(id) ? "space" : "window";
        }
      }
    } catch (ex) {
      why = "threw";
      try {
        result = this.proxyInfoFor(0);
      } catch {
        result = defaultProxy;
      }
    }

    if (this.logging) {
      let uri = "";
      try {
        uri = channel.URI.spec;
      } catch {}
      console.warn(`[zen-tor] ${why} ${uri}`);
    }
    /* Exactly once, and outside the try: the consumer runs the rest of the
       filter chain synchronously from in here, so a throw of its own must not
       be caught into a second call. */
    callback.onProxyFilterResult(result);
  },
};

export const gZenTorProxy = ZenTorProxy;
