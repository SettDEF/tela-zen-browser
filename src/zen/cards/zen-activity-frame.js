// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at http://mozilla.org/MPL/2.0/.

/* Reads a page and drives its Activity card: is something running, has it
 * finished, is there anything unread. AI chats were the first answer to that
 * and never the whole of it - a workflow run, a video still encoding and a
 * status page with an open incident are the same question.
 *
 * THE PAGE IS ONLY EVER READ. Nothing here writes to the document - no node,
 * no attribute, no stylesheet. Every surface belongs to the browser.
 *
 * A watched site is an entry in SITE_RULES (zen-site-rules.mjs), never code:
 * hosts, a name, and detectors that are themselves data - a selector plus an
 * optional test on the element's accessible name. Paths beat selectors where
 * a rule has the choice, because "/chat/<id> is a conversation" outlives
 * today's markup. The same table also tells the chrome process which icon to
 * draw, so a site's identity is written once.
 *
 * This loads into every content frame of every tab, so a page no rule covers
 * has to cost one hostname lookup and nothing else. */

/* eslint-env mozilla/frame-script */

(function () {
  const { SITE_RULES } = ChromeUtils.importESModule(
    "chrome://browser/content/zen-components/zen-site-rules.mjs",
  );

  const POLL_MS = 1200;
  const BUSY_MS = 250;
  const MAX_ITEMS = 8;
  const MAX_LABEL = 120;
  const MAX_HREF = 512;
  // Bounds the layout flushes one detector can cost on a very long list.
  const MAX_HITS = 24;

  const ABSOLUTE = /^https?:\/\//i;
  // "New chat" entries wear a real item's path; counting them invents one.
  const NEW = /\/(?:new(?:[-_]?chat)?|create)\/?$/i;

  /* ---- utils ------------------------------------------------------------ */

  const U = {
    /* Collapsed and capped; a nav label can carry a whole preview otherwise.
       Control characters go too: this talks to the chrome directly, so it is
       the only sanitiser on the path that zen-cards-frame.js gives a page. */
    clean(str) {
      return (str || "")
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX_LABEL);
    },

    text(node) {
      return U.clean(node?.textContent);
    },

    // Detectors test this, not class names: a name is a promise to users.
    name(el) {
      return (
        el.getAttribute("aria-label") || el.getAttribute("title") || U.text(el)
      );
    },

    /* An overlay link carries no text of its own - the title sits on the box
       it covers, which is how Perplexity's list is built. Climb only while the
       box still holds this one link, so a whole nav is never swallowed. */
    label(link) {
      const own =
        U.text(link) ||
        U.clean(link.getAttribute("aria-label") || link.getAttribute("title"));
      if (own) {
        return own;
      }
      let el = link.parentElement;
      for (let up = 0; up < 3 && el; up++, el = el.parentElement) {
        if (el.querySelectorAll("a[href]").length !== 1) {
          break;
        }
        const text = U.text(el);
        if (text) {
          return text;
        }
      }
      return "";
    },

    /* Present is not shown. A stop button that is merely hidden still answers
       its selector, and the card claimed it was answering forever. */
    shown(el) {
      return !!el && !el.hidden && !!el.getClientRects().length;
    },

    /* The path of a link that stays on this site, else "". LongCat and
       MiniMax write conversation links absolute, most sites root-relative. */
    path(link, host) {
      const href = link.getAttribute("href");
      if (!href || href.length > MAX_HREF) {
        return "";
      }
      // "#", "?q=" and "javascript:" resolve onto this very page.
      if (href[0] !== "/" && !ABSOLUTE.test(href)) {
        return "";
      }
      // Resolved by the anchor, so "//host/x" compares as the origin it is.
      if (typeof link.pathname !== "string") {
        return "";
      }
      const loc = content.location;
      if (link.protocol !== loc.protocol || link.port !== loc.port) {
        return "";
      }
      return link.hostname.replace(/^www\./, "") === host ? link.pathname : "";
    },

    // Tab title as a label, minus the site's own name in it.
    self(doc, rule) {
      const parts = U.text(doc.querySelector("title"))
        .split(/\s+[-–—|\\]\s+/)
        .filter(
          (part) => part && part.toLowerCase() !== rule.label.toLowerCase(),
        );
      return parts.join(" — ");
    },

    // Deduped: a nav often lists the one you have open twice.
    /* One site holds several kinds of thing, so the row's own path decides its
       tag; the rule's `kind` is only the fallback. First match wins. */
    kindOf(path, rule) {
      for (const [pattern, kind] of rule?.kinds || []) {
        if (pattern.test(path)) {
          return kind;
        }
      }
      return rule?.kind || "";
    },

    rows(doc, pattern, here, host, rule) {
      const seen = new Set();
      const items = [];
      for (const link of doc.querySelectorAll("a[href]")) {
        const path = U.path(link, host);
        if (!path || !pattern.test(path) || NEW.test(path)) {
          continue;
        }
        if (seen.has(path)) {
          continue;
        }
        const label = U.label(link);
        if (!label) {
          continue;
        }
        seen.add(path);
        items.push({ key: path, label, open: path === here,
                     kind: U.kindOf(path, rule) });
        if (items.length >= MAX_ITEMS) {
          break;
        }
      }
      // The open one first, so what matters is not scrolled past.
      items.sort((a, b) => b.open - a.open);
      return items;
    },

    host() {
      return (content?.location?.hostname || "").replace(/^www\./, "");
    },
  };

  /* ---- detectors --------------------------------------------------------- */

  const list = (det) => (!det ? [] : Array.isArray(det) ? det : [det]);

  // Name test before `shown`: an attribute read, not a layout flush.
  function hits(doc, det) {
    let found = 0;
    for (const one of list(det)) {
      for (const el of doc.querySelectorAll(one.sel)) {
        if (one.text && !one.text.test(U.name(el))) {
          continue;
        }
        if (U.shown(el) && ++found >= MAX_HITS) {
          return found;
        }
      }
    }
    return found;
  }

  // The first number in a badge, or a tally of what matched.
  function number(doc, det) {
    for (const one of list(det)) {
      if (one.tally) {
        return hits(doc, one);
      }
      for (const el of doc.querySelectorAll(one.sel)) {
        const name = U.name(el);
        const found =
          (!one.text || one.text.test(name)) && U.shown(el) && /\d+/.exec(name);
        if (found) {
          return Math.min(parseInt(found[0], 10), 999);
        }
      }
    }
    return 0;
  }

  // Built once: a page no rule covers must cost one map hit and no more.
  const BY_HOST = new Map();
  for (const rule of SITE_RULES) {
    for (const host of rule.hosts) {
      BY_HOST.set(host, rule);
    }
  }

  /* ---- reader ------------------------------------------------------------ */

  /* Resolved every tick, never once at load: a frame script runs when the
     frame is created, while it still holds about:blank. Deciding the site
     there meant every tab decided "nothing to watch" before it had one. */
  const ruleFor = () => BY_HOST.get(U.host());

  let lastSignature = "";
  let lastHost = "";
  /* A cross-origin navigation starts a fresh script in a new process, so the
     one that drew the card is gone before it can take it down. This starts
     true so the new script's first miss clears whatever was left behind. */
  let posted = true;
  // What the card on screen was built from, so the fast tick can rebuild it.
  let live = null;

  function build(state) {
    const { rule, rows, running, finished, unread, partial } = state;
    return {
      id: "zen-activity",
      title: rule.label,
      accent: rule.accent,
      // The card reports this itself, because a rule need not have rows.
      running,
      subtitle: running
        ? rule.busy
        : unread
          ? `${unread} unread`
          : partial
            ? `Current ${rule.noun} only`
            : rows.length
              ? `${rows.length} ${rule.noun}${rows.length === 1 ? "" : "s"}`
              : finished
                ? rule.done || "Finished"
                : "",
      items: rows.map((it) => ({
        key: it.key,
        label: it.label,
        /* Only the one you are on can be known to be running; the nav says
           nothing about the state of one you are not looking at. */
        status: it.open && running ? "running" : it.open ? "open" : "",
        icon: it.open && running ? "◉" : it.open ? "▸" : "·",
      })),
    };
  }

  function emit(card) {
    const signature = JSON.stringify(card);
    if (signature === lastSignature) {
      return;
    }
    lastSignature = signature;
    posted = true;
    sendAsyncMessage("ZenCards:Update", card);
  }

  function drop() {
    live = null;
    fast(false);
    if (posted) {
      posted = false;
      lastSignature = "";
      sendAsyncMessage("ZenCards:Remove", { id: "zen-activity" });
    }
  }

  function push() {
    const rule = ruleFor();
    const doc = content?.document;
    if (!rule || !doc?.body) {
      // Left the site: take the card with us rather than leave the last one's
      // rows sitting in the sidebar.
      lastHost = "";
      drop();
      return;
    }
    const host = U.host();
    // One site's rows must never sit on another one's page.
    if (host !== lastHost) {
      drop();
      lastHost = host;
    }
    const here = content.location.pathname;
    let rows = rule.path ? U.rows(doc, rule.path, here, host, rule) : [];
    const running = !!hits(doc, rule.running);
    /* Gemini drops its history from the DOM while the nav is collapsed, as
       does any site while signed out; zero there would be a lie. */
    const partial =
      !rows.length && !!rule.path && rule.path.test(here) && !NEW.test(here);
    if (partial) {
      rows = [
        {
          key: here,
          label: U.self(doc, rule) || `Current ${rule.noun}`,
          open: true,
        },
      ];
    }
    const unread = number(doc, rule.unread);
    const finished = !running && !!hits(doc, rule.finished);
    if (!rows.length && !running && !unread && !(rule.idle && finished)) {
      // Nothing to say yet: signed out, idle, or the nav has not rendered.
      return;
    }
    live = { rule, rows, running, finished, unread, partial };
    emit(build(live));
    fast(true);
  }

  /* Just the running flag, at a cadence the card's animation can mirror.
     Walking every anchor is the expensive half of a poll and the list cannot
     change this fast, so only the state detectors run here. */
  function tickBusy() {
    const doc = content?.document;
    if (!live || !doc?.body || doc.hidden || ruleFor() !== live.rule) {
      return;
    }
    const running = !!hits(doc, live.rule.running);
    if (running === live.running) {
      return;
    }
    live.running = running;
    live.finished = !running && !!hits(doc, live.rule.finished);
    emit(build(live));
  }

  // A page mid-navigation can tear content out from under a read.
  const guard = (fn) => () => {
    try {
      fn();
    } catch (ex) {
      void ex;
    }
  };

  const repeat = (fn, ms) => {
    const timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    timer.initWithCallback(guard(fn), ms, Ci.nsITimer.TYPE_REPEATING_SLACK);
    return timer;
  };

  /* Armed only while a card is live, so a tab on a page no rule covers never
     wakes for the fast tick at all. */
  let fastTimer = null;
  function fast(on) {
    if (on === !!fastTimer) {
      return;
    }
    if (on) {
      fastTimer = repeat(tickBusy, BUSY_MS);
    } else {
      fastTimer.cancel();
      fastTimer = null;
    }
  }

  /* Polled, not observed: these apps rewrite their nav constantly and a
     MutationObserver fired hundreds of times per answer for a card that can
     only change once a second anyway.
     On an nsITimer rather than content.setInterval, because a timer belonging
     to the about:blank window this script loads into dies with it on the first
     navigation - so the poll never survived to see the site it was for. */
  const timer = repeat(push, POLL_MS);
  addEventListener(
    "unload",
    () => {
      timer.cancel();
      fast(false);
    },
    { once: true },
  );
  // React on navigation rather than waiting for the next tick.
  addEventListener("pageshow", () => push(), true);
  addEventListener("DOMContentLoaded", () => push(), true);
  push();

  /* Clicking a row goes there, which is all the card asks of the page. */
  addMessageListener("ZenCards:Action", (message) => {
    const data = message.data || {};
    if (data.id !== "zen-activity" || data.action !== "activate") {
      return;
    }
    // Same-origin paths only: "//host/path" would leave the site entirely.
    if (
      typeof data.key === "string" &&
      data.key.startsWith("/") &&
      !data.key.startsWith("//")
    ) {
      content.location.assign(data.key);
    }
  });
})();
