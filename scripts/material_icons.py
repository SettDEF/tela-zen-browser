#!/usr/bin/env python3
"""Builds the Android theme's icon set from the Material Symbols font.

For each name in MAP it writes zen-icons/material/<name>.svg, the glyph drawn
from the variable font at weight 400 (FILL 1 for the *-fill names), with
context-fill so toolbar colours still apply. It then derives icons-android.css
from icons.css: every top-level rule that points at one of those icons is
repeated under :root[zen-theme-style="android"] with the Material file.
Rules nested in @media or other blocks keep the default icon.

    python3 scripts/material_icons.py        # rewrites the files, then run the build

The font is the system one (ttf-material-symbols-variable); the generated
files are committed, so building the browser does not need it.
"""
import pathlib, re, sys
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

ROOT = pathlib.Path(__file__).resolve().parent.parent
DIR = ROOT / "src/browser/themes/shared/zen-icons"
FONT = "/usr/share/fonts/ttf-material-symbols-variable/MaterialSymbolsRounded[FILL,GRAD,opsz,wght].ttf"

# default icon file -> (Material Symbols name, filled)
MAP = {
    "back": ("arrow_back", 0), "forward": ("arrow_forward", 0), "reload": ("refresh", 0),
    "close": ("close", 0), "close-filled-round": ("cancel", 1), "plus": ("add", 0),
    "menu": ("menu", 0), "chevron": ("chevron_right", 0), "arrow-up": ("arrow_upward", 0),
    "arrow-down": ("arrow_downward", 0), "arrow-left": ("arrow_back", 0), "arrow-right": ("arrow_forward", 0),
    "sidebar": ("left_panel_open", 0), "sidebar-right": ("right_panel_open", 0),
    "sidebars-right": ("right_panel_open", 0), "expand-sidebar": ("left_panel_open", 0),
    "downloads": ("download", 0), "history": ("history", 0), "bookmark": ("bookmark", 1),
    "bookmark-hollow": ("bookmark", 0), "bookmark-star-on-tray": ("bookmark_star", 0),
    "settings": ("settings", 0), "settings-fill": ("settings", 1), "extension": ("extension", 0),
    "extension-fill": ("extension", 1), "extension-blocked": ("extension_off", 0),
    "library": ("library_books", 0), "passwords": ("key", 0), "home": ("home", 0),
    "search-glass": ("search", 0), "search-page": ("find_in_page", 0), "share": ("share", 0),
    "print": ("print", 0), "save": ("save", 0), "screenshot": ("screenshot_region", 0),
    "private-window": ("domino_mask", 0), "window": ("web_asset", 0), "tab": ("tab", 0),
    "folder": ("folder", 0), "link": ("link", 0), "mail": ("mail", 0), "info": ("info", 0),
    "help": ("help", 0), "trash": ("delete", 0), "edit-delete": ("delete", 0),
    "edit-copy": ("content_copy", 0), "edit-cut": ("content_cut", 0), "edit-paste": ("content_paste", 0),
    "fullscreen": ("fullscreen", 0), "fullscreen-exit": ("fullscreen_exit", 0),
    "zoom-out": ("zoom_out", 0), "split": ("splitscreen", 0), "reader-mode": ("chrome_reader_mode", 0),
    "translations": ("translate", 0), "spell-check": ("spellcheck", 0), "sparkles": ("auto_awesome", 0),
    "security": ("lock", 0), "security-warning": ("warning", 0), "security-broken": ("lock_open", 0),
    "tracking-protection": ("shield", 0), "tracking-protection-fill": ("shield", 1),
    "permissions": ("tune", 0), "permissions-fill": ("tune", 1), "sliders": ("tune", 0),
    "manage": ("tune", 0), "customize": ("dashboard_customize", 0), "developer": ("code", 0),
    "tool-profiler": ("speed", 0), "brackets-curly": ("data_object", 0), "hammer": ("build", 0),
    "boost": ("bolt", 0), "bolt": ("bolt", 0), "eyedropper": ("colorize", 0),
    "media-play": ("play_arrow", 1), "media-pause": ("pause", 1), "media-next": ("skip_next", 1),
    "media-previous": ("skip_previous", 1), "media-mute": ("volume_off", 0), "media-unmute": ("volume_up", 0),
    "microphone": ("mic", 0), "microphone-fill": ("mic", 1), "microphone-blocked": ("mic_off", 0),
    "camera": ("photo_camera", 0), "camera-fill": ("photo_camera", 1), "camera-blocked": ("no_photography", 0),
    "geo": ("pin_drop", 0), "geo-fill": ("pin_drop", 1), "geo-blocked": ("location_off", 0),
    "desktop-notification": ("notifications", 0), "desktop-notification-fill": ("notifications", 1),
    "desktop-notification-blocked": ("notifications_off", 0), "popup": ("open_in_new", 0),
    "popup-fill": ("open_in_new", 1), "screen": ("screen_share", 0), "block": ("block", 0),
    "unpin": ("keep_off", 0), "open": ("open_in_new", 0), "lightbulb": ("lightbulb", 0),
    "face-sun": ("light_mode", 0), "moon-stars": ("dark_mode", 0), "forget": ("mop", 0),
    "send-to-device": ("devices", 0), "new-tab-image": ("add_photo_alternate", 0),
}


def glyph_svg(font, name, size=16):
    gs = font.getGlyphSet()
    pen = SVGPathPen(gs)
    gs[name].draw(TransformPen(pen, (1, 0, 0, -1, 0, 0)))
    return ('<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" fill="context-fill" '
            'fill-opacity="context-fill-opacity" viewBox="0 -960 960 960"><path d="%s"/></svg>\n'
            % (size, size, pen.getCommands()))


def instance(fill):
    f = TTFont(FONT)
    return instantiateVariableFont(f, {"FILL": fill, "GRAD": 0, "opsz": 24, "wght": 400}, inplace=False)


def main():
    out = DIR / "material"
    out.mkdir(exist_ok=True)
    fonts = {0: instance(0), 1: instance(1)}
    made = {}
    for icon, (glyph, fill) in MAP.items():
        font = fonts[fill]
        if glyph not in font.getGlyphOrder():
            print("missing glyph", glyph, "for", icon, file=sys.stderr)
            continue
        (out / (icon + ".svg")).write_text(glyph_svg(font, glyph))
        made[icon] = glyph

    # icons.css rules without nested blocks that use a mapped icon
    css = (DIR / "icons.css").read_text()
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    rules = []
    for m in re.finditer(r"([^{}@;]+?)\s*\{([^{}]*)\}", css):
        sels, body = m.group(1).strip(), m.group(2)
        url = re.search(r'list-style-image:\s*url\("([a-z0-9-]+)\.svg"\)', body)
        if not url or url.group(1) not in made:
            continue
        pref = ",\n".join(':root[zen-theme-style="android"] ' + s.strip() for s in sels.split(",") if s.strip())
        rules.append('%s {\n  list-style-image: url("material/%s.svg") !important;\n}\n' % (pref, url.group(1)))
    header = ("/* Generated by scripts/material_icons.py from icons.css - do not edit.\n * This Source Code Form is "
              "subject to the terms of the Mozilla Public License, v. 2.0. */\n\n")
    (DIR / "icons-android.css").write_text(header + "\n".join(rules))

    # one jar entry per file, outside the per-platform blocks
    jar = ["# Generated by scripts/material_icons.py - do not edit.\n"]
    jar += ["  skin/classic/browser/zen-icons/material/%s.svg  (../shared/zen-icons/material/%s.svg)\n" % (n, n)
            for n in sorted(made)]
    jar.append("  skin/classic/browser/zen-icons/icons-android.css  (../shared/zen-icons/icons-android.css)\n")
    (DIR / "material-jar.inc.mn").write_text("".join(jar))
    print("%d icons, %d rules" % (len(made), len(rules)))


main()
