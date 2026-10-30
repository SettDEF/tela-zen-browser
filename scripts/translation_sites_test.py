#!/usr/bin/env python3
"""Translated sites are remembered: translating a page records its site and
languages, returning to that site translates it again by itself (once per
load), the Translate button's right-click menu and Settings list it, and a
site switched off stays untranslated. Real models (fetched from Mozilla).
Second monitor."""
import http.server, json, os, sys, threading, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import regress

RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append(ok)
    print(("ok    " if ok else "FAIL  ") + f"{name:46} {detail}", flush=True)


DE = ('<!doctype html><html lang="de"><meta charset="utf-8"><title>Nachrichten</title>'
      '<h1>Die Stadt plant einen neuen Park</h1><p>Der Stadtrat hat am Dienstag beschlossen, '
      'im Norden der Stadt einen großen Park zu bauen. Viele Bürger freuen sich über die '
      'Entscheidung, weil es in diesem Viertel bisher kaum Grünflächen gibt.</p>').encode()


class Page(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(DE)))
        self.end_headers()
        self.wfile.write(DE)

    def log_message(self, *a):
        pass


srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Page)
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = f"http://127.0.0.1:{srv.server_address[1]}/de"

OPEN = ("gBrowser.selectedTab = gBrowser.addTab(%s, {triggeringPrincipal: "
        "Services.scriptSecurityManager.getSystemPrincipal()}); return '1';" % json.dumps(URL))
LABEL = "return JSON.stringify(gBrowser.selectedTab.label);"


def wait_label(m, want, seconds):
    end, got = time.time() + seconds, None
    while time.time() < end:
        got = m.js(LABEL)
        if got == want:
            return got
        time.sleep(1)
    return got


port = regress.free_port()
proc = regress.launch("/tmp/claude-1000/tr-sites-profile", port)
try:
    m = regress.Marionette(port)
    time.sleep(2)
    m.js(OPEN)
    time.sleep(3)
    m.js("TranslationsParent.getTranslationsActor(gBrowser.selectedBrowser).translate("
         "{sourceLanguage: 'de', targetLanguage: 'en'}, false); return '1';")
    check("first visit: translated by hand", wait_label(m, "News", 180) == "News")
    time.sleep(1.5)
    sites = m.js("return Services.prefs.getStringPref('zen.translations.sites');")
    sites = sites if isinstance(sites, dict) else json.loads(sites)
    site = sites.get("127.0.0.1", {})
    check("site remembered with its languages", site.get("from") == "de" and site.get("to") == "en"
          and site.get("auto") is True, sites)

    m.js(OPEN)
    got = wait_label(m, "News", 60)
    check("return visit translates by itself", got == "News", got)

    menu = m.js("""
      const popup = document.getElementById('zen-translations-sites-menu');
      const shown = new Promise(r => popup.addEventListener('popupshown', r, {once: true}));
      popup.openPopup(document.getElementById('zen-translations-button'), 'after_start');
      await Promise.race([shown, new Promise(r => setTimeout(r, 3000))]);
      await new Promise(r => setTimeout(r, 400));
      const items = [...popup.querySelectorAll('menuitem')].map(i => i.label);
      popup.hidePopup();
      return JSON.stringify({items, context: document.getElementById('zen-translations-button')?.getAttribute('context')});""")
    check("right-click lists the site", menu["context"] == "zen-translations-sites-menu"
          and any("127.0.0.1" in (i or "") for i in menu["items"]), menu["items"])

    m.js("gBrowser.selectedTab = gBrowser.addTab('about:preferences#zenTabManagement',"
         " {triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()}); return '1';")
    time.sleep(4)
    pane = m.js("""
      const d = gBrowser.selectedBrowser.contentDocument;
      const rows = [...d.querySelectorAll('#zenTranslatedSitesList .zen-translated-row')];
      const box = rows[0]?.querySelector('input[type=checkbox]');
      const out = {rows: rows.map(r => [r.querySelector('.zen-translated-host').textContent,
        r.querySelector('.zen-translated-langs').textContent]), checked: box?.checked};
      box.click();
      await new Promise(r => setTimeout(r, 300));
      out.after = JSON.parse(Services.prefs.getStringPref('zen.translations.sites'))['127.0.0.1']?.auto;
      return JSON.stringify(out);""")
    check("settings list the site and languages", pane["rows"] == [["127.0.0.1", "German → English"]], pane["rows"])
    check("settings switch turns its repeat off", pane["checked"] is True and pane["after"] is False, pane)

    m.js(OPEN)
    time.sleep(15)
    got = m.js(LABEL)
    check("switched off: stays untranslated", got == "Nachrichten", got)
finally:
    try:
        proc.terminate(); proc.wait(15)
    except Exception:
        pass
    srv.shutdown()
print(f"{sum(RESULTS)}/{len(RESULTS)} passed")
sys.exit(0 if all(RESULTS) else 1)
