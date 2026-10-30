#!/usr/bin/env python3
"""Media card ⋯ panel: the site's own volume, both ways. On YouTube Music
our slider sets the site's slider (not just the player under it) and follows
it when the site's slider moves; speed follows too. A plain page's <audio>
is set directly. Real YouTube Music, second monitor."""
import http.server, io, json, math, os, struct, sys, threading, time, wave
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import regress

YTM = "https://music.youtube.com/watch?v=dQw4w9WgXcQ"
RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append(ok)
    print(("ok    " if ok else "FAIL  ") + f"{name:44} {detail}", flush=True)


# A second of quiet tone, looped by the page: a real, playing <audio>.
def tone():
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(8000)
        w.writeframes(b"".join(struct.pack("<h", int(800 * math.sin(i / 8))) for i in range(8000)))
    return buf.getvalue()


WAV = tone()


class Page(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body, kind = (WAV, "audio/wav") if self.path == "/t.wav" else (
            b'<!doctype html><title>tone</title><audio src="/t.wav" autoplay loop></audio>', "text/html")
        self.send_response(200)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Page)
threading.Thread(target=srv.serve_forever, daemon=True).start()
PLAIN = f"http://127.0.0.1:{srv.server_address[1]}/"


def page(m, tab, body):
    """Runs `body` in that tab's page and returns its value."""
    src = ("(function(){let r; try { const w = content.wrappedJSObject; const d = content.document;"
           " r = (function(){ %s })(); } catch(e) { r = 'ERR ' + e; }"
           " sendAsyncMessage('T:R', JSON.stringify(r)); })();" % body)
    return m.js("""
      const b = %s.linkedBrowser;
      const got = new Promise(r => { const l = msg => { if (msg.target === b) {
        b.messageManager.removeMessageListener('T:R', l); r(msg.data); } };
        b.messageManager.addMessageListener('T:R', l); });
      b.messageManager.loadFrameScript('data:,' + encodeURIComponent(%s), false);
      return await Promise.race([got, new Promise(r => setTimeout(() => r('"timeout"'), 4000))]);"""
                % (tab, json.dumps(src)))


def media(m, tab, name, data="{}", wait_for=None):
    """Sends one ZenMedia message and returns the next state that tab reports."""
    return m.js("""
      const b = %s.linkedBrowser;
      const got = new Promise(r => { const l = msg => { if (msg.target === b && (%s)(msg.data)) {
        window.messageManager.removeMessageListener('ZenMedia:State', l); r(msg.data); } };
        window.messageManager.addMessageListener('ZenMedia:State', l); });
      b.messageManager.sendAsyncMessage(%s, %s);
      return JSON.stringify(await Promise.race([got, new Promise(r => setTimeout(() => r(null), 4000))]));"""
                % (tab, wait_for or "() => true", json.dumps(name), data))


SITE = ("const s = d.querySelector('#volume-slider')?.wrappedJSObject;"
        " const p = d.getElementById('movie_player')?.wrappedJSObject;"
        " return {slider: s && Number(s.value), player: p && p.getVolume(), rate: p && p.getPlaybackRate()};")

port = regress.free_port()
proc = regress.launch("/tmp/claude-1000/media-more-profile", port,
                      prefs='user_pref("media.autoplay.default", 0);\n'
                            'user_pref("zen.glass.file", "/nonexistent");\n')
try:
    m = regress.Marionette(port)
    time.sleep(2)
    P = "Services.scriptSecurityManager.getSystemPrincipal()"
    m.js(f"window._ytm = gBrowser.addTab({json.dumps(YTM)}, {{triggeringPrincipal: {P}}});"
         " gBrowser.selectedTab = _ytm; return '1';")
    time.sleep(6)
    # The EU consent wall, in this throwaway profile only.
    for _ in range(3):
        if "consent." not in m.js("return JSON.stringify(_ytm.linkedBrowser.currentURI.spec);"):
            break
        page(m, "_ytm", "const b = [...d.querySelectorAll('button')].find(b => /reject|ablehnen/i"
                        ".test(b.getAttribute('aria-label') || b.textContent)); b?.click(); return !!b;")
        time.sleep(8)
    time.sleep(4)

    s = media(m, "_ytm", "ZenMedia:Query")
    site = page(m, "_ytm", SITE)
    check("YT Music: read from the site's slider", s and s["source"] == "site"
          and s["volume"] == site["slider"], f"ours={s and s['volume']} site={site}")

    s = media(m, "_ytm", "ZenMedia:SetVolume", "{volume: 35}")
    time.sleep(0.6)
    site = page(m, "_ytm", SITE)
    check("YT Music: ours moves the site's slider", site["slider"] == 35 and s["volume"] == 35, site)
    check("YT Music: and the player under it", site["player"] is not None and site["player"] < 100,
          f"player={site['player']}")

    media(m, "_ytm", "ZenMedia:Watch", "{on: true}")
    page(m, "_ytm", "const s = d.querySelector('#volume-slider').wrappedJSObject; s.value = 80;"
                    " s.dispatchEvent(new w.CustomEvent('change', {bubbles: true})); return 1;")
    s = m.js("""
      const b = _ytm.linkedBrowser;
      return JSON.stringify(await new Promise(r => { const l = msg => { if (msg.target === b && msg.data.volume === 80) {
        window.messageManager.removeMessageListener('ZenMedia:State', l); r(msg.data); } };
        window.messageManager.addMessageListener('ZenMedia:State', l); setTimeout(() => r(null), 4000); }));""")
    check("YT Music: site's slider moved, ours follows", bool(s) and s["volume"] == 80, s)

    s = media(m, "_ytm", "ZenMedia:SetRate", "{rate: 1.5}")
    check("speed goes through the site's player", page(m, "_ytm", SITE)["rate"] == 1.5 and s["rate"] == 1.5)
    media(m, "_ytm", "ZenMedia:SetRate", "{rate: 1}")

    # The card itself: another tab in front, so the YT Music card shows.
    m.js(f"gBrowser.selectedTab = gBrowser.addTab('about:robots', {{triggeringPrincipal: {P}}}); return '1';")
    time.sleep(2.5)
    ui = m.js("""
      const card = [...document.querySelectorAll('.zen-media-card')].find(c => !c.hidden);
      const btn = card?.querySelector('.zen-media-more-button');
      if (!btn) return JSON.stringify({card: !!card});
      const shown = new Promise(r => document.addEventListener('popupshown', e => r(e.target), {once: true}));
      btn.doCommand();
      const panel = await Promise.race([shown, new Promise(r => setTimeout(() => r(null), 4000))]);
      await new Promise(r => setTimeout(r, 800));
      const p = document.getElementById('zen-media-more-panel');
      const range = p.querySelector('.zen-media-more-volume');
      const before = Number(range.value);
      range.value = 20;
      range.dispatchEvent(new Event('input', {bubbles: true}));
      await new Promise(r => setTimeout(r, 800));
      const labels = [...p.querySelectorAll('.zen-media-more-label, .zen-media-more-action, .zen-media-more-source')]
        .map(e => e.textContent.trim());
      const pr = p.getBoundingClientRect();
      const res = {open: p.state, anchored: p.anchorNode === btn, before, labels,
        inside: pr.left >= 0 && pr.right <= innerWidth && pr.top >= 0 && pr.bottom <= innerHeight,
        rect: [pr.left, pr.top, pr.right, pr.bottom].map(Math.round),
        speedChips: p.querySelectorAll('.zen-media-more-rate').length,
        tooltip: btn.getAttribute('tooltiptext'), w: btn.getBoundingClientRect().width,
        heading: p.querySelector('.zen-media-more-title')?.textContent};
      p.hidePopup();
      return JSON.stringify(res);""")
    check("⋯ button on the card", ui.get("w", 0) > 0 and ui.get("tooltip") == "More options", ui)
    check("⋯ opens the panel on itself", ui.get("open") == "open" and ui.get("anchored"), ui.get("open"))
    check("panel inside the window", ui.get("inside"), ui.get("rect"))
    check("panel names the tab it controls", "YouTube Music" in (ui.get("heading") or ""), ui.get("heading"))
    check("panel shows the site's volume", ui.get("before") == 80, ui.get("before"))
    check("panel text all present", ui.get("labels") and all(ui["labels"]) and ui.get("speedChips") == 5,
          ui.get("labels"))
    check("panel slider moves YT Music's slider", page(m, "_ytm", SITE)["slider"] == 20)

    # Anything else: the page's own <audio>.
    m.js(f"window._plain = gBrowser.addTab({json.dumps(PLAIN)}, {{triggeringPrincipal: {P}}});"
         " gBrowser.selectedTab = _plain; return '1';")
    time.sleep(3)
    s = media(m, "_plain", "ZenMedia:SetVolume", "{volume: 25}")
    vol = page(m, "_plain", "const a = d.querySelector('audio'); return [a.paused, a.volume];")
    check("plain page: sets its <audio> directly", s and s["source"] == "page" and vol[1] == 0.25,
          f"{s and s['source']} {vol}")
    s = media(m, "_ytm", "ZenMedia:Query")
    check("no adapter crosses tabs", s and s["volume"] == 20, s and s["volume"])
finally:
    try:
        proc.terminate(); proc.wait(15)
    except Exception:
        pass
    srv.shutdown()
print(f"{sum(RESULTS)}/{len(RESULTS)} passed")
sys.exit(0 if all(RESULTS) else 1)
