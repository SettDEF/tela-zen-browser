#!/usr/bin/env python3
"""Random use of the card stack - media plus AI chats - checking after every
settled step that what should be seen can be seen:
  1. media playing in a background tab: its card is visible in the bar;
  2. a chat answering in a background tab: the Activity card is visible.
Seeded, so a failing run replays exactly: media_stress_test.py [steps] [seed]
Pages at real hostnames via fakenet; opens on the second monitor."""
import json, os, random, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import regress
import cards_sites_test as T
from fakenet import FakeNet
from media_card_test import MUSIC

STEPS = int(sys.argv[1]) if len(sys.argv) > 1 else 150
SEED = int(sys.argv[2]) if len(sys.argv) > 2 else int(time.time())
MEDIA = ["music.youtube.com", "soundcloud.com", "www.youtube.com"]
CHATS = [("claude.ai", "/chat/stress-1"), ("claude.ai", "/chat/stress-2"),
         ("chatgpt.com", "/c/stress"), ("gemini.google.com", "/app/stress")]
rng = random.Random(SEED)


def handler(host, path, q):
    if host.removeprefix("www.") in ("music.youtube.com", "soundcloud.com", "youtube.com"):
        return 200, "text/html", MUSIC
    return T.handler(host, path, q)


CHECK = """
  const w = Services.wm.getMostRecentWindow("navigator:browser");
  const d = w.document, bar = d.getElementById("zen-media-controls-toolbar");
  const b = bar.getBoundingClientRect();
  const seen = el => { if (!el || el.hidden || el.matches("[zen-hiding],[zen-removing],[stack-overflow]")) return false;
    const r = el.getBoundingClientRect(), cs = w.getComputedStyle(el);
    return r.height >= 8 && +cs.opacity > 0.2 && r.bottom > b.top + 4 && r.top < b.bottom - 4; };
  const sel = w.gBrowser.selectedBrowser;
  const bg = [...w.gBrowser.tabs].map(t => t.linkedBrowser).filter(br => br !== sel);
  const playing = bg.filter(br => br.browsingContext?.mediaController?.isPlaying);
  const mediaCards = [...d.querySelectorAll(".zen-media-card:not(#zen-media-card-template)")];
  const P = w.gZenPageCards;
  const answering = bg.filter(br => P._tabs.get(br)?.running);
  const activity = [...d.querySelectorAll(".zen-page-card")].find(c => c.textContent.includes("Activity"));
  const stack = (w.gZenCardStack?.cards() || []).map(c =>
    (c.classList.contains("zen-media-card") ? "M" : c.textContent.includes("Activity") ? "A" : "P") +
    (c.hasAttribute("stacked-behind") ? "b" : "f") + (seen(c) ? "" : "!"));
  return JSON.stringify({
    playing: playing.map(br => br.currentURI.host),
    playingCardSeen: playing.length ? mediaCards.some(c => seen(c) && c.classList.contains("playing")) : null,
    answering: answering.map(br => br.currentURI.host),
    activitySeen: answering.length ? seen(activity) : null,
    barH: Math.round(b.height), barHidden: bar.hidden, stack: stack.join(" ") });
"""

ACT = {
    "select": """const w = Services.wm.getMostRecentWindow("navigator:browser");
      w.gBrowser.selectedTab = w.gBrowser.tabs[%d %% w.gBrowser.tabs.length]; return "1";""",
    "pause": """const w = Services.wm.getMostRecentWindow("navigator:browser");
      const t = [...w.gBrowser.tabs].find(t => t.linkedBrowser.currentURI.host === %s);
      t?.linkedBrowser.browsingContext.mediaController?.pause("user"); return "1";""",
    "play": """const w = Services.wm.getMostRecentWindow("navigator:browser");
      const t = [...w.gBrowser.tabs].find(t => t.linkedBrowser.currentURI.host === %s);
      t?.linkedBrowser.browsingContext.mediaController?.play("user"); return "1";""",
    "reopen": """const w = Services.wm.getMostRecentWindow("navigator:browser");
      const sys = Services.scriptSecurityManager.getSystemPrincipal();
      const old = [...w.gBrowser.tabs].find(t => t.linkedBrowser.currentURI.host === %s);
      const url = old ? old.linkedBrowser.currentURI.spec : "https://" + %s + "/";
      if (old) w.gBrowser.removeTab(old);
      const t = w.gBrowser.addTab(url, { triggeringPrincipal: sys });
      const back = w.gBrowser.selectedTab; w.gBrowser.selectedTab = t;
      await new Promise(r => setTimeout(r, 2500)); w.gBrowser.selectedTab = back; return "1";""",
    "hover": """const tb = Services.wm.getMostRecentWindow("navigator:browser").document.getElementById("navigator-toolbox");
      tb.toggleAttribute("zen-has-hover", %s); return "1";""",
    "compact": """Services.wm.getMostRecentWindow("navigator:browser").gZenCompactModeManager.toggle(%s); return "1";""",
}


def main():
    net = FakeNet(MEDIA + ["claude.ai", "chatgpt.com", "gemini.google.com"], handler).start()
    port = regress.free_port()
    proc = regress.launch("/tmp/claude-1000/media-stress", port, prefs=net.prefs() +
                          'user_pref("media.autoplay.default", 0);\nuser_pref("media.autoplay.blocking_policy", 0);\n')
    history, failures, checks = [], [], 0
    try:
        m = regress.Marionette(port)
        urls = [f"https://{h}/" for h in MEDIA] + [f"https://{h}{p}" for h, p in CHATS]
        m.js("""Cc["@mozilla.org/security/x509certdb;1"].getService(Ci.nsIX509CertDB).addCertFromBase64(%s, "C,,");
          const w = Services.wm.getMostRecentWindow("navigator:browser");
          const sys = Services.scriptSecurityManager.getSystemPrincipal();
          for (const u of %s) { const t = w.gBrowser.addTab(u, { triggeringPrincipal: sys });
            w.gBrowser.selectedTab = t; await new Promise(r => setTimeout(r, 2500)); }
          w.gBrowser.selectedTab = w.gBrowser.tabs[0]; return "1";""" % (json.dumps(net.ca_b64), json.dumps(urls)))
        for step in range(STEPS):
            kind = rng.choice(["select"] * 4 + ["pause", "play", "play", "reopen", "hover", "compact"] + ["chat"] * 3)
            if kind == "chat":
                h, p = rng.choice(CHATS)
                T.STATE[(h, p)] = rng.choice(["idle", "running", "running", "done"])
                history.append(f"{step}:chat({h}{p}={T.STATE[(h, p)]})")
            else:
                a = {"select": lambda: rng.randrange(10), "pause": lambda: json.dumps(rng.choice(MEDIA)),
                     "play": lambda: json.dumps(rng.choice(MEDIA)), "hover": lambda: rng.choice(["true", "false"]),
                     "compact": lambda: rng.choice(["true", "false"]),
                     "reopen": lambda: (lambda x: (json.dumps(x), json.dumps(x)))(rng.choice(MEDIA))}[kind]()
                m.js(ACT[kind] % a)
                history.append(f"{step}:{kind}({a[0] if isinstance(a, tuple) else a})")
            time.sleep(rng.choice([0.2, 0.6, 1.5]))
            if rng.random() < 0.35 or step == STEPS - 1:
                # Settled: hides, reveals and the chat pages' 250ms polls have run.
                time.sleep(2.5)
                out = m.js("""const tb = Services.wm.getMostRecentWindow("navigator:browser").document.getElementById("navigator-toolbox");
                  return JSON.stringify(tb.getBoundingClientRect().right > 20);""")
                if not out:
                    continue  # sidebar collapsed in compact mode: nothing is meant to be seen
                checks += 1
                s = m.js(CHECK)
                bad = []
                if s["playingCardSeen"] is False:
                    bad.append("playing media not visible")
                if s["activitySeen"] is False:
                    bad.append("answering chat has no visible Activity card")
                if bad:
                    failures.append({"step": step, "why": bad, "state": s, "last": history[-8:]})
                    print(f"FAIL  step {step}: {bad} | stack={s['stack']} bar={s['barH']}px hidden={s['barHidden']} "
                          f"playing={s['playing']} answering={s['answering']}", flush=True)
                    print(f"      last steps: {history[-8:]}", flush=True)
    finally:
        proc.terminate(); proc.wait(15)
    with open("/tmp/claude-1000/media-stress-failures.json", "w") as f:
        json.dump({"seed": SEED, "failures": failures}, f, indent=1)
    print(f"seed={SEED} steps={STEPS} checks={checks} failures={len(failures)}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
