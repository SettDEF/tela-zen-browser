/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ZenAgentPolicy } from "resource:///modules/zen/agent/ZenAgentPolicy.sys.mjs";
import { ZenAgentTabs } from "resource:///modules/zen/agent/ZenAgentTabs.sys.mjs";
import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";

const NAVIGATE_TIMEOUT_MS = 45000;
// Verbs that work in a tab, and so show the user which one while they run.
const TAB_VERBS = new Set(["navigate", "readPage", "screenshot"]);

function topWindow() {
  return Services.wm.getMostRecentBrowserWindow();
}

/* Silent mode is the agent's own tabs and nothing else; attended adds the tab
   the user is looking at. Their other tabs are signed-in sessions the
   agent's container exists to keep it out of, so an id is not enough. */
function mayUse(tab, win) {
  if (ZenAgentTabs.isAgentTab(tab)) {
    return true;
  }
  return ZenAgentTabs.mode === "attended" && tab === win.gBrowser.selectedTab;
}

/* Resolves the tab a verb applies to. In attended mode an absent tabId means
   the tab the user is looking at right now, re-read on every call: if they
   switched tabs mid-session the agent follows them rather than holding a
   handle to where they used to be. */
function resolveTab(params, session) {
  const win = topWindow();
  if (!win?.gBrowser) {
    return { ok: false, reason: "no-window" };
  }
  if (params?.tabId != null) {
    const tab = ZenAgentTabs.byId(params.tabId);
    if (!tab || !tab.isConnected) {
      return { ok: false, reason: "no-such-tab" };
    }
    if (!mayUse(tab, win)) {
      return { ok: false, reason: "not-agent-tab" };
    }
    return { ok: true, tab, win: tab.ownerGlobal || win };
  }
  if (ZenAgentTabs.mode === "silent") {
    return { ok: false, reason: "tab-required" };
  }
  return { ok: true, tab: win.gBrowser.selectedTab, win };
}

function tabUrl(tab) {
  try {
    return tab.linkedBrowser?.currentURI?.spec || "";
  } catch {
    return "";
  }
}

/* A tab's URL is checked at the moment of the action, never cached: a page can
   navigate itself onto a guarded origin between two verbs, and a check done
   only at navigate time would miss it. */
function guardTab(tab) {
  const url = tabUrl(tab);
  const checked = ZenAgentPolicy.checkCurrent(url);
  if (!checked.ok) {
    return checked;
  }
  return { ok: true, url, host: checked.host };
}

export const ZenAgentActions = {
  _inflight: new Set(),

  abortAll() {
    for (const entry of [...this._inflight]) {
      try {
        entry.abort();
      } catch {}
    }
    this._inflight.clear();
  },

  async run(verb, params, session) {
    const target = TAB_VERBS.has(verb) ? resolveTab(params, session) : null;
    // ownerGlobal is undefined on Zen tabs; the document leads to the window.
    const ui = target?.ok
      ? target.tab.ownerDocument?.defaultView?.gZenAgentUI
      : null;
    const client = session?.client || "";
    try {
      ui?.busy?.(target.tab, verb, client, true);
    } catch {}
    try {
      return await this._run(verb, params, session);
    } finally {
      try {
        ui?.busy?.(target.tab, verb, client, false);
      } catch {}
    }
  },

  async _run(verb, params, session) {
    switch (verb) {
      case "status":
        return this.status();
      case "listTabs":
        return this.listTabs();
      case "newAgentTab":
        return this.newAgentTab(params, session);
      case "closeTab":
        return this.closeTab(params);
      case "navigate":
        return this.navigate(params, session);
      case "readPage":
        return this.readPage(params, session);
      case "screenshot":
        return this.screenshot(params, session);
      case "click":
      case "type":
      case "scroll":
        return { ok: false, reason: "not-implemented" };
      default:
        return { ok: false, reason: "unknown-verb" };
    }
  },

  status() {
    return {
      ok: true,
      result: {
        mode: ZenAgentTabs.mode,
        agentTabs: ZenAgentTabs.list().length,
        generation: ZenAgentPolicy.generation,
      },
    };
  },

  listTabs() {
    const win = topWindow();
    if (!win?.gBrowser) {
      return { ok: false, reason: "no-window" };
    }
    const tabs = [];
    // In silent mode the user's tabs are not the agent's business at all.
    const silent = ZenAgentTabs.mode === "silent";
    for (const tab of win.gBrowser.tabs) {
      if (silent && !ZenAgentTabs.isAgentTab(tab)) {
        continue;
      }
      const url = tabUrl(tab);
      let host = "";
      try {
        host = url ? new URL(url).hostname : "";
      } catch {}
      const guarded = ZenAgentPolicy.isGuardedHost(host);
      tabs.push({
        tabId: ZenAgentTabs.idFor(tab),
        /* A guarded tab is listed but its title and URL are withheld: the
           agent may know the tab exists without learning where the user
           banks. */
        url: guarded ? "" : url,
        title: guarded ? "" : tab.label || "",
        host: guarded ? "" : host,
        guarded,
        agentOwned: ZenAgentTabs.isAgentTab(tab),
        selected: tab.selected,
      });
    }
    return { ok: true, result: { tabs } };
  },

  newAgentTab(params, session) {
    /* The same gate navigate applies. Creating a tab at a URL is navigating to
       it, so without this a refused navigate("accounts.google.com") could just
       be retried as newAgentTab with the same URL. */
    const url = params?.url || "about:blank";
    const checked = ZenAgentPolicy.checkUrl(url);
    if (!checked.ok) {
      return checked;
    }
    const created = ZenAgentTabs.create(url, {
      name: session?.client || "",
      accent: session?.accent || "",
    });
    if (!created.ok) {
      return created;
    }
    return {
      ok: true,
      result: { tabId: created.tabId },
      tabId: created.tabId,
      url: created.url,
    };
  },

  closeTab(params) {
    const resolved = resolveTab(params, null);
    if (!resolved.ok) {
      return resolved;
    }
    if (!ZenAgentTabs.isAgentTab(resolved.tab)) {
      return { ok: false, reason: "not-agent-tab" };
    }
    ZenAgentTabs.close(resolved.tab);
    // say so when it is still there, rather than reporting a close that did not happen
    if (resolved.tab.isConnected) {
      return { ok: false, reason: "close-failed" };
    }
    return { ok: true, result: { closed: true } };
  },

  /* Local extraction, always. The browser is already the renderer: the page is
     laid out, script has run and the user is signed in, so reading here beats
     round-tripping a URL through a third party — and it hands nobody a list of
     what the user reads. */
  async readPage(params, session) {
    const resolved = resolveTab(params, session);
    if (!resolved.ok) {
      return resolved;
    }
    const { tab } = resolved;
    const guarded = guardTab(tab);
    if (!guarded.ok) {
      return guarded;
    }
    const scheme = ZenAgentPolicy.checkUrl(guarded.url || "about:blank");
    if (!scheme.ok) {
      return scheme;
    }
    let actor;
    try {
      actor = tab.linkedBrowser.browsingContext.currentWindowGlobal.getActor(
        "ZenAgent"
      );
    } catch (ex) {
      return { ok: false, reason: "no-actor", detail: String(ex) };
    }
    const generation = ZenAgentPolicy.generation;
    let page;
    try {
      page = await actor.sendQuery("ZenAgent:ReadPage", {});
    } catch (ex) {
      return { ok: false, reason: "read-failed", detail: String(ex) };
    }
    if (!ZenAgentPolicy.isCurrent(generation)) {
      return { ok: false, reason: "revoked" };
    }
    if (!page?.ok) {
      return { ok: false, reason: page?.reason || "read-failed" };
    }
    return {
      ok: true,
      url: guarded.url,
      host: guarded.host,
      result: {
        title: page.title,
        byline: page.byline,
        siteName: page.siteName,
        url: page.url,
        extractor: page.extractor,
        truncated: page.truncated,
        /* Page text is data, never instruction. It is labelled untrusted on
           the way out whatever the scan found, because the scan is a
           heuristic and the label is the actual control. */
        untrusted: true,
        injectionSuspected: page.flagged,
        markdown: page.markdown,
      },
    };
  },

  /* Captures the tab, never the desktop: the agent is being given a view of a
     page the user could already see, not of their screen. */
  async screenshot(params, session) {
    const resolved = resolveTab(params, session);
    if (!resolved.ok) {
      return resolved;
    }
    const { tab } = resolved;
    const guarded = guardTab(tab);
    if (!guarded.ok) {
      return guarded;
    }
    // The host guard cannot see about:config or file://, which have no host.
    const scheme = ZenAgentPolicy.checkUrl(guarded.url || "about:blank");
    if (!scheme.ok) {
      return scheme;
    }
    const generation = ZenAgentPolicy.generation;
    let dataURL;
    try {
      const global = tab.linkedBrowser.browsingContext.currentWindowGlobal;
      const bitmap = await global.drawSnapshot(null, 1, "rgb(255,255,255)");
      const canvas = resolved.win.document.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "canvas"
      );
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      dataURL = canvas.toDataURL("image/png");
      bitmap.close?.();
    } catch (ex) {
      return { ok: false, reason: "screenshot-failed", detail: String(ex) };
    }
    if (!ZenAgentPolicy.isCurrent(generation)) {
      return { ok: false, reason: "revoked" };
    }
    return {
      ok: true,
      url: guarded.url,
      host: guarded.host,
      result: { png: dataURL, url: guarded.url },
    };
  },

  async navigate(params, session) {
    const target = params?.url;
    const checked = ZenAgentPolicy.checkUrl(target || "");
    if (!checked.ok) {
      return checked;
    }
    const resolved = resolveTab(params, session);
    if (!resolved.ok) {
      return resolved;
    }
    const { tab } = resolved;
    const current = guardTab(tab);
    if (!current.ok) {
      return current;
    }

    const browser = tab.linkedBrowser;
    const generation = ZenAgentPolicy.generation;
    const principal = Services.scriptSecurityManager.getSystemPrincipal();

    return new Promise(resolve => {
      let settled = false;
      let started = false;
      const entry = {
        abort: () => {
          try {
            browser.stop();
          } catch {}
          finish({ ok: false, reason: "revoked" });
        },
      };
      this._inflight.add(entry);

      const finish = outcome => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this._inflight.delete(entry);
        try {
          browser.removeProgressListener(listener);
        } catch {}
        resolve(outcome);
      };

      const timer = setTimeout(() => {
        try {
          browser.stop();
        } catch {}
        finish({ ok: false, reason: "navigate-timeout" });
      }, NAVIGATE_TIMEOUT_MS);

      const listener = {
        QueryInterface: ChromeUtils.generateQI([
          "nsIWebProgressListener",
          "nsISupportsWeakReference",
        ]),
        onStateChange(progress, request, flags, status) {
          const WPL = Ci.nsIWebProgressListener;
          if (!progress.isTopLevel || !(flags & WPL.STATE_IS_NETWORK)) {
            return;
          }
          /* Only the stop that follows our own start counts: the load this
             one replaced stops too, and taking that as ours reported
             success on a tab still at about:blank. */
          if (flags & WPL.STATE_START) {
            started = true;
            return;
          }
          if (!(flags & WPL.STATE_STOP) || !started) {
            return;
          }
          // request.status throws on the parent's remote proxy; use the arg.
          if (status === Cr.NS_BINDING_ABORTED) {
            return;
          }
          if (!Components.isSuccessCode(status)) {
            finish({
              ok: false,
              reason: "load-failed",
              detail: ChromeUtils.getXPCOMErrorName(status),
            });
            return;
          }
          if (!ZenAgentPolicy.isCurrent(generation)) {
            finish({ ok: false, reason: "revoked" });
            return;
          }
          /* Re-check after the load lands: a redirect can move the tab onto a
             guarded origin that the pre-navigation check could not see. */
          const landed = guardTab(tab);
          if (!landed.ok) {
            finish(landed);
            return;
          }
          finish({
            ok: true,
            result: { url: landed.url, title: tab.label || "" },
            url: landed.url,
            host: landed.host,
          });
        },
      };

      try {
        browser.addProgressListener(
          listener,
          Ci.nsIWebProgress.NOTIFY_STATE_WINDOW
        );
        browser.fixupAndLoadURIString(target, {
          triggeringPrincipal: principal,
        });
      } catch (ex) {
        finish({ ok: false, reason: "load-failed", detail: String(ex) });
      }
    });
  },
};
