#!/usr/bin/env python3
"""Verify the agent indicator, panel and kill switch by driving the UI.

Asserts computed style and painted geometry rather than the attribute alone,
and writes a screenshot of every indicator state for a human to look at.
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from agent_harness import (Marionette, free_port, launch, check, report,
                           shot, PROFILE)




def main():
    port = free_port(3010)
    proc = launch(port)
    try:
        m = Marionette(port)

        present = m.js("""
          const w = Services.wm.getMostRecentWindow("navigator:browser");
          return JSON.stringify({
            ui: typeof w.gZenAgentUI,
            widget: !!w.document.getElementById("zen-agent-status-button"),
          });
        """)
        check("ui-module-loaded", present["ui"] == "object", f"typeof={present['ui']}")
        check("widget-present", present["widget"] is True, "")

        m.js("""
          const w = Services.wm.getMostRecentWindow("navigator:browser");
          const d = w.document;
          // Measurement scaffold: at this window width CustomizableUI parks the
          // chip in the overflow list, which is not laid out, so every computed
          // style reads empty. Put the real node back in the rendered navbar.
          const btn = d.getElementById("zen-agent-status-button");
          d.getElementById("nav-bar").appendChild(btn);
          await new Promise(r => w.setTimeout(r, 500));
          return JSON.stringify({w: Math.round(btn.getBoundingClientRect().width)});
        """)

        off = m.js("""
          const w = Services.wm.getMostRecentWindow("navigator:browser");
          const d = w.document;
          const icon = d.getElementById("zen-agent-status-button")
            ?.querySelector(".toolbarbutton-icon");
          const cs = icon ? w.getComputedStyle(icon) : null;
          const marker = d.getElementById("zen-agent-marker");
          return JSON.stringify({
            attr: d.documentElement.getAttribute("zen-agent"),
            img: cs ? cs.backgroundImage : "",
            markerShown: marker ? w.getComputedStyle(marker).display : "none",
          });
        """)
        check("off-has-no-attribute", off["attr"] is None, f"attr={off['attr']}")
        check("off-uses-off-glyph", "agent-off.svg" in off["img"],
              f"image={off['img'][-28:]}")
        check("off-marker-hidden", off["markerShown"] == "none",
              f"display={off['markerShown']}")
        shot(m, "01-off")

        att = m.js("""
          const w = Services.wm.getMostRecentWindow("navigator:browser");
          const d = w.document;
          await w.gZenAgentUI.startAttended();
          await new Promise(r => w.setTimeout(r, 600));
          const icon = d.getElementById("zen-agent-status-button")
            .querySelector(".toolbarbutton-icon");
          const cs = w.getComputedStyle(icon);
          const pill = d.querySelector("#zen-agent-marker .zen-agent-pill");
          const pr = pill.getBoundingClientRect();
          return JSON.stringify({
            attr: d.documentElement.getAttribute("zen-agent"),
            img: cs.backgroundImage,
            bg: cs.backgroundColor,
            anim: cs.animationName,
            pillText: pill.textContent,
            pillW: Math.round(pr.width), pillH: Math.round(pr.height),
          });
        """)
        check("attended-attribute", att["attr"] == "attended", f"attr={att['attr']}")
        check("attended-own-glyph", "agent-attended.svg" in att["img"],
              f"image={att['img'][-32:]}")
        check("attended-chip-painted",
              att["bg"] not in ("rgba(0, 0, 0, 0)", "transparent"),
              f"bg={att['bg']}")
        check("indicator-animates", att["anim"] == "zen-agent-hold",
              f"animation={att['anim']}")
        # The pill must carry the state in words, not colour alone.
        check("pill-has-text-and-size",
              bool(att["pillText"].strip()) and att["pillW"] > 40 and att["pillH"] > 8,
              f"text={att['pillText'][:34]!r} {att['pillW']}x{att['pillH']}")
        shot(m, "02-attended")

        sil = m.js("""
          const w = Services.wm.getMostRecentWindow("navigator:browser");
          const d = w.document;
          await w.gZenAgentUI.stop();
          await w.gZenAgentUI.startSilent();
          await new Promise(r => w.setTimeout(r, 600));
          const icon = d.getElementById("zen-agent-status-button")
            .querySelector(".toolbarbutton-icon");
          const cs = w.getComputedStyle(icon);
          const pill = d.querySelector("#zen-agent-marker .zen-agent-pill");
          return JSON.stringify({
            attr: d.documentElement.getAttribute("zen-agent"),
            img: cs.backgroundImage,
            bg: cs.backgroundColor,
            pillText: pill.textContent,
          });
        """)
        check("silent-attribute", sil["attr"] == "silent", f"attr={sil['attr']}")
        check("silent-own-glyph", "agent-silent.svg" in sil["img"],
              f"image={sil['img'][-30:]}")
        # Colour now identifies WHICH assistant, so the two states must be
        # told apart by shape and by words - not by hue.
        check("silent-distinct-from-attended-by-shape",
              sil["img"] != att["img"],
              "glyph shape differs")
        check("silent-pill-differs", sil["pillText"] != att["pillText"],
              f"text={sil['pillText'][:34]!r}")
        shot(m, "03-silent")

        # A silent agent tab must be marked and must not take the selection.
        tab = m.js("""
          const w = Services.wm.getMostRecentWindow("navigator:browser");
          const { ZenAgentTabs } = ChromeUtils.importESModule(
            "resource:///modules/zen/agent/ZenAgentTabs.sys.mjs");
          const beforeSel = w.gBrowser.selectedTab;
          const r = ZenAgentTabs.create("https://example.com/");
          await new Promise(res => w.setTimeout(res, 1500));
          const marked = [...w.gBrowser.tabs].filter(t => t.hasAttribute("zen-agent"));
          const el = marked[0];
          const cs = w.getComputedStyle(el);
          return JSON.stringify({
            created: r.ok === true,
            marked: marked.length,
            keptSelection: w.gBrowser.selectedTab === beforeSel,
            outline: cs.outlineColor,
            outlineW: cs.outlineWidth,
          });
        """)
        check("agent-tab-created", tab["created"] is True, "")
        check("agent-tab-visibly-marked",
              tab["marked"] == 1 and tab["outlineW"] != "0px",
              f"outline={tab['outlineW']} {tab['outline']}")
        check("agent-tab-kept-user-selection", tab["keptSelection"] is True, "")
        shot(m, "04-silent-with-tab")

        # The panel: it must offer the stop, and the way to the agent's tab.
        panel = m.js("""
          const w = Services.wm.getMostRecentWindow("navigator:browser");
          const d = w.document;
          w.gZenAgentUI.togglePanel();
          await new Promise(r => w.setTimeout(r, 900));
          const body = d.getElementById("zen-agent-panel-body");
          const buttons = [...body.querySelectorAll("button")].map(
            b => b.getAttribute("data-l10n-id"));
          const rows = body.querySelectorAll(".zen-agent-log-row").length;
          const p = d.getElementById("zen-agent-panel");
          const pr = p.getBoundingClientRect();
          return JSON.stringify({
            open: p.state, buttons, rows,
            rect: [Math.round(pr.x), Math.round(pr.y),
                   Math.round(pr.width), Math.round(pr.height)],
            win: [w.innerWidth, w.innerHeight],
            text: body.textContent.replace(/\\s+/g, " ").trim().slice(0, 90),
          });
        """)
        check("panel-opens", panel["open"] == "open", f"state={panel['open']}")
        # An open panel that is off-screen looks identical to a broken one in
        # every DOM assertion, so measure where it actually landed.
        x, y, pw, ph = panel["rect"]
        ww, wh = panel["win"]
        check("panel-is-on-screen",
              x >= 0 and y >= 0 and pw > 0 and ph > 0
              and x + pw <= ww + 2 and y + ph <= wh + 2,
              f"rect={panel['rect']} window={panel['win']}")
        check("panel-has-kill-switch",
              "zen-agent-panel-stop" in panel["buttons"],
              f"buttons={panel['buttons']}")
        check("panel-offers-agent-tab",
              "zen-agent-panel-show-tab" in panel["buttons"], "")
        check("panel-shows-log", panel["rows"] > 0, f"rows={panel['rows']}")
        # No hardcoded English: every string must come from a l10n id.
        check("panel-strings-localised", "???" not in panel["text"]
              and bool(panel["text"]), f"text={panel['text'][:60]!r}")
        shot(m, "05-panel")

        stopped = m.js("""
          const w = Services.wm.getMostRecentWindow("navigator:browser");
          const d = w.document;
          const body = d.getElementById("zen-agent-panel-body");
          const stop = [...body.querySelectorAll("button")].find(
            b => b.getAttribute("data-l10n-id") === "zen-agent-panel-stop");
          stop.doCommand();
          await new Promise(r => w.setTimeout(r, 1200));
          const marker = d.getElementById("zen-agent-marker");
          return JSON.stringify({
            attr: d.documentElement.getAttribute("zen-agent"),
            markerShown: w.getComputedStyle(marker).display,
          });
        """)
        check("panel-stop-revokes", stopped["attr"] is None,
              f"attr={stopped['attr']}")
        check("marker-hidden-after-stop", stopped["markerShown"] == "none",
              f"display={stopped['markerShown']}")
        shot(m, "06-after-stop")

        # A missing .ftl blanks every label in the window; prove it did not.
        labels = m.js("""
          const w = Services.wm.getMostRecentWindow("navigator:browser");
          const d = w.document;
          await d.l10n.translateFragment(d.documentElement);
          const probe = d.getElementById("zen-agent-status-button");
          return JSON.stringify({
            agentLabel: probe?.getAttribute("label") || "",
            fileMenu: d.getElementById("file-menu")?.getAttribute("label") || "",
          });
        """)
        check("agent-ftl-resolves", bool(labels["agentLabel"]),
              f"label={labels['agentLabel']!r}")
        check("other-labels-intact", bool(labels["fileMenu"]),
              f"file-menu={labels['fileMenu']!r}")

        errs = m.js("""
          const w = Services.wm.getMostRecentWindow("navigator:browser");
          const msgs = Services.console.getMessageArray() || [];
          const bad = msgs.map(x => x.message || "").filter(t =>
            /zen-agent|ZenAgent/i.test(t) && /error|exception|not defined|undefined is not/i.test(t));
          return JSON.stringify({count: bad.length, first: bad.slice(0,3)});
        """)
        check("no-agent-console-errors", errs["count"] == 0,
              f"errors={errs['count']} {errs['first']}")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except Exception:
            proc.kill()

    return report()


if __name__ == "__main__":
    sys.exit(main())
