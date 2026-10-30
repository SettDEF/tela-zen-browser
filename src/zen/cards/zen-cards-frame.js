// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at http://mozilla.org/MPL/2.0/.

/* Content side of the sidebar cards.
 *
 * A JSWindowActor would be the modern choice, but its module has to be
 * reachable from the content process (resource:///actors/), which means a new
 * moz.build entry and a full rebuild. A frame script loads straight from
 * chrome:// into content, so the feature ships with an incremental build.
 *
 * Everything here is untrusted web content: strings are coerced and capped,
 * the item list is bounded, and only a literal #rgb/#rrggbb accent passes. The
 * chrome side renders with textContent only, so a page cannot inject markup. */

/* eslint-env mozilla/frame-script */

(function () {
  const MAX_ITEMS = 8;
  const CAP = { id: 64, title: 80, subtitle: 120, label: 120, detail: 80, status: 16, icon: 24 };

  const text = (value, max) => {
    if (typeof value !== "string" && typeof value !== "number") {
      return "";
    }
    // Strip control characters so a card cannot forge layout with newlines.
    return String(value)
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .trim()
      .slice(0, max);
  };

  const accent = value =>
    typeof value === "string" && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value) ? value : "";

  const ratio = value => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : -1;
  };

  addEventListener(
    "ZenCardUpdate",
    event => {
      // Only the top-level document may drive the card; a subframe cannot.
      if (content !== event.target?.defaultView?.top && content !== event.target?.ownerGlobal?.top) {
        return;
      }
      const d = event.detail || {};
      const items = Array.isArray(d.items) ? d.items.slice(0, MAX_ITEMS) : [];
      sendAsyncMessage("ZenCards:Update", {
        id: text(d.id, CAP.id) || "default",
        title: text(d.title, CAP.title),
        subtitle: text(d.subtitle, CAP.subtitle),
        accent: accent(d.accent),
        // A name, never a URL or markup: the chrome side looks it up in a table.
        icon: text(d.icon, CAP.icon),
        items: items
          .map((it, index) => ({
            key: text(it?.key, CAP.id) || String(index),
            label: text(it?.label, CAP.label),
            detail: text(it?.detail, CAP.detail),
            status: text(it?.status, CAP.status),
            icon: text(it?.icon, CAP.icon),
            progress: ratio(it?.progress),
          }))
          .filter(it => it.label),
      });
    },
    { capture: true, wantUntrusted: true }
  );

  addEventListener(
    "ZenCardRemove",
    event => {
      sendAsyncMessage("ZenCards:Remove", { id: text(event.detail?.id, CAP.id) });
    },
    { capture: true, wantUntrusted: true }
  );

  /* A click in the sidebar comes back to the page as an event, so the script
     can act on it without the chrome knowing anything about the site. */
  addMessageListener("ZenCards:Action", message => {
    const doc = content?.document;
    if (!doc) {
      return;
    }
    doc.dispatchEvent(
      new content.CustomEvent("ZenCardAction", {
        detail: Cu.cloneInto(message.data, content),
      })
    );
  });
})();
