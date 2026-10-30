#!/usr/bin/env python3
"""Zen cards against every watched site, simulated (#77).

Pages are served AT the real hostnames by scripts/fakenet.py, so the real
site-rule matching runs; nothing reaches the network. Each fake page polls its
own /__state and redraws the markers its rule looks for (a stop button, a CI
label, a transcode cell, a Statuspage banner), so the test flips a site
between idle, running and done without reloading it.
Opens on the monitor the user is not using. Screenshots in SHOTS.
"""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import regress
from agent_harness import shot
from fakenet import FakeNet

SHOTS = "/tmp/claude-1000/card-shots"
STATE = {}          # (host, path) -> "idle" | "running" | "done"
RESULTS = []

SAMPLES = {
    "claude.ai": "/chat/zen-test-1", "chatgpt.com": "/c/zen-test-1",
    "gemini.google.com": "/app/zen1", "aistudio.google.com": "/prompts/zen1",
    "grok.com": "/chat/zen1", "copilot.microsoft.com": "/chats/zen1",
    "chat.deepseek.com": "/a/chat/zen1", "chat.mistral.ai": "/chat/zen1",
    "chat.qwen.ai": "/c/zen1", "chat.z.ai": "/c/zen1", "kimi.ai": "/chat/zen1",
    "meta.ai": "/c/zen1", "perplexity.ai": "/search/zen1",
    "chat.together.ai": "/chat/zen1", "lumo.proton.me": "/c/zen1",
    "longcat.ai": "/chat/zen1", "agent.minimax.io": "/chat/zen1",
    "playground.allenai.org": "/chat/zen1",
    "github.com": "/zen/test/actions/runs/123", "gitlab.com": "/zen/test/-/pipelines/456",
    "commons.wikimedia.org": "/wiki/File:Zen_test.webm",
}


def markers(kind, state):
    """What each kind of site shows while running, and once done."""
    run, done = state == "running", state == "done"
    if kind == "chat":
        return ('<button data-testid="stop-button" aria-label="Stop response">&#9632;</button>'
                if run else '<button aria-label="Send message">&#8593;</button>')
    if kind == "github":
        return ('<span aria-label="In progress">&#9679;</span>' if run else
                '<span aria-label="Completed successfully">&#10003;</span>' if done else "")
    if kind == "gitlab":
        return ('<span data-testid="ci-icon-text">Running</span>' if run else
                '<span data-testid="ci-icon-text">Passed</span>' if done else "")
    if kind == "commons":
        cell = "Transcoding" if run else "Completed" if done else ""
        return f'<table class="mw-filepage-transcodestatus"><tr><td>{cell}</td></tr></table>' if cell else ""
    if kind == "status":
        return ('<div class="page-status status-major">Major outage</div>' if run else
                '<div class="page-status status-none">All systems operational</div>' if done else "")
    return ""


def kind_of(host):
    return {"github.com": "github", "gitlab.com": "gitlab",
            "commons.wikimedia.org": "commons"}.get(host, "status" if host not in SAMPLES else "chat")


PAGE = """<!doctype html><meta charset=utf-8><title>%(title)s</title>
<body><h1>%(title)s</h1><nav>%(links)s</nav><main id=m>%(mark)s</main>
<script>
const key = %(key)s;
setInterval(async () => {
  try {
    const r = await (await fetch("/__state?k=" + encodeURIComponent(key))).json();
    if (r.html !== document.getElementById("m").innerHTML) {
      document.getElementById("m").innerHTML = r.html;
      document.title = r.title;
    }
  } catch {}
}, 250);
</script>"""


def handler(host, path, query):
    if path == "/__state":
        h, p = json.loads(query["k"][0])
        st = STATE.get((h, p), "idle")
        return 200, "application/json", json.dumps(
            {"html": markers(kind_of(h), st), "title": f"{h} test - {st}"})
    if path == "/zen-card-test":
        return 200, "text/html", CARD_PAGE
    st = STATE.setdefault((host, path), "idle")
    links = "".join(f'<a href="{path}-{i}">Other item {i}</a> ' for i in (1, 2))
    return 200, "text/html", PAGE % {
        "title": f"{host} test - {st}", "links": links, "mark": markers(kind_of(host), st),
        "key": json.dumps(json.dumps([host, path]))}


CARD_PAGE = """<!doctype html><title>card page</title><body>card page<script>
const card = id => ({ detail: {
  id, title: "<img src=x onerror=alert(1)>Build " + id,
  subtitle: "<b>not bold</b>",
  // Escaped slash: a literal end tag here would end this very script.
  items: [{ label: "<script>x()<\\/script>step one", status: "running" },
          { label: "step two", detail: "<i>2s</i>" }] } });
// Once while the page is still parsing, once after it has settled.
document.dispatchEvent(new CustomEvent("ZenCardUpdate", card("early")));
setTimeout(() => document.dispatchEvent(new CustomEvent("ZenCardUpdate", card("late"))), 1000);
</script>"""


def check(name, ok, detail=""):
    RESULTS.append((name, ok))
    print(("ok    " if ok else "FAIL  ") + f"{name:40} {str(detail)[:110]}", flush=True)


# --- chrome-side probes ------------------------------------------------------
STATE_JS = """
  const w = Services.wm.getMostRecentWindow("navigator:browser");
  const P = w.gZenPageCards;
  const tabs = {};
  for (const [b, e] of P._tabs) tabs[b.currentURI?.spec || "?"] = { running: e.running, unread: e.unread, ran: e.ran };
  const card = [...w.document.querySelectorAll(".zen-page-card")].find(c =>
    c.textContent.includes("Activity"));
  const rows = card ? [...card.querySelectorAll(".zen-page-card-row:not(.zen-page-card-more)")].map(r =>
    ({ label: r.textContent.trim().slice(0, 60), status: r.getAttribute("status") || "" })) : [];
  const more = card?.querySelector(".zen-page-card-more")?.textContent.trim() || "";
  const sub = card ? [...card.querySelectorAll("*")].map(n => n.childElementCount ? "" : n.textContent.trim())
    .find(t => /running|waiting|All read/.test(t)) || "" : "";
  return JSON.stringify({ tabs, rows, more, sub, visible: !!card && card.getBoundingClientRect().height > 0 });
"""


def snap(m):
    return m.js(STATE_JS)


def wait_for(m, pred, timeout=10):
    end = time.time() + timeout
    s = snap(m)
    while time.time() < end:
        if pred(s):
            return s, True
        time.sleep(0.4)
        s = snap(m)
    return s, pred(s)


def open_tab(m, url, select=False):
    return m.js("""
      const w = Services.wm.getMostRecentWindow("navigator:browser");
      const t = w.gBrowser.addTab(%s, { inBackground: %s,
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      if (%s) w.gBrowser.selectedTab = t;
      await new Promise(r => setTimeout(r, 2500));
      return JSON.stringify(t.linkedBrowser.currentURI.spec);
    """ % (json.dumps(url), "false" if select else "true", "true" if select else "false"))


def close_tab(m, url):
    m.js("""
      const w = Services.wm.getMostRecentWindow("navigator:browser");
      for (const t of [...w.gBrowser.tabs]) if (t.linkedBrowser.currentURI.spec === %s) w.gBrowser.removeTab(t);
      await new Promise(r => setTimeout(r, 600));
      return "1";
    """ % json.dumps(url))


def main():
    os.makedirs(SHOTS, exist_ok=True)
    port = regress.free_port()
    probe = regress.launch("/tmp/claude-1000/cards-probe", port)
    try:
        rules = regress.Marionette(port).js("""
          const { SITE_RULES } = ChromeUtils.importESModule(
            "chrome://browser/content/zen-components/zen-site-rules.mjs");
          return JSON.stringify(SITE_RULES.map(r => ({ hosts: r.hosts, label: r.label,
            path: r.path ? r.path.source : null })));
        """)
    finally:
        probe.terminate(); probe.wait(15)
    hosts = [h for r in rules for h in r["hosts"]]
    net = FakeNet(hosts, handler).start()
    port = regress.free_port()
    proc = regress.launch("/tmp/claude-1000/cards-profile", port, prefs=net.prefs())
    try:
        m = regress.Marionette(port)
        m.js("""
          const db = Cc["@mozilla.org/security/x509certdb;1"].getService(Ci.nsIX509CertDB);
          db.addCertFromBase64(%s, "C,,");
          Services.prefs.setBoolPref("zen.cards.activity-toast", true);
          return "1";
        """ % json.dumps(net.ca_b64))

        # 0. every rule has a sample path its own regex accepts
        bad = []
        for r in rules:
            for h in r["hosts"]:
                sample = SAMPLES.get(h, "/")
                if r["path"] and not __import__("re").search(r["path"], sample):
                    bad.append(f"{h}{sample}")
        check("samples-match-rule-paths", not bad, bad or f"{len(hosts)} hosts")

        # 1. each site on its own, in a background tab: idle, running, done, closed
        for r in rules:
            for h in r["hosts"]:
                path = SAMPLES.get(h, "/")
                url = f"https://{h}{path}"
                STATE[(h, path)] = "idle"
                landed = open_tab(m, url)
                if not landed.startswith(f"https://{h}"):
                    check(f"{h}: loads", False, landed)
                    continue
                time.sleep(1.5)
                s = snap(m)
                idle_ok = not s["tabs"].get(url, {}).get("ran")
                STATE[(h, path)] = "running"
                s, run_ok = wait_for(m, lambda s: s["tabs"].get(url, {}).get("running")
                                     and any(x["status"] == "running" for x in s["rows"]))
                STATE[(h, path)] = "done"
                s, done_ok = wait_for(m, lambda s: s["tabs"].get(url, {}).get("unread")
                                      and any(x["status"] == "waiting" for x in s["rows"]))
                close_tab(m, url)
                s, gone_ok = wait_for(m, lambda s: url not in s["tabs"] and not s["rows"], 5)
                check(f"{h}", idle_ok and run_ok and done_ok and gone_ok,
                      f"idle-hidden={idle_ok} running={run_ok} waiting={done_ok} cleared={gone_ok}")

        # 2. Claude: finishing in view is not news; in the background it is.
        a, b = "https://claude.ai/chat/zen-front", "https://claude.ai/chat/zen-back"
        STATE[("claude.ai", "/chat/zen-front")] = "idle"
        STATE[("claude.ai", "/chat/zen-back")] = "idle"
        open_tab(m, b)
        open_tab(m, a, select=True)
        m.js("""const w = Services.wm.getMostRecentWindow("navigator:browser");
          w.gZenPageCards._announced = 0; const o = w.gZenPageCards._announce.bind(w.gZenPageCards);
          w.gZenPageCards._announce = e => { w.gZenPageCards._announced++; return o(e); }; return "1";""")
        STATE[("claude.ai", "/chat/zen-front")] = "running"
        STATE[("claude.ai", "/chat/zen-back")] = "running"
        s, ok = wait_for(m, lambda s: "2 running" in s["sub"])
        check("claude: two running", ok, s["sub"])
        shot(m, "cards-2-running")
        STATE[("claude.ai", "/chat/zen-front")] = "done"
        s, ok = wait_for(m, lambda s: s["tabs"].get(a, {}).get("running") is False)
        front = s["tabs"].get(a, {})
        check("claude: done in view is not unread", ok and not front.get("unread"), front)
        STATE[("claude.ai", "/chat/zen-back")] = "done"
        s, ok = wait_for(m, lambda s: "1 waiting" in s["sub"])
        announced = m.js('return JSON.stringify(Services.wm.getMostRecentWindow("navigator:browser").gZenPageCards._announced);')
        check("claude: done in background waits", ok, s["sub"])
        check("claude: background finish announced once", announced == 1, f"announced={announced}")
        m.js("""const w = Services.wm.getMostRecentWindow("navigator:browser");
          const row = [...w.document.querySelectorAll(".zen-page-card-row[status='waiting']")][0];
          row?.click(); await new Promise(r => setTimeout(r, 800));
          return JSON.stringify(w.gBrowser.selectedBrowser.currentURI.spec);""")
        s, ok = wait_for(m, lambda s: "All read" in s["sub"] and not s["tabs"].get(b, {}).get("unread"))
        sel = m.js('return JSON.stringify(Services.wm.getMostRecentWindow("navigator:browser").gBrowser.selectedBrowser.currentURI.spec);')
        check("claude: clicking the row opens it and clears it", ok and sel == b, f"selected={sel} sub={s['sub']}")
        close_tab(m, a); close_tab(m, b)

        # 3. six at once: three rows and "+3 more", then all six when opened
        six = [("claude.ai", "/chat/six-1"), ("claude.ai", "/chat/six-2"), ("chatgpt.com", "/c/six"),
               ("gemini.google.com", "/app/six"), ("grok.com", "/chat/six"), ("chat.mistral.ai", "/chat/six")]
        for h, p in six:
            STATE[(h, p)] = "idle"
            open_tab(m, f"https://{h}{p}")
        for h, p in six:
            STATE[(h, p)] = "running"
        s, ok = wait_for(m, lambda s: "6 running" in s["sub"], 15)
        check("six: summary", ok, s["sub"])
        check("six: collapsed to three rows", len(s["rows"]) == 3 and "3" in s["more"],
              f"rows={len(s['rows'])} more={s['more']!r}")
        shot(m, "cards-6-collapsed")
        m.js("""const w = Services.wm.getMostRecentWindow("navigator:browser");
          w.document.querySelector(".zen-page-card-more")?.click();
          await new Promise(r => setTimeout(r, 700)); return "1";""")
        s = snap(m)
        check("six: expands to all six", len(s["rows"]) == 6, f"rows={len(s['rows'])}")
        for h, p in six:
            close_tab(m, f"https://{h}{p}")

        # 4. a page's own card: text only, never markup; gone with its tab
        open_tab(m, "https://claude.ai/zen-card-test", select=True)
        time.sleep(1.5)
        card = m.js("""const w = Services.wm.getMostRecentWindow("navigator:browser");
          const c = [...w.document.querySelectorAll(".zen-page-card")].find(c => c.textContent.includes("Build late"));
          return JSON.stringify(c ? { text: c.textContent.replace(/\\s+/g, " ").trim().slice(0, 200),
            tags: [...c.querySelectorAll("img, b, i, script")].map(e => e.localName + ":" +
              (e.getAttribute("src") || e.className || "")),
            injected: [...c.querySelectorAll("b, i, script, [onerror], img[src='x']")].map(e =>
              e.localName + "." + e.className + (e.getAttribute("src") ? "@" + e.getAttribute("src") : "")) } : null);""")
        check("page card: shown", bool(card), card)
        check("page card: markup stays text", bool(card) and not card["injected"]
              and "<img src=x" in card["text"] and "<script>x()</script>" in card["text"],
              f"injected={card and card['injected']}")
        close_tab(m, "https://claude.ai/zen-card-test")
        gone = m.js("""const w = Services.wm.getMostRecentWindow("navigator:browser");
          return JSON.stringify(![...w.document.querySelectorAll(".zen-page-card")].some(c => c.textContent.includes("Build")));""")
        check("page card: dies with its tab", gone, "")
        print(f"info  requests refused (never left the machine): {sorted(net.refused)[:10]}")
    finally:
        proc.terminate(); proc.wait(15)
    failed = [n for n, ok in RESULTS if not ok]
    print(f"{len(RESULTS) - len(failed)}/{len(RESULTS)} passed" + (f"; failed: {failed}" if failed else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
