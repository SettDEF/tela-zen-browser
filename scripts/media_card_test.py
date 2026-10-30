#!/usr/bin/env python3
"""A media card lost while its tab keeps playing must come back.

Cards were only ever made when a tab STARTED playing, so a card destroyed
mid-playback (the user saw media controls vanish for good) never returned.
The loss is simulated by destroying the card; how it was lost in the wild was
never reproduced. Pages at real hostnames via fakenet; second monitor.
"""
import base64, io, json, math, os, struct, sys, time, wave
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import regress
import cards_sites_test as T
from fakenet import FakeNet

buf = io.BytesIO(); w = wave.open(buf, "wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(8000)
w.writeframes(b"".join(struct.pack("<h", int(3000 * math.sin(2 * math.pi * 220 * i / 8000))) for i in range(80000)))
w.close()
# Over 3 s: Firefox gives shorter media no controller, as a notification ping.
MUSIC = f"""<!doctype html><title>Hurt You | YouTube Music</title><body><audio id=a loop autoplay
src="data:audio/wav;base64,{base64.b64encode(buf.getvalue()).decode()}"></audio><script>
navigator.mediaSession.metadata = new MediaMetadata({{ title: "Hurt You", artist: "Test" }});
a.play().catch(() => {{}});</script>"""
RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append(ok)
    print(("ok    " if ok else "FAIL  ") + f"{name:34} {detail}", flush=True)


def handler(host, path, q):
    return (200, "text/html", MUSIC) if host in ("music.youtube.com", "soundcloud.com") else T.handler(host, path, q)


STATE = """const w = Services.wm.getMostRecentWindow("navigator:browser");
  const cards = [...w.document.querySelectorAll(".zen-media-card:not(#zen-media-card-template)")];
  const yt = [...w.gBrowser.tabs].find(t => t.linkedBrowser.currentURI.spec.includes("music.youtube"));
  return JSON.stringify({ cards: cards.length, shown: cards.filter(c => !c.hidden).length,
    playing: yt.linkedBrowser.browsingContext.mediaController.isPlaying });"""


VISIBLE = """const w = Services.wm.getMostRecentWindow("navigator:browser");
  const c = w.gZenMediaController.frontCard?.element;
  const bar = w.document.getElementById("zen-media-controls-toolbar");
  if (!c) return JSON.stringify(false);
  const r = c.getBoundingClientRect(), b = bar.getBoundingClientRect();
  return JSON.stringify(!bar.hidden && b.height >= 8 && r.height >= 8 && !c.hidden
    && !c.hasAttribute("zen-hiding") && r.bottom > b.top + 4 && r.top < b.bottom - 4);"""


def main():
    net = FakeNet(["music.youtube.com", "soundcloud.com", "claude.ai"], handler).start()
    port = regress.free_port()
    proc = regress.launch("/tmp/claude-1000/media-card", port, prefs=net.prefs() +
                          'user_pref("media.autoplay.default", 0);\n'
                          'user_pref("media.autoplay.blocking_policy", 0);\n')
    try:
        m = regress.Marionette(port)
        m.js("""Cc["@mozilla.org/security/x509certdb;1"].getService(Ci.nsIX509CertDB).addCertFromBase64(%s, "C,,");
          const w = Services.wm.getMostRecentWindow("navigator:browser");
          const sys = Services.scriptSecurityManager.getSystemPrincipal();
          const yt = w.gBrowser.addTab("https://music.youtube.com/watch", { triggeringPrincipal: sys });
          w.gBrowser.addTab("https://claude.ai/new", { triggeringPrincipal: sys });
          w.gBrowser.selectedTab = yt; await new Promise(r => setTimeout(r, 6000));
          w.gBrowser.selectedTab = w.gBrowser.tabs[0]; await new Promise(r => setTimeout(r, 2500));
          return "1";""" % json.dumps(net.ca_b64))
        s = json.loads(json.dumps(m.js(STATE)))
        check("card shows while playing", s["shown"] == 1, s)

        lose = """const w = Services.wm.getMostRecentWindow("navigator:browser");
          w.gZenMediaController.frontCard.destroy(); await new Promise(r => setTimeout(r, 200));
          return JSON.stringify(w.document.querySelectorAll(".zen-media-card:not(#zen-media-card-template)").length);"""
        gone = m.js(lose)
        time.sleep(2.8)
        s = m.js(STATE)
        check("lost card comes back by itself", gone == 0 and s["shown"] == 1, f"right after loss={gone} then {s}")

        m.js(lose)
        m.js("""const w = Services.wm.getMostRecentWindow("navigator:browser");
          w.gBrowser.selectedTab = [...w.gBrowser.tabs].find(t => t.linkedBrowser.currentURI.spec.endsWith("claude.ai/new"));
          await new Promise(r => setTimeout(r, 1200)); return "1";""")
        s = m.js(STATE)
        check("switching to Claude brings it back", s["shown"] == 1, s)

        # --- the playing card is the front one, whatever is newer ---
        FRONT = """const w = Services.wm.getMostRecentWindow("navigator:browser");
          return JSON.stringify(w.gZenMediaController.frontCard?.browser.currentURI.host || null);"""
        m.js("""const w = Services.wm.getMostRecentWindow("navigator:browser");
          const sc = w.gBrowser.addTab("https://soundcloud.com/track", {
            triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
          w.gBrowser.selectedTab = sc; await new Promise(r => setTimeout(r, 5000));
          w.gBrowser.selectedTab = w.gBrowser.tabs[0]; await new Promise(r => setTimeout(r, 1500));
          sc.linkedBrowser.browsingContext.mediaController.pause("user");
          await new Promise(r => setTimeout(r, 1500)); return "1";""")
        check("newer paused card stays behind", m.js(FRONT) == "music.youtube.com", f"front={m.js(FRONT)}")
        m.js("""const w = Services.wm.getMostRecentWindow("navigator:browser");
          const tab = h => [...w.gBrowser.tabs].find(t => t.linkedBrowser.currentURI.host === h);
          tab("music.youtube.com").linkedBrowser.browsingContext.mediaController.pause("user");
          tab("soundcloud.com").linkedBrowser.browsingContext.mediaController.play("user");
          await new Promise(r => setTimeout(r, 1500)); return "1";""")
        check("front follows what plays", m.js(FRONT) == "soundcloud.com", f"front={m.js(FRONT)}")
        m.js("""const w = Services.wm.getMostRecentWindow("navigator:browser");
          const tab = h => [...w.gBrowser.tabs].find(t => t.linkedBrowser.currentURI.host === h);
          tab("soundcloud.com").linkedBrowser.browsingContext.mediaController.pause("user");
          tab("music.youtube.com").linkedBrowser.browsingContext.mediaController.play("user");
          await new Promise(r => setTimeout(r, 1500)); return "1";""")

        # --- watchdog: normal use must log nothing ---
        log = "/tmp/claude-1000/media-card/zen-media-watchdog.jsonl"
        for _ in range(4):
            m.js("""const w = Services.wm.getMostRecentWindow("navigator:browser");
              for (const t of [...w.gBrowser.tabs]) { w.gBrowser.selectedTab = t;
                await new Promise(r => setTimeout(r, 1200)); }
              w.gBrowser.selectedTab = w.gBrowser.tabs[0];
              await new Promise(r => setTimeout(r, 1500)); return "1";""")
        lines = lambda: open(log).read().splitlines() if os.path.exists(log) else []
        check("watchdog: quiet in normal use", not lines(), f"{len(lines())} entries")

        # --- each way to vanish must be caught, logged and repaired ---
        faults = {
            "stuck fade-out": 'c.setAttribute("zen-hiding", "true");',
            "bar squashed to 1px": 'bar.style.setProperty("--zen-media-collapsed-height", "1px");',
            "card flagged hidden": "c.hidden = true;",
            "whole bar hidden": 'bar.setAttribute("hidden", "true");',
        }
        for name, fault in faults.items():
            before = len(lines())
            m.js("""const w = Services.wm.getMostRecentWindow("navigator:browser");
              const bar = w.document.getElementById("zen-media-controls-toolbar");
              const c = w.gZenMediaController.frontCard.element; %s return "1";""" % fault)
            time.sleep(1)
            if m.js(VISIBLE):
                # The stack's own layout already undid it: not a way to vanish.
                check(f"watchdog: {name}", not len(lines()) > before, "fixed by layout within 1s, not logged")
                continue
            end = time.time() + 14
            while time.time() < end and len(lines()) == before:
                time.sleep(1)
            time.sleep(0.5)
            entry = json.loads(lines()[-1]) if len(lines()) > before else {}
            vis = m.js(VISIBLE)
            check(f"watchdog: {name}", bool(entry) and entry.get("repaired") and vis,
                  f"invisible, then logged={bool(entry)} repaired={entry.get('repaired')} visible-now={vis} trace={len(entry.get('trace', []))}")

        m.js("""const w = Services.wm.getMostRecentWindow("navigator:browser");
          w.gZenMediaController.frontCard.onClose(); await new Promise(r => setTimeout(r, 300)); return "1";""")
        time.sleep(3)
        s = m.js(STATE)
        hosts = m.js("""const w = Services.wm.getMostRecentWindow("navigator:browser");
          return JSON.stringify([...w.document.querySelectorAll(".zen-media-card:not(#zen-media-card-template)")]
            .map(c => c.querySelector(".zen-media-title")?.textContent || "?"));""")
        yt_card = m.js("""const w = Services.wm.getMostRecentWindow("navigator:browser");
          const yt = [...w.gBrowser.tabs].find(t => t.linkedBrowser.currentURI.host === "music.youtube.com");
          return JSON.stringify(!!w.gZenMediaController.frontCard && w.gZenMediaController.frontCard.browser === yt.linkedBrowser);""")
        check("closed with x stays closed", not yt_card and not s["playing"],
              f"youtube card in front={yt_card} youtube playing={s['playing']} remaining={s['cards']}")
    finally:
        proc.terminate(); proc.wait(15)
    print(f"{sum(RESULTS)}/{len(RESULTS)} passed")
    return 0 if all(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
