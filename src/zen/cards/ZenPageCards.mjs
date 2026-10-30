// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at http://mozilla.org/MPL/2.0/.

/* Sidebar cards a page can drive.
 *
 * A user script dispatches ZenCardUpdate on its document; ZenCardsChild
 * sanitises it and this renders it under the media controls. Cards are held
 * per browser, so switching tabs swaps what is shown rather than mixing pages
 * together, and a card dies with its tab.
 *
 * Content is written with textContent only - the page supplies data, never
 * markup. Clicking a row sends ZenCardAction back to that page. */

/* A card sits in the same stack as the media card, which is compact and fixed.
   Ours therefore stops growing: three rows at rest whatever the site has open,
   the rest behind one "+N more" row, and a scroller once expanded. */
const COLLAPSED_ROWS = 3;

const ACTIVITY_CARD_ID = "zen-activity-tabs";
const PAGE_CARD_ID = "zen-activity";
const ACTIVITY_TOAST_MS = 3200;
const TOAST_PREF = "zen.cards.activity-toast";

window.gZenPageCards = {
  _cards: new WeakMap(),
  // Card ids the user opened out; kept here so an update does not fold them.
  _expanded: new Set(),
  // Card id -> when its rows last changed. The subtitle is built from this.
  _activity: new Map(),
  /* browser -> { mark, title, ran, running, unread, finished, id }. A real Map,
     not a WeakMap: the whole feature is being able to walk every tab. Entries
     are pruned against gBrowser.browsers, so a closed tab cannot come back. */
  _tabs: new Map(),
  _tabSeq: 0,
  /* key -> { node, signature }. Rendering diffs against this: a card that has
     not changed keeps its element, so an unchanged payload pushed on a timer
     is a no-op instead of a teardown that replays the entry animation. */
  _nodes: new Map(),
  /* Cards about the window rather than the page in it - the Tor route, say.
     Held here so they survive a tab switch instead of dying with a browser. */
  _windowCards: new Map(),

  init() {
    if (this._inited) {
      return;
    }
    this._inited = true;
    this._migratePrefs();
    this._toolbar = document.getElementById("zen-page-cards-toolbar");
    this._template = document.getElementById("zen-page-card-template");
    if (!this._toolbar || !this._template) {
      return;
    }
    gZenCardStack.register(() => [
      ...(this._stack?.querySelectorAll(".zen-page-card") || []),
    ]);
    /* Loaded into every content frame, now and for future tabs. */
    window.messageManager.loadFrameScript(
      "chrome://browser/content/zen-components/zen-cards-frame.js",
      true,
    );
    /* The built-in reader for watched sites. It sends the same message a page
       script would, so it needs no privileges of its own beyond being ours. */
    window.messageManager.loadFrameScript(
      "chrome://browser/content/zen-components/zen-activity-frame.js",
      true,
    );
    window.messageManager.addMessageListener("ZenCards:Update", (msg) =>
      this.update(msg.target, msg.data),
    );
    window.messageManager.addMessageListener("ZenCards:Remove", (msg) =>
      this.remove(msg.target, msg.data?.id),
    );
    /* Selecting the tab is what marks its answer read - not hovering the row,
       not a timer. This is the only place unread is cleared. */
    window.addEventListener("TabSelect", () => {
      const entry = this._tabs.get(gBrowser.selectedBrowser);
      if (entry) {
        entry.unread = false;
      }
      this._retire();
      this._renderActivity();
    });
    /* The controller adds, removes and re-slots its cards on its own; watching
       the stack is what keeps ours sitting behind the right number of them. */
    const stack = this._stack;
    if (stack && stack !== this._toolbar) {
      /* The observer has to ignore what this module itself does. _restack and
         _render both write `hidden` inside the subtree being watched, so an
         unguarded observer re-entered on its own writes and never settled -
         mutation records accumulated for as long as the window was open. */
      this._stackObserver = new MutationObserver(() => {
        if (this._restacking) {
          return;
        }
        this._restack();
      });
      this._observeStack();
    }
    window.addEventListener("TabClose", (event) => {
      this._cards.delete(event.target.linkedBrowser);
      this._tabs.delete(event.target.linkedBrowser);
      this._renderActivity();
    });
    window.addEventListener("unload", () => clearInterval(this._retimer), {
      once: true,
    });
    this._render();
  },

  get enabled() {
    return Services.prefs.getBoolPref("zen.cards.enabled", true);
  },

  /* Rows and the header are plain hbox elements with a click handler - no
     XUL widget gives those a keyboard story for free the way a real button
     does. This is what makes one reachable: announced as a button, and
     Enter/Space run the same handler a click does. Callers still own
     tabIndex - the header is only ever tabbable while it is collapsible. */
  _activatable(el, onActivate) {
    el.setAttribute("role", "button");
    el.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      event.preventDefault();
      onActivate(event);
    });
  },

  update(browser, data) {
    if (!this.enabled || !data?.id) {
      return;
    }
    const forBrowser = this._cards.get(browser) || new Map();
    forBrowser.set(data.id, data);
    this._cards.set(browser, forBrowser);
    this._noteActivity(browser, data);
    if (browser === gBrowser.selectedBrowser) {
      this._render();
    }
  },

  setWindowCard(data) {
    if (!data?.id) {
      return;
    }
    this._windowCards.set(data.id, data);
    this._render();
  },

  clearWindowCard(id) {
    if (this._windowCards.delete(id)) {
      this._render();
    }
  },

  remove(browser, id) {
    const forBrowser = this._cards.get(browser);
    if (!forBrowser) {
      return;
    }
    if (id) {
      forBrowser.delete(id);
    } else {
      forBrowser.clear();
    }
    if (browser === gBrowser.selectedBrowser) {
      this._render();
    }
  },

  /* Rendered into the media stack, not beside it: a page card is another
     card about what this tab is doing, so it belongs in the same pile and
     peeks out from behind the media card exactly like a second player would.
     Falls back to its own toolbar if the media one is not in this window. */
  get _stack() {
    return (
      document.getElementById("zen-media-controls-toolbar") || this._toolbar
    );
  },

  /* An override changed under us: the cards are the same, what they draw is
     not. Drop the signatures rather than the nodes - removing them would replay
     the arrival animation for cards that never went away. */
  refresh() {
    for (const entry of this._nodes.values()) {
      entry.signature = "";
      // The rows carry their own signature, and the payload behind it has not
      // changed - only what it resolves to - so that one has to go as well.
      entry.node
        .querySelector(".zen-page-card-items")
        ?.removeAttribute("rows-signature");
    }
    this._render();
  },

  /* A page card belongs to the tab it came from, so a tab switch retires them:
     the next tab's card is a different card and should arrive like one rather
     than look like this one changing its mind. Window cards stay. */
  _retire() {
    for (const [key, entry] of [...this._nodes]) {
      if (key.startsWith("p:")) {
        entry.node.remove();
        this._nodes.delete(key);
      }
    }
    this._render();
  },

  _hostOf(browser) {
    try {
      const uri = browser?.currentURI;
      return uri && /^https?$/.test(uri.scheme) ? uri.host : "";
    } catch {
      return "";
    }
  },

  /* The page only ever says running or not running, so "finished" has to be
     remembered here: running -> not running is a completion. A tab that was
     never running has not finished, it is idle, and never shows as waiting. */
  _noteActivity(browser, data) {
    // A user script's card still has to name a site we can draw.
    const ours = data?.id === PAGE_CARD_ID;
    const mark =
      window.gZenSiteIcons?.nameForHost(this._hostOf(browser)) ||
      (ours ? "generic" : "");
    if (!mark) {
      return;
    }
    // A rule with no rows still reports itself, so its own flag counts.
    const running =
      data?.running === true ||
      (data?.items || []).some((item) => item.status === "running");
    const entry = this._tabs.get(browser) || {
      id: ++this._tabSeq,
      ran: false,
      running: false,
      unread: false,
      finished: 0,
    };
    entry.mark = mark;
    entry.title = data?.title || entry.title || this._hostOf(browser);
    if (running) {
      entry.running = true;
      entry.ran = true;
      entry.unread = false;
    } else if (entry.running) {
      entry.running = false;
      entry.finished = Date.now();
      // Finishing in the tab you are watching is not news, and neither is it
      // unread. Only a background tab has anything to announce.
      if (browser !== gBrowser.selectedBrowser) {
        entry.unread = true;
        this._announce(entry);
      }
    }
    this._tabs.set(browser, entry);
    this._renderActivity();
  },

  /* One row for every busy tab in the window, ordered by how much it wants
     you: running, then finished and unseen, then seen. A tab that has never
     run anything is not listed - an idle tab is not an alert. */
  _renderActivity() {
    const live = new Set(gBrowser.browsers);
    for (const browser of [...this._tabs.keys()]) {
      if (!live.has(browser)) {
        this._tabs.delete(browser);
      }
    }
    this._pruneActivity();
    const rows = [];
    for (const [browser, entry] of this._tabs) {
      if (entry.ran) {
        rows.push({
          browser,
          entry,
          rank: entry.running ? 0 : entry.unread ? 1 : 2,
        });
      }
    }
    if (!rows.length) {
      this.clearWindowCard(ACTIVITY_CARD_ID);
      return;
    }
    const newest = Math.max(0, ...rows.map((row) => row.entry.finished || 0));
    if (this._activityDismissedAt) {
      if (
        !rows.some((row) => row.rank === 0) &&
        newest <= this._activityDismissedAt
      ) {
        return;
      }
      this._activityDismissedAt = 0;
    }
    rows.sort(
      (a, b) =>
        a.rank - b.rank || (b.entry.finished || 0) - (a.entry.finished || 0),
    );
    const running = rows.filter((row) => row.rank === 0).length;
    const waiting = rows.filter((row) => row.rank === 1).length;
    // One fact, the most urgent one: the line has to survive a narrow sidebar.
    const summary = running
      ? `${running} running`
      : waiting
        ? `${waiting} waiting`
        : "All read";
    this.setWindowCard({
      id: ACTIVITY_CARD_ID,
      title: "Activity",
      subtitle: summary,
      icon: "generic",
      // Chrome-built, so this may hold a function; a page card never can.
      activate: (key) => this._focusActivity(key),
      items: rows.map(({ browser, entry }) => ({
        key: String(entry.id),
        label: browser.contentTitle || entry.title,
        status: entry.running ? "running" : entry.unread ? "waiting" : "",
        icon: entry.mark,
      })),
    });
  },

  /* The card is the way back to the answer. Looked up by id rather than held in
     a closure, so a row can never point at a tab that has since gone. */
  _focusActivity(key) {
    for (const [browser, entry] of this._tabs) {
      if (String(entry.id) === key) {
        const tab = gBrowser.getTabForBrowser(browser);
        if (tab) {
          gBrowser.selectedTab = tab;
        }
        return;
      }
    }
  },

  get toastEnabled() {
    return Services.prefs.getBoolPref(TOAST_PREF, true);
  },

  // Renaming alone would turn the toast back on for anyone who turned it off.
  _migratePrefs() {
    const old = "zen.cards.agent-toast";
    if (Services.prefs.prefHasUserValue(old)) {
      if (!Services.prefs.prefHasUserValue(TOAST_PREF)) {
        Services.prefs.setBoolPref(
          TOAST_PREF,
          Services.prefs.getBoolPref(old, true),
        );
      }
      Services.prefs.clearUserPref(old);
    }
  },

  /* Fired from the completion transition only, never from a poll tick. */
  /* Read from CSS, like the clipboard toast, so a mod can retime it without JS.
     The stylesheet already promised this; the timer ignored it. */
  _toastMs() {
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue("--zen-activity-toast-duration")
      .trim();
    const ms = raw.endsWith("ms") ? parseFloat(raw) : parseFloat(raw) * 1000;
    return Number.isFinite(ms) && ms > 0 ? ms : ACTIVITY_TOAST_MS;
  },

  _announce(entry) {
    if (!this.toastEnabled) {
      return;
    }
    let box = document.getElementById("zen-activity-toast-container");
    if (!box) {
      box = document.createXULElement("vbox");
      box.id = "zen-activity-toast-container";
      box.setAttribute("hidden", "true");
      document.documentElement.appendChild(box);
    }
    box.removeAttribute("hidden");
    let toast = box.firstElementChild;
    if (!toast) {
      toast = document.createXULElement("hbox");
      toast.className = "zen-toast zen-activity-toast";
      const mark = document.createElement("img");
      mark.className = "zen-activity-toast-mark";
      const label = document.createXULElement("label");
      label.className = "zen-activity-toast-label";
      toast.append(mark, label);
      box.appendChild(toast);
    }
    const mark = toast.querySelector(".zen-activity-toast-mark");
    mark.hidden = !window.gZenSiteIcons?.paint(mark, { name: entry.mark });
    document.l10n.setAttributes(
      toast.querySelector(".zen-activity-toast-label"),
      "zen-page-card-finished",
      { title: entry.title }
    );
    toast.removeAttribute("leaving");
    toast.removeAttribute("entering");
    void toast.getBoundingClientRect();
    toast.setAttribute("entering", "true");
    clearTimeout(this._toastHide);
    this._toastHide = setTimeout(() => {
      toast.setAttribute("leaving", "true");
      clearTimeout(this._toastDrop);
      this._toastDrop = setTimeout(() => {
        toast.remove();
        if (!box.children.length) {
          box.setAttribute("hidden", "true");
        }
      }, 220);
    }, this._toastMs());
  },

  /* The count is already on screen as rows. What is not is whether anything is
     happening, so the line says that instead. */
  /* _activity is keyed by card id, not by browser, so nothing else ever drops
     an entry - a page sending many distinct ids grew it without bound. It only
     feeds an "Active <ago>" subtitle, so anything a day old is already dead. */
  _pruneActivity() {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [id, at] of this._activity) {
      if (at < cutoff) {
        this._activity.delete(id);
      }
    }
    // Backstop for a page spamming ids faster than the cutoff can retire them.
    const excess = this._activity.size - 500;
    if (excess > 0) {
      for (const id of [...this._activity.keys()].slice(0, excess)) {
        this._activity.delete(id);
      }
    }
  },

  _subtitle(card) {
    // A window card is built here and already says what it means.
    if (this._windowCards.has(card.id)) {
      return card.subtitle || "";
    }
    if ((card.items || []).some((item) => item.status === "running")) {
      return { id: "zen-page-card-answering" };
    }
    const at = this._activity.get(card.id);
    return at ? `Active ${this._ago(at)}` : card.subtitle || "";
  },

  _ago(at) {
    const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (seconds < 45) {
      return "just now";
    }
    const minutes = Math.round(seconds / 60);
    return minutes < 60
      ? `${minutes}m ago`
      : `${Math.round(minutes / 60)}h ago`;
  },

  /* "Active 3m ago" goes stale on its own, so it is rewritten in place on a
     slow timer that only exists while a card does. Text only - no rebuild. */
  _retime() {
    for (const entry of this._nodes.values()) {
      const line = entry.node.querySelector(".zen-page-card-subtitle");
      const text = this._subtitle(entry.card);
      if (line && text && text.id) {
        document.l10n.setAttributes(line, text.id, text.args);
      } else if (line && line.textContent !== text) {
        line.removeAttribute("data-l10n-id");
        line.textContent = text;
        line.hidden = !text;
      }
    }
  },

  _schedule() {
    const wanted = this._nodes.size > 0;
    if (wanted && !this._retimer) {
      this._retimer = setInterval(() => this._retime(), 30000);
    } else if (!wanted && this._retimer) {
      clearInterval(this._retimer);
      this._retimer = null;
    }
  },

  /* The host of the tab the card belongs to. Read from the browser, never from
     the card, so content cannot claim to be a site it is not. */
  _host() {
    try {
      const uri = gBrowser.selectedBrowser?.currentURI;
      return uri && /^https?$/.test(uri.scheme) ? uri.host : "";
    } catch {
      return "";
    }
  },

  _render() {
    const stack = this._stack;
    if (!stack) {
      return;
    }
    const cards = this._cards.get(gBrowser.selectedBrowser);
    /* A window card is about the window, so it gets no site mark: the host of
       whatever tab happens to be selected is not its identity. */
    const list = [
      ...[...this._windowCards.values()].map((card) => [
        `w:${card.id}`,
        card,
        "",
      ]),
      ...(this.enabled && cards
        ? [...cards.values()].map((card) => [
            `p:${card.id}`,
            card,
            this._host(),
          ])
        : []),
    ];

    const live = new Set(list.map(([key]) => key));
    const kept = new Set();
    for (const [key, entry] of [...this._nodes]) {
      if (live.has(key) && entry.node.parentNode === stack) {
        kept.add(entry.node);
        continue;
      }
      entry.node.remove();
      this._nodes.delete(key);
    }
    // Anything of ours still in the stack that no record claims is left over
    // from a window that rendered before this map existed.
    for (const stale of [...stack.querySelectorAll(".zen-page-card")]) {
      if (!kept.has(stale)) {
        stale.remove();
      }
    }

    /* Existing nodes are never moved, only updated: re-inserting an element
       restarts its animations, which is the flicker this diff exists to stop.
       Order still holds because a new card is placed after the last one. */
    let previous = null;
    for (const [key, card, host] of list) {
      const signature = JSON.stringify([card, host]);
      let entry = this._nodes.get(key);
      if (!entry) {
        entry = { node: this._build(card, host), signature, card };
        this._nodes.set(key, entry);
        if (previous) {
          previous.after(entry.node);
        } else {
          stack.append(entry.node);
        }
      } else if (entry.signature !== signature) {
        this._fill(entry.node, card, host);
        entry.signature = signature;
        entry.card = card;
      }
      previous = entry.node;
    }
    this._schedule();
    // Our own toolbar is only a template holder once the stack is shared.
    if (this._toolbar && this._toolbar !== stack) {
      this._toolbar.hidden = true;
    }
    this._restack();
  },

  /* Slots our cards behind whatever the media controller is showing. Indices
     are recomputed from the DOM rather than remembered, so the controller
     restacking its own cards can never leave ours overlapping one. */
  _observeStack() {
    const stack = this._stack;
    if (!stack || !this._stackObserver || stack === this._toolbar) {
      return;
    }
    this._stackObserver.observe(stack, {
      attributeFilter: ["hidden"],
      childList: true,
    });
  },

  _restack() {
    const stack = this._stack;
    if (!stack || this._restacking) {
      return;
    }
    this._restacking = true;
    try {
      if (stack === this._toolbar) {
        // No media toolbar in this window: our fallback holder is the stack.
        stack.hidden = !stack.querySelector(".zen-page-card");
        return;
      }
      gZenCardStack.layout();
      // The last card out closes the bar; layout() only ever opens it.
      if (!gZenCardStack.occupied) {
        stack.setAttribute("hidden", "true");
      }
    } finally {
      // Drop the records our own writes just queued, then listen again.
      this._stackObserver?.takeRecords();
      this._restacking = false;
    }
  },

  _build(card, host) {
    const node = this._template.content.firstElementChild.cloneNode(true);
    /* The header mark, built here rather than in the template so the template
       stays the shape every other card in the stack has. */
    const header = node.querySelector(".zen-page-card-header");
    const badge = document.createElement("img");
    badge.className = "zen-page-card-badge";
    header.prepend(badge);
    /* A card that asked to arrive collapsed opens on its own header, so the
       whole compact row is the affordance and there is no second control. */
    const chevron = document.createXULElement("image");
    chevron.className = "zen-page-card-chevron";
    chevron.setAttribute("src", "chrome://global/skin/icons/arrow-down-12.svg");
    header.append(chevron);
    const toggleCollapsed = (event) => {
      if (
        !node.hasAttribute("collapsible") ||
        event.target?.closest?.(".zen-page-card-close")
      ) {
        return;
      }
      if (this._expanded.has(card.id)) {
        this._expanded.delete(card.id);
      } else {
        this._expanded.add(card.id);
      }
      this.refresh();
    };
    header.addEventListener("click", toggleCollapsed);
    this._activatable(header, toggleCollapsed);
    // The close button outlives every update, so it is wired once, here.
    // A toolbarbutton reports keyboard activation as "command", not "click" -
    // listening only for "click" would have left it visually focusable but
    // silently inert from the keyboard.
    const close = node.querySelector(".zen-page-card-close");
    document.l10n.setAttributes(close, "zen-page-card-close");
    close.addEventListener("command", () => {
      if (this._windowCards.has(card.id)) {
        // Dismissing the Activity card has to stick, or the next poll rebuilds
        // it a second later; anything new brings it back on its own.
        if (card.id === ACTIVITY_CARD_ID) {
          this._activityDismissedAt = Date.now();
        }
        this.clearWindowCard(card.id);
        return;
      }
      this.remove(gBrowser.selectedBrowser, card.id);
      this._send(card.id, null, "dismiss");
    });
    this._fill(node, card, host);
    return node;
  },

  /* Writes a payload into a card that already exists. Text is set in place and
     the rows are rebuilt only when they actually differ, so a card that gains a
     subtitle does not throw away eighteen rows to say so. */
  _fill(node, card, host) {
    node.setAttribute("card-id", card.id);
    /* Same resolution as a row's mark - the tab's host, or a name the card
       gave, never a URL - so an override lands on the header too. A card with
       no mark hides the badge rather than leaving a hole beside the title. */
    const badge = node.querySelector(".zen-page-card-badge");
    if (badge) {
      badge.hidden = !window.gZenSiteIcons?.paint(badge, {
        host,
        name: card.icon,
      });
    }
    if (card.accent) {
      node.style.setProperty("--zen-card-accent", card.accent);
    } else {
      node.style.removeProperty("--zen-card-accent");
    }
    const all = card.items || [];
    /* A `collapsed` card arrives as its header alone; opening it is the user's
       move, not the card's. Everything else keeps the old rule - three rows
       always out, the tail behind "show more". */
    const open = this._expanded.has(card.id);
    const shut = !!card.collapsed && !open;
    const expanded = card.collapsed
      ? open
      : open && all.length > COLLAPSED_ROWS;
    node.toggleAttribute("expanded", expanded);
    node.toggleAttribute("collapsible", !!card.collapsed);
    // Not `collapsed`: XUL's global [collapsed] rule is visibility: collapse,
    // which hides the whole card instead of just its rows.
    node.toggleAttribute("card-shut", shut);

    // The header is only an affordance - and only in the Tab order - while
    // clicking it actually does something.
    const header = node.querySelector(".zen-page-card-header");
    header.tabIndex = card.collapsed ? 0 : -1;
    if (card.collapsed) {
      header.setAttribute("aria-expanded", String(!shut));
    } else {
      header.removeAttribute("aria-expanded");
    }

    const items = node.querySelector(".zen-page-card-items");
    const signature = JSON.stringify([all, host, expanded, shut]);
    const rowsChanged = items.getAttribute("rows-signature") !== signature;
    if (rowsChanged && items.hasAttribute("rows-signature")) {
      this._activity.set(card.id, Date.now());
    }

    node.querySelector(".zen-page-card-title").textContent = card.title || "";
    const subtitle = node.querySelector(".zen-page-card-subtitle");
    const line = this._subtitle(card);
    if (line && line.id) {
      document.l10n.setAttributes(subtitle, line.id, line.args);
    } else {
      subtitle.removeAttribute("data-l10n-id");
      subtitle.textContent = line;
    }
    subtitle.hidden = !line || shut;

    if (rowsChanged) {
      const shown = shut ? [] : expanded ? all : all.slice(0, COLLAPSED_ROWS);
      const rows = shown.map((item) => this._row(card, item, host));
      if (!shut && all.length > COLLAPSED_ROWS) {
        rows.push(this._more(card, all.length - COLLAPSED_ROWS, expanded));
      }
      items.replaceChildren(...rows);
      items.setAttribute("rows-signature", signature);
    }
    items.hidden = shut || !all.length;
  },

  /* The tail of the list, as one row. Toggling goes through refresh() so the
     card is filled in place - opening it must not look like a new card. */
  _more(card, hidden, expanded) {
    const row = document.createXULElement("hbox");
    row.className = "zen-page-card-row zen-page-card-more";
    const label = document.createXULElement("label");
    label.className = "zen-page-card-label";
    if (expanded) {
      document.l10n.setAttributes(label, "zen-page-card-show-less");
    } else {
      document.l10n.setAttributes(label, "zen-page-card-show-more", { count: hidden });
    }
    row.append(label);
    row.tabIndex = 0;
    const toggle = () => {
      if (this._expanded.has(card.id)) {
        this._expanded.delete(card.id);
      } else {
        this._expanded.add(card.id);
      }
      this.refresh();
    };
    row.addEventListener("click", toggle);
    this._activatable(row, toggle);
    return row;
  },

  /* Site identity, not state: the mark says which site the row is on and never
     changes with it - the status word and its pulse carry that.

     The URL is resolved by us from the host of the tab, or from an icon *name*
     the page sent; a page never supplies a URL, so this can only ever point at
     one of our own SVGs or at the user's own override. */
  _mark(item, host) {
    const image = window.gZenSiteIcons?.createMark(
      document,
      { host, name: item.icon },
      "zen-page-card-dot",
    );
    if (image) {
      return image;
    }
    /* No mark for this row: a card that sent a glyph keeps its glyph, one that
       sent nothing keeps the plain status dot. */
    const dot = document.createXULElement(item.icon ? "label" : "box");
    dot.className = "zen-page-card-dot";
    if (item.icon) {
      dot.setAttribute("glyph", "true");
      dot.textContent = item.icon;
    }
    return dot;
  },

  _row(card, item, host) {
    const row = document.createXULElement("hbox");
    row.className = "zen-page-card-row";
    if (item.status) {
      row.setAttribute("status", item.status);
    }

    const dot = this._mark(item, host);

    const text = document.createXULElement("vbox");
    text.className = "zen-page-card-text";
    const label = document.createXULElement("label");
    label.className = "zen-page-card-label";
    label.textContent = item.label;
    text.append(label);
    if (item.detail) {
      const detail = document.createXULElement("label");
      detail.className = "zen-page-card-detail";
      detail.textContent = item.detail;
      text.append(detail);
    }
    row.append(dot, text);

    /* On the row, not inside `text` - that is a vbox, so a tag appended there
       stacks under the label instead of sitting beside it. */
    if (item.kind) {
      const tag = document.createXULElement("label");
      tag.className = "zen-page-card-kind";
      document.l10n.setAttributes(tag, "zen-page-card-kind", { kind: item.kind });
      row.append(tag);
    }

    /* The status is a word, not just an attribute to style on - "running" is
       the thing worth reading at a glance. */
    if (item.status) {
      const status = document.createXULElement("label");
      status.className = "zen-page-card-status";
      status.textContent = item.status;
      row.append(status);
    }

    if (item.progress >= 0) {
      const track = document.createXULElement("box");
      track.className = "zen-page-card-progress";
      const fill = document.createXULElement("box");
      fill.className = "zen-page-card-progress-fill";
      fill.style.width = `${Math.round(item.progress * 100)}%`;
      track.append(fill);
      text.append(track);
    }

    // The label is one ellipsised line, so the whole title lives in the tooltip.
    row.setAttribute(
      "tooltiptext",
      item.status ? `${item.label} — ${item.status}` : item.label,
    );
    const activate = () => {
      // Only a window card can hold a callback - those are built here, never
      // received from a page.
      if (
        this._windowCards.has(card.id) &&
        typeof card.activate === "function"
      ) {
        card.activate(item.key);
        return;
      }
      this._send(card.id, item.key, "activate");
    };
    row.tabIndex = 0;
    row.addEventListener("click", activate);
    this._activatable(row, activate);
    return row;
  },

  /* Back to the page that drew the card, never broadcast: the actor is looked
     up on the browser this card belongs to. */
  _send(cardId, key, action) {
    try {
      gBrowser.selectedBrowser.messageManager.sendAsyncMessage(
        "ZenCards:Action",
        {
          id: cardId,
          key,
          action,
        },
      );
    } catch (ex) {
      console.error("[zen] card action", ex);
    }
  },
};

window.addEventListener("MozAfterPaint", () => gZenPageCards.init(), {
  once: true,
});
