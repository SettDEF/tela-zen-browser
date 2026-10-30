// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at http://mozilla.org/MPL/2.0/.

/* The sidebar card stack, and the only thing that writes it.
 *
 * The media controller and the Activity reader both put cards in the same
 * toolbar, so who is in front, who peeks out behind, how tall the collapsed
 * bar is and whether it is open at all are facts about all of them together.
 * Each producer registers a source of cards, front first, and calls layout().
 * Two producers computing this separately raced and left one pile slotted
 * against a count that did not include the other. */

// Cards shown at all; deeper ones hide until a slot frees up.
const MAX_STACKED = 3;
// Cards that peek out behind the front one.
const MAX_PEEK = 2;

// Rest this long on the stack and it opens; it stays open until the pointer
// leaves for LEAVE_MS, so crossing an edge on the way back up does not fold it.
const DWELL_MS = 400;
const LEAVE_MS = 350;

window.gZenCardStack = {
  _sources: [],
  _laying: false,

  get bar() {
    return document.getElementById("zen-media-controls-toolbar");
  },

  // Asked in registration order, so the media cards lead the stack.
  register(source) {
    if (!this._sources.includes(source)) {
      this._sources.push(source);
    }
    this._mirrorEvery ??= setInterval(() => this.mirror(), 5000);
    // Also once the sidebar has slid in: a short hover fell between samples.
    this._hoverWatch ??= new MutationObserver(() => setTimeout(() => this.mirror(), 450));
    const tb = document.getElementById("navigator-toolbox");
    if (tb) {
      this._hoverWatch.observe(tb, { attributeFilter: ["zen-has-hover"] });
    }
    if (!this._reportKey) {
      this._reportKey = true;
      window.addEventListener("keydown", (e) => {
        if (e.ctrlKey && e.altKey && e.shiftKey && e.code === "KeyC") {
          e.preventDefault();
          e.stopPropagation();
          this.report().catch((err) => console.error("zen cards: report", err));
        }
      }, true);
    }
  },

  /* Ctrl+Alt+Shift+C when a card looks wrong: writes zen-cards-report-<time>
     .json/.png to the profile. The png is the browser's own fresh render of
     the sidebar, not the screen: if it shows the card while the screen does
     not, the fault is in painting, not in our state. Then the cards are forced
     to repaint and the person is asked whether that brought them back. */
  async report() {
    const bar = this.bar;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const base = PathUtils.join(PathUtils.profileDir, `zen-cards-report-${stamp}`);
    const PROPS = ["opacity", "visibility", "display", "transform", "filter", "clip-path", "will-change",
      "contain", "content-visibility", "isolation", "overflow", "z-index", "translate", "scale", "mask-image"];
    const style = (el) => {
      const cs = window.getComputedStyle(el);
      const out = {};
      for (const p of PROPS) {
        const v = cs.getPropertyValue(p);
        if (v && !["none", "auto", "normal", "visible", "1", "0"].includes(v) || p === "opacity" || p === "display") {
          out[p] = v.slice(0, 80);
        }
      }
      return out;
    };
    const name = (e) => e.id || `${e.localName}.${String(e.className || "").split(" ")[0]}`;
    const cards = this.cards().filter((el) => el?.isConnected).map((el) => {
      const r = el.getBoundingClientRect();
      const ancestors = [];
      for (let e = el.parentElement; e && e !== document.documentElement && ancestors.length < 12; e = e.parentElement) {
        const rr = e.getBoundingClientRect();
        ancestors.push({ el: name(e), rect: [rr.left, rr.top, rr.width, rr.height].map(Math.round), style: style(e) });
      }
      const points = [[0.5, 0.5], [0.15, 0.5], [0.85, 0.5]].map(([fx, fy]) =>
        r.width ? document.elementsFromPoint(r.left + r.width * fx, r.top + r.height * fy).slice(0, 6).map(name) : []);
      return {
        el: name(el),
        attrs: Array.from(el.attributes, (a) => `${a.name}=${a.value.slice(0, 30)}`),
        rect: [r.left, r.top, r.width, r.height].map(Math.round),
        style: style(el),
        inner: el.firstElementChild ? style(el.firstElementChild) : null,
        animations: el.getAnimations({ subtree: true }).map((a) => ({
          name: a.animationName || a.transitionProperty || a.id || "?",
          on: a.effect?.target ? name(a.effect.target) : null,
          state: a.playState,
          time: Math.round(a.currentTime ?? -1),
          progress: a.effect?.getComputedTiming?.().progress,
        })),
        atPoints: points,
        ancestors,
      };
    });
    const tb = document.getElementById("navigator-toolbox");
    const report = {
      at: new Date().toISOString(),
      version: Services.appinfo.version,
      dpr: window.devicePixelRatio,
      selected: (gBrowser.selectedTab.label || "").slice(0, 60),
      compact: window.gZenCompactModeManager?.preference,
      toolbox: { attrs: Array.from(tb.attributes, (a) => a.name), style: style(tb),
        rect: (() => { const r = tb.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round); })() },
      bar: bar ? { hidden: bar.hidden, attrs: Array.from(bar.attributes, (a) => a.name), style: style(bar),
        vars: ["--zen-media-reveal", "--zen-media-collapsed-height", "--zen-media-expanded-height"]
          .map((v) => `${v}: ${bar.style.getPropertyValue(v)}`) } : null,
      media: gBrowser.tabs.filter((t) => t.linkedBrowser.browsingContext?.mediaController?.isActive).map((t) => ({
        tab: (t.label || "").slice(0, 40), selected: t.selected,
        playing: t.linkedBrowser.browsingContext.mediaController.isPlaying,
        fullscreenOrPip: t.linkedBrowser.browsingContext.mediaController.isBeingUsedInPIPModeOrFullscreen,
      })),
      cards,
      history: this._history || [],
      trace: window.gZenMediaController?.recentTrace?.(200) || [],
    };
    // The browser's own render of the sidebar, right now.
    try {
      const r = tb.getBoundingClientRect();
      const dpr = window.devicePixelRatio;
      const canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
      canvas.width = Math.ceil(r.width * dpr);
      canvas.height = Math.ceil(r.height * dpr);
      const ctx = canvas.getContext("2d");
      ctx.scale(dpr, dpr);
      ctx.drawWindow(window, r.left, r.top, r.width, r.height, "rgb(255,0,255)");
      const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
      await IOUtils.write(base + ".png", new Uint8Array(await blob.arrayBuffer()));
      report.render = base + ".png";
    } catch (e) {
      report.render = `failed: ${e}`;
    }
    await IOUtils.writeJSON(base + ".json", report);

    // Force a repaint of every card, then ask.
    const forced = this.cards().filter((el) => el?.isConnected);
    for (const el of forced) {
      el.style.setProperty("filter", "none", "important");
      el.style.setProperty("will-change", "auto", "important");
      el.getBoundingClientRect();
    }
    const answer = async (what) => {
      for (const el of forced) {
        el.style.removeProperty("filter");
        el.style.removeProperty("will-change");
      }
      report.afterRepaint = what;
      await IOUtils.writeJSON(base + ".json", report).catch(() => {});
    };
    const box = window.gNotificationBox;
    if (!box) {
      return base;
    }
    const n = await box.appendNotification("zen-cards-report", {
      label: `Card report saved (${PathUtils.filename(base)}). The cards were just repainted: is the card visible now?`,
      priority: box.PRIORITY_INFO_HIGH,
      eventCallback: (ev) => ev === "dismissed" && !report.afterRepaint && answer("no answer"),
    }, [
      { label: "Yes, it came back", callback: () => { answer("visible"); } },
      { label: "No, still missing", callback: () => { answer("still missing"); } },
    ]);
    n?.setAttribute?.("data-zen-cards-report", base);
    return base;
  },

  /* Read-only mirror of the stack, so it can be watched on the user's own
     profile: zen-cards-live.json is the latest state, zen-cards-events.jsonl
     each change. Nothing here alters the stack. */
  mirror() {
    this._mirrorTimer ??= setTimeout(() => {
      this._mirrorTimer = null;
      this._writeMirror().catch(() => {});
    }, 250);
  },

  async _writeMirror() {
    const bar = this.bar;
    if (!bar) {
      return;
    }
    const b = bar.getBoundingClientRect();
    const barOpacity = +window.getComputedStyle(bar).opacity;
    const seen = (el) => {
      if (!el || el.hidden || el.matches("[zen-hiding],[zen-removing],[stack-overflow]")) {
        return false;
      }
      const r = el.getBoundingClientRect();
      return r.height >= 8 && +window.getComputedStyle(el).opacity * barOpacity > 0.2 &&
        r.bottom > b.top + 4 && r.top < b.bottom - 4;
    };
    const tabFor = (id) => gBrowser.tabs.find((t) => String(t.linkedBrowser.browserId) === id);
    const sel = gBrowser.selectedBrowser;
    const all = this._sources.flatMap((source) => (source() || []).filter((el) => el?.isConnected));
    const cards = all.map((el, index) => {
      const isMedia = el.classList.contains("zen-media-card");
      const owner = isMedia ? tabFor(el.getAttribute("zen-owner")) : null;
      const r = el.getBoundingClientRect();
      /* What is actually drawn at the card's centre: "seen" only measures
         the card, so a card under the tab list still counted as visible. */
      let covered = null;
      if (r.width && r.height) {
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        // Under another card is how a stacked card rests, not a fault.
        if (top && !el.contains(top) && !(el.hasAttribute("stacked-behind") && top.closest(".zen-stack-card"))) {
          const chain = [];
          for (let e = top; e && chain.length < 5; e = e.parentElement) {
            chain.push(e.id || `${e.localName}.${String(e.className || "").split(" ")[0]}`);
          }
          covered = chain.join(" < ");
        }
      }
      const cs = window.getComputedStyle(el);
      return {
        index,
        covered,
        style: [cs.opacity, cs.visibility, cs.transform.slice(0, 40), cs.zIndex].join(" | "),
        inner: el.firstElementChild ? (() => {
          const ic = window.getComputedStyle(el.firstElementChild);
          return [ic.opacity, ic.visibility, ic.display].join(" | ");
        })() : null,
        kind: isMedia ? "media" : el.textContent.includes("Activity") ? "activity" : "page",
        tab: isMedia ? (owner?.label || "?").slice(0, 40) : el.textContent.replace(/\s+/g, " ").trim().slice(0, 40),
        playing: isMedia ? el.classList.contains("playing") : undefined,
        hidden: el.hidden,
        attrs: Array.from(el.attributes, (a) => a.name).filter((n) => /^(zen-|stack|hidden)/.test(n)).join(" "),
        rect: [r.left, r.top, r.width, r.height].map(Math.round),
        seen: seen(el),
      };
    });
    const bg = gBrowser.tabs.filter((t) => t.linkedBrowser !== sel);
    const playing = bg.filter((t) => t.linkedBrowser.browsingContext?.mediaController?.isPlaying);
    const answering = bg.filter((t) => window.gZenPageCards?._tabs?.get(t.linkedBrowser)?.running);
    const tb = document.getElementById("navigator-toolbox");
    const sidebarShown = tb.getBoundingClientRect().right > 20;
    const problems = [];
    if (window.gZenMediaController?.healBar?.()) {
      problems.push("bar was stuck transparent (healed)");
    }
    if (sidebarShown) {
      for (const c of cards) {
        if (c.seen && c.covered) {
          problems.push(`card covered (${c.tab.slice(0, 20)}) by ${c.covered}`);
        }
      }
      for (const t of playing) {
        const card = cards.find((c) => c.kind === "media" && c.tab === t.label.slice(0, 40));
        if (!card?.seen) {
          problems.push(`playing not visible: ${t.label.slice(0, 30)}${card ? "" : " (no card)"}`);
        }
      }
      if (answering.length && !cards.some((c) => c.kind === "activity" && c.seen)) {
        problems.push(`answering chat, no visible Activity card (${answering.length})`);
      }
    }
    const state = {
      at: new Date().toISOString(),
      selected: (gBrowser.selectedTab.label || "").slice(0, 40),
      compact: window.gZenCompactModeManager?.preference,
      sidebarShown,
      hover: tb.hasAttribute("zen-has-hover"),
      bar: { hidden: bar.hidden, rect: [b.left, b.top, b.width, b.height].map(Math.round),
        style: (() => {
          const bc = window.getComputedStyle(bar);
          return [bc.opacity, bc.visibility, bc.display, bar.matches(":hover") ? "hover" : "",
            bar.matches(":focus-within") ? "focus" : "", bar.style.getPropertyValue("--zen-media-reveal")].join(" | ");
        })() },
      list: (() => {
        const w = document.getElementById("zen-tabs-wrapper")?.getBoundingClientRect();
        return w ? [w.left, w.top, w.width, w.height].map(Math.round) : null;
      })(),
      playing: playing.map((t) => t.label.slice(0, 40)),
      answering: answering.map((t) => t.label.slice(0, 40)),
      cards,
      problems,
      trace: window.gZenMediaController?.recentTrace?.() || [],
    };
    this._history = [...(this._history || []).slice(-19),
      { at: state.at, selected: state.selected, hover: state.hover, bar: state.bar.style, problems,
        cards: cards.map((c) => [c.kind, c.tab.slice(0, 20), c.seen, c.style, c.covered]) }];
    const dir = PathUtils.profileDir;
    await IOUtils.writeJSON(PathUtils.join(dir, "zen-cards-live.json"), state, {
      tmpPath: PathUtils.join(dir, "zen-cards-live.json.tmp"),
    });
    // History only when something a person would notice changed.
    const sig = JSON.stringify([state.selected, state.sidebarShown, state.bar.hidden, problems,
      cards.map((c) => [c.kind, c.tab, c.playing, c.seen, c.index])]);
    if (sig === this._lastSig) {
      return;
    }
    this._lastSig = sig;
    const events = PathUtils.join(dir, "zen-cards-events.jsonl");
    try {
      if ((await IOUtils.stat(events)).size > 2 * 1024 * 1024) {
        await IOUtils.move(events, events + ".1");
      }
    } catch {}
    await IOUtils.writeUTF8(events, JSON.stringify(state) + "\n", { mode: "appendOrCreate" });
  },

  cards() {
    const out = [];
    for (const source of this._sources) {
      for (const el of source() || []) {
        if (el && !el.hidden && el.isConnected) {
          out.push(el);
        }
      }
    }
    return out;
  },

  get occupied() {
    return !!this.cards().length;
  },

  layout() {
    const bar = this.bar;
    if (!bar || this._laying) {
      return;
    }
    this._laying = true;
    try {
      const cards = this.cards();
      cards.forEach((el, index) => {
        el.toggleAttribute("stack-overflow", index >= MAX_STACKED);
        el.toggleAttribute("stacked-behind", index > 0);
        el.setAttribute("zen-reindexing", "true");
        el.style.setProperty("--zen-media-card-index", index);
        el.style.zIndex = 100 - index;
      });
      // Flush, so the re-slotting lands before the peek is animated: a demoted
      // card then slides up from behind the front one, not in from above.
      bar.getBoundingClientRect();
      cards.forEach((el, index) => {
        el.removeAttribute("zen-reindexing");
        el.style.setProperty(
          "--zen-media-card-peek-level",
          Math.min(index, MAX_PEEK),
        );
        // Alternating tilt, so the resting stack reads as a deck.
        el.style.setProperty("--zen-media-card-tilt", index % 2 ? -1 : 1);
      });
      const stacked = Math.min(cards.length, MAX_STACKED);
      bar.style.setProperty(
        "--zen-media-stack-behind",
        Math.max(Math.min(stacked - 1, MAX_PEEK), 0),
      );
      /* Unhidden first, and the measuring guarded: both of those run before
         this used to, so anything they threw left the bar hidden and every
         card vanished. Sizing may be wrong for a frame; it must never be the
         reason the stack is invisible. */
      if (cards.length) {
        bar.removeAttribute("hidden");
      }
      /* Growing on hover only makes sense with something behind the front card
         to reveal. With one card or none, a leftover expanded height turned the
         hovered bar into an empty band pushed up into the tab list. */
      const multi = cards.length >= 2;
      bar.toggleAttribute("zen-stack-multi", multi);
      if (!multi) {
        bar.style.removeProperty("--zen-media-expanded-height");
      }
      try {
        this.measure(cards[0]);
        this.watchReveal();
      } catch (error) {
        console.error("ZenCardStack: measuring failed", error);
      }
      window.gZenUIManager?.updateTabsToolbar();
    } finally {
      this._laying = false;
    }
    this.mirror();
  },

  /* Dwell, not pointer depth. Depth had to be read in the collapsed stack's
     coordinates, where cards sit 8px apart, so aiming at the third one barely
     registered and revealing pushed it further away. Resting on the stack for
     DWELL_MS opens it fully and it stays open until the pointer really leaves. */
  watchReveal() {
    const bar = this.bar;
    if (!bar || bar._zenRevealWatched) {
      return;
    }
    bar._zenRevealWatched = true;
    let dwell = 0;
    let leaving = 0;

    const open = () => {
      dwell = 0;
      bar.style.setProperty("--zen-media-reveal", String(this.cards().length));
    };
    const arm = () => {
      window.clearTimeout(leaving);
      leaving = 0;
      if (dwell || bar.style.getPropertyValue("--zen-media-reveal")) {
        return;
      }
      dwell = window.setTimeout(open, DWELL_MS);
    };

    bar.addEventListener("pointerenter", arm);
    bar.addEventListener("pointermove", arm);
    /* Held briefly: moving up the stack crosses its top edge and fires
       pointerleave, and folding instantly made an upper card a race. */
    bar.addEventListener("pointerleave", () => {
      // A menu opened from a card holds the stack open (see hold()).
      if (this._held) {
        return;
      }
      window.clearTimeout(dwell);
      dwell = 0;
      window.clearTimeout(leaving);
      leaving = window.setTimeout(() => {
        leaving = 0;
        bar.style.removeProperty("--zen-media-reveal");
        this._remeasureSoon();
      }, LEAVE_MS);
    });
  },

  /* Keeps the stack open while a menu from one of its cards is up: the
     pointer leaves for the menu, and folding then moved the card it belongs
     to out from under it. Released when the menu closes. */
  hold(on) {
    const bar = this.bar;
    if (!bar || this._held === on) {
      return;
    }
    this._held = on;
    if (on) {
      InspectorUtils.addPseudoClassLock(bar, ":hover");
      bar.style.setProperty("--zen-media-reveal", String(this.cards().length));
      return;
    }
    InspectorUtils.removePseudoClassLock(bar, ":hover");
    if (!bar.matches(":hover")) {
      bar.style.removeProperty("--zen-media-reveal");
      this._remeasureSoon();
    }
  },

  // After the cards' fold transition (0.3s), if a measure was skipped.
  _remeasureSoon() {
    if (!this._stale) {
      return;
    }
    window.clearTimeout(this._remeasureTimer);
    this._remeasureTimer = window.setTimeout(() => {
      const front = this.cards()[0];
      if (front && !this.bar?.matches(":hover, :focus-within")) {
        this.measure(front);
      }
    }, 350);
  },

  // The bar keeps the front card's height whatever is stacked behind it.
  measure(front) {
    const bar = this.bar;
    if (!bar || !front) {
      return;
    }
    const write = () => {
      const height = front.getBoundingClientRect().height;
      window.gZenMediaController?.trace?.(`measure ${Math.round(height)} (layout ${front.clientHeight})`);
      /* Hovered (or held), a card shows its title and progress rows: that
         height saved as the resting one left a band over the tab list once
         the hover ended. Measure again when the stack folds instead. */
      if (this._held || bar.matches(":hover, :focus-within")) {
        this._stale = true;
      } else if (height) {
        this._stale = false;
        bar.style.setProperty("--zen-media-collapsed-height", height + "px");
      }
      /* The hover state lays the cards out in flow, which overflows a box
         sized to the front card - so the pointer left the container, the
         hover dropped, and the stack snapped shut under the cursor. The
         expanded height gives the hit region somewhere to grow to. */
      const cards = this.cards();
      const gap = parseFloat(
        window.getComputedStyle(bar).getPropertyValue("--zen-media-stack-gap")
      ) || 6;
      /* A card behind is held at the front card's height while stacked; open,
         it takes its own. Summing the held heights made the bar too tall, and
         the spare showed up as a hole between the cards. */
      const own = (el) => {
        const cs = window.getComputedStyle(el);
        const inner = el.firstElementChild?.scrollHeight ?? el.scrollHeight;
        return inner + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      };
      const total = cards.reduce(
        (n, el, i) => n + (i ? own(el) : el.getBoundingClientRect().height) + gap,
        -gap);
      // Only a stack with something behind the front card has anything to grow to.
      if (total > 0 && cards.length >= 2) {
        bar.style.setProperty("--zen-media-expanded-height", total + "px");
      } else {
        bar.style.removeProperty("--zen-media-expanded-height");
      }
    };
    write();
    /* A card unhidden this tick has no box yet, and the height would stay
       whatever the card before it left behind - a too-tall peek strip. */
    window.requestAnimationFrame(write);
  },
};
