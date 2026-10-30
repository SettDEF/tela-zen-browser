/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/* The visible half of agent control. An agent driving a tab acts with the
 * user's cookies, so the rule here is that control is never held silently:
 * whenever the channel is up this window carries a marking the user did not
 * have to go looking for, and a stop that is one click away from it. */

const { ZenAgentChannel } = ChromeUtils.importESModule(
  "resource:///modules/zen/agent/ZenAgentChannel.sys.mjs"
);
const { ZenAgentLog } = ChromeUtils.importESModule(
  "resource:///modules/zen/agent/ZenAgentLog.sys.mjs"
);
const { ZenAgentTabs } = ChromeUtils.importESModule(
  "resource:///modules/zen/agent/ZenAgentTabs.sys.mjs"
);
const { ZenAgentPolicy } = ChromeUtils.importESModule(
  "resource:///modules/zen/agent/ZenAgentPolicy.sys.mjs"
);
const { ZenAgentIdentity } = ChromeUtils.importESModule(
  "resource:///modules/zen/agent/ZenAgentIdentity.sys.mjs"
);

const WIDGET_ID = "zen-agent-status-button";
const PANEL_ID = "zen-agent-panel";
const RECENT_ROWS = 8;

window.gZenAgentUI = {
  _lastMarking: null,

  init() {
    this._registerWidget();
    this._guardClose();
    Services.obs.addObserver(this, "zen-agent-state-changed");
    window.addEventListener(
      "unload",
      () => {
        try {
          Services.obs.removeObserver(this, "zen-agent-state-changed");
        } catch {}
      },
      { once: true }
    );
    this._update();
  },

  observe() {
    this._update();
  },

  /* A tab an agent is working in does not close on the first click of its ×:
     the × turns into a red pill ("Agent is using it · Close?") that a second click
     confirms. It folds back after a few seconds or when the pointer leaves the tab.
     Ordinary tabs, and agent tabs with no agent connected, close as always. */
  _guardClose() {
    const CONFIRM = "zen-agent-confirm-close";
    const inUse = tab =>
      tab?.hasAttribute?.("zen-agent") && this.mode !== "off" && ZenAgentChannel.sessionCount > 0;
    const fold = tab => {
      tab.removeAttribute(CONFIRM);
      window.clearTimeout(tab._zenAgentFold);
    };
    window.addEventListener(
      "click",
      event => {
        const btn = event.target?.closest?.(".tab-close-button");
        const tab = btn?.closest?.(".tabbrowser-tab");
        if (!btn || !inUse(tab) || event.button !== 0) {
          return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        let pill = tab.querySelector(".zen-agent-close-confirm");
        if (!pill) {
          pill = document.createElement("span");
          pill.className = "zen-agent-close-confirm";
          pill.setAttribute("role", "button");
          pill.textContent = "Agent is using it · Close?";
          document.l10n
            .formatValue("zen-agent-close-confirm")
            .then(v => { if (v) pill.textContent = v; })
            .catch(() => {});
          pill.addEventListener("click", e => {
            e.preventDefault();
            e.stopPropagation();
            fold(tab);
            gBrowser.removeTab(tab, { animate: true });
          });
          btn.after(pill);
          tab.addEventListener("mouseleave", () => fold(tab));
        }
        tab.setAttribute(CONFIRM, "true");
        window.clearTimeout(tab._zenAgentFold);
        tab._zenAgentFold = window.setTimeout(() => fold(tab), 4000);
      },
      true
    );
  },

  get mode() {
    return ZenAgentChannel.listening ? ZenAgentChannel.mode : "off";
  },

  // ---- the user's controls ----------------------------------------------

  // Stop switches the setting off; starting from the panel is the way back.
  _enable() {
    if (!ZenAgentPolicy.enabled) {
      Services.prefs.setBoolPref("zen.agent.enabled", true);
    }
  },

  async startAttended() {
    this._enable();
    Services.prefs.setBoolPref("zen.agent.enabled", true);
    await ZenAgentChannel.start("attended");
    this._update();
  },

  async startSilent() {
    this._enable();
    Services.prefs.setBoolPref("zen.agent.enabled", true);
    await ZenAgentChannel.start("silent");
    this._update();
  },

  /* The kill switch. Reachable from the widget in every layout, and from the
     panel; it revokes handles rather than merely closing the panel. */
  async stop() {
    await ZenAgentChannel.revoke("user");
    // Off until turned on again: stopped 14 times, it was back every launch.
    Services.prefs.setBoolPref("zen.agent.enabled", false);
    this._update();
  },

  // ---- marking -----------------------------------------------------------

  _marker() {
    let marker = document.getElementById("zen-agent-marker");
    if (!marker) {
      const ns = "http://www.w3.org/1999/xhtml";
      marker = document.createElementNS(ns, "div");
      marker.id = "zen-agent-marker";
      const frame = document.createElementNS(ns, "div");
      frame.className = "zen-agent-frame";
      const pill = document.createElementNS(ns, "div");
      pill.className = "zen-agent-pill";
      marker.append(frame, pill);
      document.documentElement.append(marker);
    }
    return marker;
  },

  _busy: new WeakMap(),

  /* The loading pill, in the agent's colour, over the tab it is working in.
     Shown after a beat, so a call that is refused at once never flashes it. */
  busy(tab, verb, client, on) {
    this._working(on);
    const state = this._busy.get(tab) || { n: 0, bar: null, timer: null };
    state.n += on ? 1 : -1;
    this._busy.set(tab, state);
    if (state.n > 0) {
      state.timer ??= setTimeout(() => {
        if (state.n > 0 && !state.bar) {
          state.bar = this._showBusy(tab, verb, client);
        }
      }, 150);
      return;
    }
    clearTimeout(state.timer);
    this._busy.delete(tab);
    const bar = state.bar;
    if (bar) {
      bar.removeAttribute("active");
      setTimeout(() => bar.remove(), 300);
    }
  },

  /* The frame and bottom pill say "an agent is acting now", so they show only
     while a call runs and a few seconds after. Being switched on is the
     toolbar button's job; marking the window for that was just noise. */
  _inflight: 0,
  _working(on) {
    this._inflight = Math.max(0, this._inflight + (on ? 1 : -1));
    const root = document.documentElement;
    clearTimeout(this._workingTimer);
    if (this._inflight > 0) {
      root.setAttribute("zen-agent-working", "true");
      return;
    }
    this._workingTimer = setTimeout(
      () => root.removeAttribute("zen-agent-working"),
      6000
    );
  },

  _showBusy(tab, verb, client) {
    const panel = document.getElementById(tab.linkedPanel);
    if (!panel) {
      return null;
    }
    const bar = document.createXULElement("hbox");
    bar.className = "zen-agent-progress";
    bar.setAttribute("role", "progressbar");
    bar.style.setProperty(
      "--zen-agent-accent",
      tab.style.getPropertyValue("--zen-agent-accent") ||
        ZenAgentIdentity.accentFor(client)
    );
    const id = {
      navigate: "zen-agent-busy-navigate",
      readPage: "zen-agent-busy-read",
      screenshot: "zen-agent-busy-screenshot",
    }[verb];
    document.l10n.setAttributes(
      bar,
      client ? `${id}-named` : id,
      client ? { client } : undefined
    );
    panel.prepend(bar);
    requestAnimationFrame(() => bar.setAttribute("active", "true"));
    return bar;
  },

  /* Mirrors an agent tab's mark onto the horizontal strip's parallel DOM. The
     strip builds its own rows, so a tab attribute alone reaches the vertical
     sidebar and nothing else. */
  markTab(tab, identity) {
    if (identity?.name) {
      /* Named in the tooltip as well as coloured: the hue says which
         assistant only to someone who can see it. */
      tab.setAttribute(
        "tooltiptext",
        `${identity.name} \u2014 agent tab`
      );
    }
    try {
      window.gZenHorizontalTabs?.refreshTab?.(tab);
    } catch {}
  },

  _update() {
    const mode = this.mode;
    const sessions = ZenAgentChannel.sessionCount;
    const active = ZenAgentChannel.lastActive;
    const client = active?.client || "";
    const accent = active?.accent || ZenAgentIdentity.accentFor("");
    const marking = `${mode}/${sessions}/${client}`;
    if (marking === this._lastMarking) {
      return;
    }
    this._lastMarking = marking;

    const root = document.documentElement;
    if (mode === "off") {
      root.removeAttribute("zen-agent");
      root.style.removeProperty("--zen-agent-accent");
    } else {
      root.setAttribute("zen-agent", mode);
      root.style.setProperty("--zen-agent-accent", accent);
    }
    const pill = this._marker().querySelector(".zen-agent-pill");
    /* The pill names the assistant when one has identified itself, so the
       colour is never the only thing carrying who is driving. */
    document.l10n.setAttributes(
      pill,
      mode === "off"
        ? "zen-agent-marker-off"
        : client
          ? mode === "attended"
            ? "zen-agent-marker-attended-named"
            : "zen-agent-marker-silent-named"
          : mode === "attended"
            ? "zen-agent-marker-attended"
            : "zen-agent-marker-silent",
      client ? { client } : undefined
    );
    if (document.getElementById(PANEL_ID)?.state === "open") {
      this._fillPanel();
    }
  },

  // ---- widget and panel --------------------------------------------------

  _registerWidget() {
    if (
      CustomizableUI.getWidget(WIDGET_ID)?.provider ===
      CustomizableUI.PROVIDER_API
    ) {
      return;
    }
    try {
      CustomizableUI.createWidget({
        id: WIDGET_ID,
        type: "custom",
        l10nId: WIDGET_ID,
        defaultArea: CustomizableUI.AREA_NAVBAR,
        onBuild(doc) {
          const button = doc.createXULElement("toolbarbutton");
          button.id = WIDGET_ID;
          button.className = "toolbarbutton-1 chromeclass-toolbar-additional";
          doc.l10n.setAttributes(button, WIDGET_ID);
          button.setAttribute("removable", "true");
          button.addEventListener("command", () =>
            doc.defaultView.gZenAgentUI?.togglePanel()
          );
          return button;
        },
      });
    } catch (ex) {
      console.error("[zen-agent] could not register the status widget", ex);
    }
  },

  togglePanel() {
    const panel = this._panel();
    if (panel.state === "open") {
      panel.hidePopup();
      return;
    }
    this._fillPanel();
    const anchor =
      document.getElementById(WIDGET_ID) ||
      document.getElementById("PanelUI-menu-button");
    /* after_start, not a centred anchoring: the widget can sit anywhere the
       user dropped it, and centring pushed the panel off the left edge when
       it sat near one. */
    panel.openPopup(anchor, "after_start", 0, 4, false, false);
  },

  _panel() {
    let panel = document.getElementById(PANEL_ID);
    if (panel) {
      return panel;
    }
    panel = document.createXULElement("panel");
    panel.id = PANEL_ID;
    panel.setAttribute("type", "arrow");
    panel.setAttribute("orient", "vertical");
    panel.setAttribute("noautofocus", "true");

    const body = document.createXULElement("vbox");
    body.id = "zen-agent-panel-body";
    panel.append(body);
    document.getElementById("mainPopupSet")?.append(panel);
    return panel;
  },

  async _fillPanel() {
    const body = document.getElementById("zen-agent-panel-body");
    if (!body) {
      return;
    }
    body.textContent = "";
    const mode = this.mode;

    const state = document.createXULElement("description");
    state.className = "zen-agent-panel-state";
    document.l10n.setAttributes(
      state,
      mode === "attended"
        ? "zen-agent-panel-state-attended"
        : mode === "silent"
          ? "zen-agent-panel-state-silent"
          : "zen-agent-panel-state-off"
    );
    body.append(state);

    for (const entry of ZenAgentChannel.clients) {
      const row = document.createXULElement("description");
      row.className = "zen-agent-client-row";
      row.style.setProperty("--zen-agent-accent", entry.accent);
      document.l10n.setAttributes(row, "zen-agent-panel-client", {
        client: entry.name || "?",
      });
      body.append(row);
    }

    if (mode === "silent") {
      const tabs = ZenAgentTabs.list();
      if (tabs.length) {
        const jump = document.createXULElement("button");
        document.l10n.setAttributes(jump, "zen-agent-panel-show-tab");
        /* Selecting the agent's tab is the user's action, never the agent's:
           this is the "findable" half of silent mode. */
        jump.addEventListener("command", () => {
          gBrowser.selectedTab = tabs[0];
          this._panel().hidePopup();
        });
        body.append(jump);
      }
    }

    /* Off: the way back on, here where the state is shown. Before, the panel
       said "Off" and offered nothing; after a Stop only a restart helped. */
    if (mode === "off") {
      {
        const silent = document.createXULElement("button");
        silent.className = "zen-agent-start";
        document.l10n.setAttributes(silent, "zen-agent-panel-start-silent");
        silent.addEventListener("command", async () => {
          await this.startSilent();
          this._fillPanel();
        });
        const attended = document.createXULElement("button");
        document.l10n.setAttributes(attended, "zen-agent-panel-start-attended");
        attended.addEventListener("command", async () => {
          await this.startAttended();
          this._fillPanel();
        });
        body.append(silent, attended);
      }
    }

    if (mode !== "off") {
      const stop = document.createXULElement("button");
      stop.className = "zen-agent-stop";
      document.l10n.setAttributes(stop, "zen-agent-panel-stop");
      stop.addEventListener("command", () => {
        this.stop();
        this._panel().hidePopup();
      });
      body.append(stop);
    }

    const heading = document.createXULElement("label");
    heading.className = "zen-agent-panel-heading";
    document.l10n.setAttributes(heading, "zen-agent-panel-recent");
    body.append(heading);

    await ZenAgentLog.init();
    // What an agent did; switching it on and off stays in the file only.
    const entries = ZenAgentLog.entries
      .filter((e) => e.verb !== "start" && e.verb !== "revoke")
      .slice(-RECENT_ROWS)
      .reverse();
    if (!entries.length) {
      const empty = document.createXULElement("description");
      document.l10n.setAttributes(empty, "zen-agent-panel-empty");
      body.append(empty);
      return;
    }
    for (const entry of entries) {
      const row = document.createXULElement("description");
      row.className = "zen-agent-log-row";
      row.setAttribute("outcome", entry.outcome || "");
      if (entry.outcome === "refused") {
        document.l10n.setAttributes(row, "zen-agent-log-entry-refused", {
          verb: entry.verb || "?",
          reason: entry.code || "other",
          client: entry.client || "?",
        });
      } else {
        document.l10n.setAttributes(row, "zen-agent-log-entry-ok", {
          verb: entry.verb || "?",
          host: entry.host || entry.url || "—",
          client: entry.client || "?",
        });
      }
      body.append(row);
    }
  },
};

/* The widget has to exist before the user could need it, and the marking
   before any agent could be holding control. */
window.addEventListener("MozAfterPaint", () => gZenAgentUI.init(), {
  once: true,
});
