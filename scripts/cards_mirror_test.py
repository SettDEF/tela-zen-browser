#!/usr/bin/env python3
"""The read-only card mirror reports what is really on screen: no problems in
a healthy stack, and the right problem the moment a playing card is hidden."""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import regress
import cards_sites_test as T
from fakenet import FakeNet
from media_card_test import MUSIC

PROFILE = "/tmp/claude-1000/cards-mirror"
LIVE, EVENTS = f"{PROFILE}/zen-cards-live.json", f"{PROFILE}/zen-cards-events.jsonl"
ok_all = []


def check(name, ok, detail=""):
    ok_all.append(ok)
    print(("ok    " if ok else "FAIL  ") + f"{name:36} {detail}", flush=True)


def handler(host, path, q):
    return (200, "text/html", MUSIC) if host == "music.youtube.com" else T.handler(host, path, q)


net = FakeNet(["music.youtube.com", "claude.ai"], handler).start()
port = regress.free_port()
proc = regress.launch(PROFILE, port, prefs=net.prefs() +
                      'user_pref("media.autoplay.default", 0);\nuser_pref("media.autoplay.blocking_policy", 0);\n')
try:
    m = regress.Marionette(port)
    T.STATE[("claude.ai", "/chat/mirror")] = "idle"
    m.js("""Cc["@mozilla.org/security/x509certdb;1"].getService(Ci.nsIX509CertDB).addCertFromBase64(%s, "C,,");
      const w = Services.wm.getMostRecentWindow("navigator:browser");
      const sys = Services.scriptSecurityManager.getSystemPrincipal();
      const first = w.gBrowser.selectedTab;
      const yt = w.gBrowser.addTab("https://music.youtube.com/", { triggeringPrincipal: sys });
      w.gBrowser.addTab("https://claude.ai/chat/mirror", { triggeringPrincipal: sys, inBackground: true });
      w.gBrowser.selectedTab = yt; await new Promise(r => setTimeout(r, 5000));
      w.gBrowser.selectedTab = first; return "1";""" % json.dumps(net.ca_b64))
    T.STATE[("claude.ai", "/chat/mirror")] = "running"
    time.sleep(7)
    live = json.load(open(LIVE))
    check("lists the playing tab", any("YouTube" in p for p in live["playing"]), live["playing"])
    check("lists the answering chat", bool(live["answering"]), live["answering"])
    check("healthy stack: no problems", live["problems"] == [], live["problems"])
    check("cards described", {"media", "activity"} <= {c["kind"] for c in live["cards"]},
          [(c["kind"], c["seen"]) for c in live["cards"]])
    before = sum(1 for _ in open(EVENTS))
    m.js("""const w = Services.wm.getMostRecentWindow("navigator:browser");
      // Nothing in the stack resets an inline opacity, so this one stays.
      w.gZenMediaController.frontCard.element.style.opacity = "0";
      return "1";""")
    time.sleep(6)
    live = json.load(open(LIVE))
    check("hidden playing card reported", any("playing not visible" in p for p in live["problems"]), live["problems"])
    check("change appended to the history", sum(1 for _ in open(EVENTS)) > before, "")
finally:
    proc.terminate(); proc.wait(15)
print(f"{sum(ok_all)}/{len(ok_all)} passed")
sys.exit(0 if all(ok_all) else 1)
