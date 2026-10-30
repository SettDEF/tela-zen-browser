#!/usr/bin/env python3
"""Compact sidebar in a narrow window: at most 60% of the window, the user's
own width back once there is room, and the stored width never rewritten.
Resizes only the test window (Hyprland, second monitor)."""
import json, os, subprocess, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import regress

ok_all = []


def check(name, ok, detail=""):
    ok_all.append(ok)
    print(("ok    " if ok else "FAIL  ") + f"{name:36} {detail}", flush=True)


def window_of(pid):
    for _ in range(20):
        for c in regress._hypr_json("clients") or []:
            if c.get("pid") == pid:
                return c["address"]
        time.sleep(0.5)
    raise RuntimeError("test window not found")


def resize(addr, w, h):
    # Hyprland 0.56 dispatches Lua; always aimed at the test window's address.
    for lua in (f'hl.dsp.window.float({{ action = "on", window = "address:{addr}" }})',
                f'hl.dsp.window.resize({{ x = {w}, y = {h}, relative = false, window = "address:{addr}" }})'):
        subprocess.run(["hyprctl", "dispatch", lua], capture_output=True, env=regress._hypr_env())
    time.sleep(1.5)
    size = next((c["size"] for c in regress._hypr_json("clients") or [] if c["address"] == addr), None)
    # The browser holds a minimum width (500px), so narrower requests stop there.
    if not size or size[0] > max(w, 500) + 20:
        raise RuntimeError(f"test window did not resize to {w}: {size}")


MEASURE = """
  const w = Services.wm.getMostRecentWindow("navigator:browser");
  const tb = w.document.getElementById("navigator-toolbox");
  Services.prefs.setBoolPref("zen.view.compact.hide-tabbar", false);
  Services.prefs.setBoolPref("zen.view.compact.hide-toolbar", true);
  tb.setAttribute("zen-has-hover", "true");
  await new Promise(r => setTimeout(r, 900));
  const out = { win: w.innerWidth, sidebar: Math.round(tb.getBoundingClientRect().width),
    stored: tb.getAttribute("width") };
  // Hiding needs the sidebar-hiding flavour of compact, as in the compact checks.
  Services.prefs.setBoolPref("zen.view.compact.hide-toolbar", false);
  Services.prefs.setBoolPref("zen.view.compact.hide-tabbar", true);
  // Release every hold, as the compact checks do: a focused urlbar or an
  // open popup keeps the sidebar out by design.
  for (let i = 0; i < 12; i++) {
    tb.removeAttribute("zen-has-hover");
    w.gURLBar.blur();
    w.gZenCompactModeManager._setElementExpandAttribute(tb, false);
    await new Promise(r => setTimeout(r, 400));
    if (tb.getBoundingClientRect().right <= 12) break;
  }
  out.hiddenRight = Math.round(tb.getBoundingClientRect().right);
  return JSON.stringify(out);"""

P = ('user_pref("zen.view.compact.enable-at-startup", true);\nuser_pref("zen.view.compact.hide-toolbar", true);\n'
     'user_pref("zen.view.compact.hide-tabbar", true);\n')
port = regress.free_port()
proc = regress.launch("/tmp/claude-1000/sidebar-narrow", port, prefs=P)
try:
    m = regress.Marionette(port)
    m.js("""const w = Services.wm.getMostRecentWindow("navigator:browser");
      if (!w.gZenCompactModeManager.preference) w.gZenCompactModeManager.toggle(true);
      await new Promise(r => setTimeout(r, 1500));
      w.document.getElementById("navigator-toolbox").setAttribute("width", "330px");
      w.gZenSidebarResizer._syncPin(false); return "1";""")
    addr = window_of(proc.pid)
    resize(addr, 1500, 950)
    wide = m.js(MEASURE)
    check("wide window: the user's width", abs(wide["sidebar"] - 330) <= 2, wide)
    resize(addr, 380, 950)
    narrow = m.js(MEASURE)
    check("narrow window: at most 60%", narrow["sidebar"] <= round(narrow["win"] * 0.6) + 2,
          f"sidebar {narrow['sidebar']} of window {narrow['win']}")
    check("narrow window: page still visible", narrow["win"] - narrow["sidebar"] >= narrow["win"] * 0.35, narrow)
    check("stored width untouched", narrow["stored"] == "330px", narrow["stored"])
    resize(addr, 1500, 950)
    back = m.js(MEASURE)
    check("widened again: the user's width back", abs(back["sidebar"] - 330) <= 2, back)
finally:
    proc.terminate(); proc.wait(15)
print(f"{sum(ok_all)}/{len(ok_all)} passed")
sys.exit(0 if all(ok_all) else 1)
