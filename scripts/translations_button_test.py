#!/usr/bin/env python3
"""The movable Translate button: on for profiles that stored translations off,
dimmed or disabled by page, opens Firefox's panel on itself, and a real
German -> English translation (models fetched from Mozilla) shows "en" on it.
Second monitor."""
import http.server, json, os, sys, threading, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import regress

RESULTS = []
SHOT = "/tmp/claude-1000/translations-panel.png"


def check(name, ok, detail=""):
    RESULTS.append(ok)
    print(("ok    " if ok else "FAIL  ") + f"{name:38} {detail}", flush=True)


PAGES = {
    "/de": ("de", "Nachrichten", "Die Stadt plant einen neuen Park",
            "Der Stadtrat hat am Dienstag beschlossen, im Norden der Stadt einen großen "
            "Park zu bauen. Viele Bürger freuen sich über die Entscheidung, weil es in "
            "diesem Viertel bisher kaum Grünflächen gibt."),
    "/en": ("en", "News", "The city plans a new park",
            "The council decided on Tuesday to build a large park in the north of the "
            "city. Many residents welcome the decision because the district has few "
            "green spaces."),
}


class Pages(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        lang, title, h1, p = PAGES.get(self.path, PAGES["/en"])
        body = (f'<!doctype html><html lang="{lang}"><meta charset="utf-8"><title>{title}</title>'
                f'<h1>{h1}</h1><p>{p}</p>').encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Pages)
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{srv.server_address[1]}"

STATE = """
  const b = document.getElementById('zen-translations-button');
  const r = b?.getBoundingClientRect();
  return JSON.stringify(b && {area: b.parentElement?.closest('[id]')?.id || null,
    w: r.width, disabled: b.disabled, idle: b.hasAttribute('zen-idle'),
    active: b.hasAttribute('translationsactive'), loading: b.hasAttribute('zen-loading'),
    badge: b.getAttribute('badge'), tip: b.getAttribute('tooltiptext')});"""


def open_tab(m, url):
    m.js("gBrowser.selectedTab = gBrowser.addTab(%s, {triggeringPrincipal: "
         "Services.scriptSecurityManager.getSystemPrincipal()}); return '1';" % json.dumps(url))


def wait_state(m, pred, seconds):
    end, s = time.time() + seconds, None
    while time.time() < end:
        s = m.js(STATE)
        if s and pred(s):
            return s
        time.sleep(0.5)
    return s


port = regress.free_port()
# What the user's profile has: translations switched off as a stored value.
proc = regress.launch("/tmp/claude-1000/tr-profile", port,
                      prefs='user_pref("browser.translations.enable", false);\n')
try:
    m = regress.Marionette(port)
    time.sleep(2)
    p = m.js("""return JSON.stringify([Services.prefs.getBoolPref('browser.translations.enable'),
      Services.prefs.getBoolPref('zen.translations.enable-migrated', false),
      Services.prefs.getIntPref('widget.use-xdg-desktop-portal.file-picker')]);""")
    check("stored 'off' is switched on once", p[0] and p[1], p)
    check("file dialogs go through the portal", p[2] == 1, p[2])

    open_tab(m, BASE + "/de")
    s = wait_state(m, lambda s: not s["idle"] and not s["disabled"], 15)
    check("button placed and visible", bool(s) and s["w"] > 0, s and f"{s['area']} w={s['w']}")
    check("German page: ready, not dimmed", bool(s) and not s["idle"] and not s["disabled"], s)

    open_tab(m, BASE + "/en")
    s = wait_state(m, lambda s: s["idle"], 15)
    check("English page: dimmed", bool(s) and s["idle"] and not s["disabled"], s)

    open_tab(m, "about:preferences")
    s = wait_state(m, lambda s: s["disabled"], 10)
    check("about: page: disabled", bool(s) and s["disabled"], s)

    m.js("gBrowser.removeTab(gBrowser.selectedTab); gBrowser.removeTab(gBrowser.selectedTab); return '1';")
    time.sleep(1.5)
    anchor = m.js("""
      const b = document.getElementById('zen-translations-button');
      const panel = document.getElementById('full-page-translations-panel');
      const shown = new Promise(r => document.addEventListener('popupshown', e => r(e.target), {once: true}));
      b.doCommand();
      const t = await Promise.race([shown, new Promise(r => setTimeout(() => r(null), 8000))]);
      const p = document.getElementById('full-page-translations-panel');
      const a = p?.anchorNode;
      const pr = p.getBoundingClientRect();
      return JSON.stringify({open: p?.state, anchor: a?.closest?.('[id]')?.id || a?.id,
        inside: pr.left >= 0 && pr.top >= 0 && pr.right <= innerWidth && pr.bottom <= innerHeight,
        rect: [pr.left, pr.top, pr.right, pr.bottom].map(Math.round)});""")
    check("click opens the panel on the button", anchor["open"] == "open"
          and anchor["anchor"] == "zen-translations-button", anchor)
    check("panel inside the window", anchor.get("inside"), anchor.get("rect"))
    time.sleep(0.6)
    m.screenshot(SHOT)
    m.js("""PanelMultiView.hidePopup(document.getElementById('full-page-translations-panel')); return '1';""")

    m.js("""TranslationsParent.getTranslationsActor(gBrowser.selectedBrowser).translate(
      {sourceLanguage: 'de', targetLanguage: 'en'}, false); return '1';""")
    s = wait_state(m, lambda s: s["active"], 15)
    check("translating: button marked active", bool(s) and s["active"], s)
    s = wait_state(m, lambda s: s["badge"] == "en", 180)
    check("translated: badge shows 'en'", bool(s) and s["badge"] == "en", s)
    check("tooltip names both languages", bool(s) and "German" in (s["tip"] or "")
          and "English" in (s["tip"] or ""), s and s["tip"])
    # The title is translated with the page; the text itself is checked on screen.
    title = None
    for _ in range(20):
        title = m.js("return JSON.stringify(gBrowser.selectedTab.label);")
        if title == "News":
            break
        time.sleep(1)
    check("page is English (title)", title == "News", title)
finally:
    try:
        proc.terminate(); proc.wait(15)
    except Exception:
        pass
    srv.shutdown()
print(f"{sum(RESULTS)}/{len(RESULTS)} passed")
sys.exit(0 if all(RESULTS) else 1)
