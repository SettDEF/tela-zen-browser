#!/usr/bin/env python3
"""The new tab page: search box first (her "type and go"), engine's category
chips, top-site tiles, history cards, no empty headings. Typing an address
goes there, text searches, a chip searches its category. Saves a screenshot
(argv[1], optional). Second monitor."""
import json, os, sys, time, urllib.parse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import regress

RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append(ok)
    print(("ok    " if ok else "FAIL  ") + f"{name:40} {detail}", flush=True)


NEW = ("gBrowser.selectedTab = gBrowser.addTab('about:newtab', {triggeringPrincipal:"
       " Services.scriptSecurityManager.getSystemPrincipal()});"
       " for (let i = 0; i < 50 && !gBrowser.selectedBrowser.contentWindow?.document?.getElementById('q'); i++)"
       " await new Promise(r => setTimeout(r, 100)); await new Promise(r => setTimeout(r, 1500));"
       " const d = gBrowser.selectedBrowser.contentWindow.document;")
SEED = """
  const now = Date.now();
  const pages = [['https://www.youtube.com/watch?v=1', 'Gabberteacher - YouTube'],
    ['https://music.youtube.com/', 'YouTube Music'], ['https://github.com/zen-browser/desktop', 'zen-browser/desktop'],
    ['https://www.perplexity.ai/search/x', 'wie schreibt man dayly - Perplexity'],
    ['https://en.wikipedia.org/wiki/Hardcore_techno', 'Hardcore techno - Wikipedia'],
    ['https://soundcloud.com/kloud', 'KLOUD | SoundCloud'], ['https://www.reddit.com/r/firefox/', 'r/firefox'],
    ['https://archlinux.org/news/', 'Arch Linux - News'], ['https://hyprland.org/', 'Hyprland']];
  await PlacesUtils.history.insertMany(pages.map(([url, title], i) => ({url, title,
    visits: Array.from({length: i % 3 + 1}, (_, k) => ({date: new Date(now - i * 18e6 - k * 1e5)}))})));"""

port = regress.free_port()
proc = regress.launch("/tmp/claude-1000/newtab-%d" % port, port)
try:
    m = regress.Marionette(port)
    time.sleep(3)
    # Empty profile first: no headings over nothing.
    r = m.js(NEW + """return JSON.stringify({recent: d.getElementById('recent-sect').hidden,
      list: d.getElementById('list-sect').hidden, box: !!d.getElementById('q')});""")
    check("empty history: no empty sections", r["recent"] and r["list"] and r["box"], r)

    m.js(SEED + " return '1';")
    r = m.js(NEW + """const q = d.getElementById('q');
      const cs = getComputedStyle(d.body);
      return JSON.stringify({ph: q.placeholder, engine: !d.getElementById('engine').hidden,
        chips: [...d.querySelectorAll('.chip')].map(c => c.textContent), tiles: d.querySelectorAll('.tile').length,
        cards: d.querySelectorAll('.card').length, rows: d.querySelectorAll('.row').length,
        font: cs.fontFamily, bg: cs.backgroundColor});""")
    check("search box names the engine", r["ph"].startswith("Search ") and r["engine"], r["ph"])
    check("category chips", r["chips"][:3] == ["Images", "News", "Videos"], r["chips"])
    check("top-site tiles", 1 <= r["tiles"] <= 8, r["tiles"])
    check("history cards and list", r["cards"] == 6 and r["rows"] >= 1, f"{r['cards']} cards {r['rows']} rows")
    check("browser's UI font, not a serif", "serif" not in r["font"].lower() or "sans" in r["font"].lower(), r["font"])
    if len(sys.argv) > 1:
        m.screenshot(sys.argv[1])

    # Views: ] cycles, the filter narrows History, a switch hides tiles live.
    r = m.js(NEW + """const key = k => d.dispatchEvent(new KeyboardEvent('keydown', {key: k, bubbles: true}));
      d.body.focus(); key(']'); const v1 = !d.getElementById('view-history').hidden;
      const f = d.getElementById('filter'); f.value = 'wikipedia'; f.dispatchEvent(new Event('input'));
      const rows = d.querySelectorAll('#list .row').length;
      f.value = ''; key(']'); const v2 = !d.getElementById('view-settings').hidden;
      const sw = d.querySelector('[data-pref="zen.newtab.show-tiles"]'); sw.click();
      await new Promise(r => setTimeout(r, 100));
      const tilesGone = getComputedStyle(d.getElementById('tiles')).display == 'none';
      const pref = Services.prefs.getBoolPref('zen.newtab.show-tiles');
      Services.prefs.setBoolPref('zen.newtab.show-tiles', true); await new Promise(r => setTimeout(r, 100));
      const back = sw.checked && getComputedStyle(d.getElementById('tiles')).display != 'none';
      key('1'); const v3 = !d.getElementById('view-start').hidden;
      Services.prefs.setBoolPref('zen.workspaces.continue-where-left-off', false);
      const depOff = d.querySelector('[data-pref="zen.newtab.after-away-hours"]').disabled;
      Services.prefs.clearUserPref('zen.workspaces.continue-where-left-off');
      return JSON.stringify({v1, rows, v2, tilesGone, pref, back, v3, depOff,
        sel: d.querySelector('[data-pref="zen.newtab.after-away-hours"]').value});""")
    check("] goes to History, filter narrows it", r["v1"] and r["rows"] == 1, r)
    check("settings switch hides tiles and writes pref", r["v2"] and r["tilesGone"] and r["pref"] is False and r["back"], r)
    check("1 returns to Start; startup select follows", r["v3"] and r["depOff"] and r["sel"] == "4", r)

    # Start layouts: minimal is just the search; sites has more tiles, no cards.
    r = m.js(NEW + """const vis = id => getComputedStyle(d.getElementById(id)).display != 'none' && !d.getElementById(id).hidden;
      const snap = () => ({tiles: vis('tiles') ? d.querySelectorAll('.tile').length : 0,
        cards: vis('recent-sect') ? d.querySelectorAll('.card').length : 0, chips: vis('chips')});
      const out = {};
      for (const l of ['minimal', 'sites', 'recent', 'full']) {
        Services.prefs.setStringPref('zen.newtab.layout', l);
        await new Promise(r => setTimeout(r, 600)); out[l] = snap();
      }
      out.checked = d.querySelector('[data-layout][aria-checked="true"]')?.dataset.layout;
      Services.prefs.clearUserPref('zen.newtab.layout');
      return JSON.stringify(out);""")
    check("layout minimal: search only", r["minimal"] == {"tiles": 0, "cards": 0, "chips": False}, r["minimal"])
    check("layout sites: tiles, no cards", r["sites"]["tiles"] >= r["full"]["tiles"] and r["sites"]["cards"] == 0, r["sites"])
    check("layout recent: cards, no tiles", r["recent"]["tiles"] == 0 and r["recent"]["cards"] > r["full"]["cards"] - 1, r["recent"])
    check("layout picker follows the pref", r["checked"] == "full", r["checked"])

    r = m.js(NEW + """d.getElementById('q').value = 'archlinux.org'; d.getElementById('box').requestSubmit();
      await new Promise(r => setTimeout(r, 1500)); return JSON.stringify(gBrowser.selectedBrowser.currentURI.spec);""")
    check("an address goes there", r.startswith("http") and "archlinux.org" in r and "q=" not in r, r)
    r = m.js(NEW + """d.getElementById('q').value = 'zen browser'; d.getElementById('box').requestSubmit();
      await new Promise(r => setTimeout(r, 1500)); return JSON.stringify(gBrowser.selectedBrowser.currentURI.spec);""")
    check("text searches the engine", "zen" in r and ("q=" in r or "search" in r), r[:90])
    r = m.js(NEW + """d.getElementById('q').value = 'hardcore techno';
      [...d.querySelectorAll('.chip')].find(c => c.textContent == 'Images').click();
      await new Promise(r => setTimeout(r, 1500)); return JSON.stringify(gBrowser.selectedBrowser.currentURI.spec);""")
    r = urllib.parse.unquote(r)  # Google's bot check wraps the request in /sorry?continue=
    check("Images chip searches images", "hardcore" in r and ("udm=2" in r or "image" in r), r[:90])
finally:
    proc.terminate()
    proc.wait(15)
print(f"{sum(RESULTS)}/{len(RESULTS)} passed")
sys.exit(0 if all(RESULTS) else 1)
