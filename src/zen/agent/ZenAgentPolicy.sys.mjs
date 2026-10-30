/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const PREF_ENABLED = "zen.agent.enabled";
const PREF_ALLOW_GUARDED = "zen.agent.allow-guarded-origins";

/* Hostnames no agent verb may touch, whatever mode it is in. Ported from the
   Qt-era browser's injection guard, which refused extension code on the same
   set. Financial hosts are additions; the list is a floor, never a promise of
   completeness — no static list can enumerate every bank. */
const GUARDED_HOSTS = [
  // Credential origins.
  "accounts.google.com",
  "accounts.youtube.com",
  "login.microsoftonline.com",
  "appleid.apple.com",
  "github.com",
  "login.live.com",
  "signin.aws.amazon.com",
  "login.yahoo.com",
  "auth.services.adobe.com",
  "id.atlassian.com",
  "login.okta.com",
  "signin.ebay.com",
  // Financial origins.
  "paypal.com",
  "stripe.com",
  "checkout.stripe.com",
  "wise.com",
  "revolut.com",
  "coinbase.com",
  "binance.com",
  "klarna.com",
];

/* Schemes an agent may drive. Everything privileged is refused: a verb that
   could reach about:config or a chrome: document would hand the channel the
   parent process, which is the one thing the socket boundary exists to stop. */
const ALLOWED_SCHEMES = new Set(["http:", "https:", "about:"]);

/* about: pages an agent may navigate to. about:blank and about:newtab are
   inert landing pages; everything else in the about: namespace is chrome. */
const ALLOWED_ABOUT = new Set(["about:blank", "about:newtab", "about:home"]);

/* Verb table. `write` verbs change page or browser state and are refused in
   read-only sessions; `readOnly` verbs only observe. Every verb an agent can
   name must appear here — an unlisted verb is refused as unknown-verb rather
   than falling through to some default. */
const VERBS = {
  hello: { write: false, needsTab: false },
  status: { write: false, needsTab: false },
  listTabs: { write: false, needsTab: false },
  newAgentTab: { write: true, needsTab: false },
  closeTab: { write: true, needsTab: true },
  navigate: { write: true, needsTab: true },
  readPage: { write: false, needsTab: true },
  screenshot: { write: false, needsTab: true },
  click: { write: true, needsTab: true },
  type: { write: true, needsTab: true },
  scroll: { write: true, needsTab: true },
};

export const ZenAgentPolicy = {
  /* Bumped by revoke(). Every async continuation compares the generation it
     started under against this; a mismatch means the kill switch fired while
     the action was in flight and the result must be dropped, not delivered. */
  generation: 0,

  observePref() {
    if (this._watching) {
      return;
    }
    this._watching = true;
    Services.prefs.addObserver(PREF_ENABLED, () => {
      this.suppressed = false;
    });
  },

  get enabled() {
    return Services.prefs.getBoolPref(PREF_ENABLED, false);
  },

  get allowGuarded() {
    return Services.prefs.getBoolPref(PREF_ALLOW_GUARDED, false);
  },

  get guardedHosts() {
    return GUARDED_HOSTS.slice();
  },

  /* Latched for the rest of the session, not just bumped: the channel now
     starts itself when the pref is on, so without this a revoke would be
     undone by the next auto-start and the kill switch would be decorative.
     Toggling the pref is the way back. */
  suppressed: false,

  revoke() {
    this.generation++;
    this.suppressed = true;
    return this.generation;
  },

  get autoStartable() {
    return this.enabled && !this.suppressed;
  },

  isCurrent(generation) {
    return generation === this.generation;
  },

  /* Host match is exact or dot-anchored suffix, never substring: a substring
     test lets evil-accounts.google.com.attacker.net through. */
  isGuardedHost(host) {
    if (!host) {
      return false;
    }
    const lower = host.toLowerCase();
    return GUARDED_HOSTS.some(
      entry => lower === entry || lower.endsWith("." + entry)
    );
  },

  /* Resolves a URL string to {ok, host} or a refusal code. Called on a
     navigate target before the load, and on a tab's current URL before any
     verb that reads or drives it. */
  checkUrl(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, reason: "bad-url" };
    }
    if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
      return { ok: false, reason: "scheme-refused", scheme: parsed.protocol };
    }
    if (parsed.protocol === "about:") {
      const bare = "about:" + parsed.pathname.replace(/[?#].*$/, "");
      if (!ALLOWED_ABOUT.has(bare)) {
        return { ok: false, reason: "scheme-refused", scheme: bare };
      }
      return { ok: true, host: "" };
    }
    if (this.isGuardedHost(parsed.hostname) && !this.allowGuarded) {
      return { ok: false, reason: "origin-guarded", host: parsed.hostname };
    }
    return { ok: true, host: parsed.hostname };
  },

  /* The tab's PRESENT location, which is a different question from where it
     may be sent: a tab resting on an internal page is fine to navigate away
     from, so only the guarded-host test applies here, never the scheme rules
     that gate a navigation target. */
  checkCurrent(url) {
    if (!url) {
      return { ok: true, host: "" };
    }
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      return { ok: true, host: "" };
    }
    if (this.isGuardedHost(host) && !this.allowGuarded) {
      return { ok: false, reason: "origin-guarded", host };
    }
    return { ok: true, host };
  },

  checkVerb(verb, session) {
    const spec = VERBS[verb];
    if (!spec) {
      return { ok: false, reason: "unknown-verb" };
    }
    if (!this.enabled) {
      return { ok: false, reason: "agent-disabled" };
    }
    if (verb !== "hello" && !session?.authenticated) {
      return { ok: false, reason: "not-authenticated" };
    }
    if (spec.write && session?.readOnly) {
      return { ok: false, reason: "read-only-session" };
    }
    return { ok: true, spec };
  },
};
