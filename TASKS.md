# tela-zen — open tasks

Working list for the sidebar-urlbar / layout work. Newest requests at the top
of each section. Anything under "Done" is built and running in the test
profile (`~/.tela-zen-profile`) but **not committed**.

## Open

### 60. MonkeyStyles: our own userscript + userstyle manager — PHASE 2 BUILT 2026-10-28
Asked 2026-10-28: replace Violentmonkey/Tampermonkey and Stylus with our own extension that
has "all what they have or more". Violentmonkey and Stylus stay installed until each script and
style has moved and been checked - no gap where things stop working.

Foundations (checked in this engine):
- Scripts: a built-in extension (`browser/extensions/`, like pictureinpicture/webcompat) on the
  MV3 `userScripts` API: register/update/unregister/getScripts/execute, per-script worlds
  (`configureWorld`, `worldId`), `runtime.onUserScriptMessage`/`onUserScriptConnect` as the GM
  channel. Firefox does the sandboxing and the site CSP; we write the GM layer.
- Styles: per-site sheets via `nsIStyleSheetService` from an actor, as Zen Boosts does
  (`src/zen/boosts/ZenBoostStyles.sys.mjs`, `actors/ZenBoostsChild.sys.mjs`); look at extending
  Boosts before duplicating it.

Parity checklist - scripts (Violentmonkey + Tampermonkey):
- Metadata: @match/@include/@exclude/@exclude-match, @run-at (document-start/body/end/idle),
  @noframes, @inject-into (page/content/auto), @grant, @connect, @require, @resource, @icon,
  @version, @updateURL/@downloadURL, @namespace, localized @name:xx, @unwrap, @top-level-await.
- GM API, sync and async (GM_* and GM.*): getValue/setValue/deleteValue/listValues,
  get/setValues, addValueChangeListener (across tabs), xmlhttpRequest (all response types,
  streams, anonymous, cookies per @connect), download, openInTab, setClipboard, notification,
  registerMenuCommand/unregister, addStyle, addElement, getResourceText/URL, info, log,
  getTab/saveTab/getTabs, cookie (TM), unsafeWindow, window.onurlchange (TM), webRequest (TM).
- Manager: script list with on/off, per-site on/off, run order, error log per script, script
  values editor, update checks (interval, per script), install by URL / drag-drop / file,
  install page with diff on update, backup/restore (VM zip and TM json import), trash, search.
- Editor: CodeMirror with lint, metadata autocomplete, hot reload.
Parity checklist - styles (Stylus):
- UserCSS with @var (text/color/checkbox/select/number/range), preprocessors (stylus, less,
  uso), @-moz-document url/url-prefix/domain/regexp, live reload from URL or file, update
  checks, per-site toggle, style order, import of Stylus backups, usercss.world install.
"More" (only we can do these):
- Folders as the source: `~/.config/tela-zen/scripts/*.user.js`, `styles/*.user.css`, watched,
  live reload on save - edit in any editor, keep it in git. tinct's theme dir as a style source.
- Bridge: scripts reach the media bridge and the dock without GM_xmlhttpRequest/@connect.
- One place: Boosts, mods, scripts and styles in one settings page; errors in the browser console
  with the script's file and line.
- No duplicates: the manager refuses a second copy of the same @namespace/@name.

Phase 1 findings (2026-10-28, engine read, nothing run):
- MV3 userScripts: no gating pref; `userScripts` is OptionalOnlyPermission and nothing grants it,
  builtin or not (schemas/user_scripts.json:4-13,35; Extension.sys.mjs:223-225,4215). Grant it
  from our own experiment API: `ExtensionPermissions.add(id, {permissions:["userScripts"], origins:[]})`.
- Worlds: per-script `worldId` (USER_SCRIPT world), `configureWorld({worldId, csp, messaging})`;
  messaging=true exposes runtime.sendMessage, which reaches only `runtime.onUserScriptMessage`
  (sendResponse / return true): the GM channel (ExtensionUserScriptsContent.sys.mjs:41-50,170).
  Sources as `{code}`; runAt, allFrames, matches/excludeMatches, include/excludeGlobs.
- Builtin add-ons: `browser/extensions/<name>/` + jar.mn (`builtin-addons/<name>/...`) + DIRS;
  auto-installed by SystemBuiltInLocation, privileged (Extension.sys.mjs:976-982); bump
  `version` on every change. Experiment APIs allowed (pictureinpicture's aboutConfigPipPrefs is
  the in-tree example) - Services/IOUtils there, so folder reading and watching go through one.
- Zen Boosts: exact host, top frame only, iframes skipped on purpose - not a base for userstyles.
  Styles go through the extension (scripting.registerContentScripts css / insertCSS, patterns, all frames).
Design (changed 2026-10-28, user: "not build in, it should work for firefox"): a NORMAL MV3
WebExtension, installable in any Firefox >= 136 - not a builtin, no experiment APIs.
- `userScripts` in optional_permissions, asked once with permissions.request (one prompt).
- Folders as source: optional native-messaging companion (small Python host, inotify on
  ~/.config/tela-zen/{scripts,styles}) pushing into the extension; without it scripts live in
  extension storage like Violentmonkey.
- Release Firefox needs signing: unlisted via `web-ext sign` (user's AMO API key). tela-zen /
  Developer Edition can run it unsigned.
- One world per script with a GM prelude talking to the background; styles via
  scripting.registerContentScripts (css, patterns, all frames).
- Name: MonkeyStyles (user's pick 2026-10-28, ID `monkeystyles@tela`, project /mnt/storage/dev/projects/monkeystyles). namecheck: CLEAR on the US register as "MonkeyStyles" and "Monkey Styles"; monkeystyles.com taken; EU/DPMA not checked.
  Earlier proposal: Slipcue (DJ slip-cueing). namecheck: CLEAR on the
  US register as "Slipcue" and "Slip cue"; slipcue.com taken, slipcue.audio free; EU/DPMA not
  checked. "Overdub" rejected: Descript's well-known voice feature. The ID comes from the
  product, not the company (name not final), so it never has to change.
- "My style" = how it works, the user's way: files and folders over hidden databases, live
  reload on save, drivable from the desktop (bridge, dock, CLI), one app, no duplicates.
- Look (user: "like tampermonkey x stylus but in my style"): Material 3 Expressive as in Takt Play
  (`wavr-play/src/components/materialShapes.ts`, morphing shapes, spring motion), colours as
  tinct roles (light/dark, follows the user's themes), Nova radii (#42). One app for both.
Unchecked: run_at enum values, matchAboutBlank in the MV3 type.

Phase 2 (2026-10-28): /mnt/storage/dev/projects/monkeystyles. Store, metadata, registration (own world
per script, @include regexes checked in-page), GM values (sync + async, cross-tab listener),
xmlhttpRequest with @connect, menu commands (popup), notification, openInTab, setClipboard,
addStyle/addElement, resources, @require; manager (grant banner, install by URL, editor, on/off,
remove) and popup in M3 Expressive. Proof: test/meta.test.js (caught @noframes swallowing the next
line) and test/firefox_test.py - headless Firefox 158, 13/13, no window.
Tracking moved 2026-10-28: /mnt/storage/dev/projects/monkeystyles/TASKS.md and dotos 255ae595.
Source read DONE: monkeystyles/docs/design-notes.md. Our one-world-per-script beats VM's MV3 per-URL bag
(it loses @noframes and real matches); take over: run order = registration order, request-scoped
header/cookie rules for xhr, install interception, alarm-based updates, VM/TM backup zip format.
Phases:
1. DONE - Engine read: userScripts API limits in this Firefox (MV3 only? permission prompts for a
   built-in add-on? worlds per script), how a built-in add-on is packaged here, Boosts' backend.
2. Extension skeleton: register one folder script, GM_getValue/setValue/xmlhttpRequest/
   registerMenuCommand/info; run ytm-bridge and watch-tracker from it beside Violentmonkey.
3. Full metadata + GM API, error log; manager page; install by URL; updates.
4. Styles: UserCSS + @var + @-moz-document, live reload; tinct themes.
5. Editor, import from Violentmonkey/Tampermonkey/Stylus backups, then move the user's scripts
   one by one and switch the extensions off.

### 59. Media bridge for every tab and site (grows out of #58) — IN PROGRESS 2026-10-28
Status 2026-10-28 03:15: steps 1-2 LIVE in -41 (installed 03:09). Verified in the user's
browser: `media list`, per-tab pause/play by number and by site, volume 5->6->5, unknown tab refused.
Bug found live: position froze at the page's first value - Gecko's getPositionState() is only
what the page last set (YTM sets it once). Fix built, NOT packaged: zen-media-frame.js reports the
live playhead (YT player API, else the element), preferred over the snapshot.
-42 installed 03:17: live playhead verified (browser 31.1 posted 8.1 s earlier = 39.2 vs adapter
40.4). `media list` now moves positions on from `seen`. Seek/forward/back PAUSE on YT Music (its
seek handler pauses; the card resumes after seekTo for this). Fixed in the module (resume if it
was playing) - built, NOT packaged (-43); until then the CLI sends play after a seek. Verified:
seek +2 s kept playing. The dock's direct POSTs have no such workaround until -43.
Test harness: `scripts/media_bridge_test.py` launches stole the user's focus twice (workspace 9),
even without a URL argument; the focus guard kills it but the switch already happened. Do not
run it again until the cause is known.
Asked 2026-10-28: control media in every tab separately, on any site; a site database with
per-site adapters; videos visible in the quickshell now-playing dock.
1. Rename: `~/.scripts/ytm` -> `~/.scripts/media`, `ytm-bridge.service` -> `media-bridge.service`;
   `ytm` stays a forwarder for now; port 8788 and `/state` (the current player, as today) stay,
   since `NowPlayingDock.qml` reads them.
2. Browser module (`TelaMediaBridge.sys.mjs`): every tab with media via Gecko's per-tab
   MediaController - list (tab id, site, metadata, art, playing, position) and commands
   (toggle/play/pause/next/prev/seek) per tab. Bridge: `/tabs`, `/tabs/<id>`, `media list`, `media <tab> <cmd>`.
3. Site database + adapters (match pattern -> extras such as open, lyrics, queue). YTM first,
   from `userscripts/ytm-bridge.user.js`; adapters built in rather than userscripts (no installs,
   no Tampermonkey duplicates). Other sites: not chosen yet.
4. Live video in the dock (user chose this over the shell playing links itself): the browser
   grabs frames from the tab's playing `<video>` and serves a stream (`/tabs/<id>/video`, ~15 fps,
   dock size, only while someone watches); the dock shows it, controls still go to the tab.
   Measure the capture's CPU before building the dock side.
   Dock UI (asked 2026-10-28): a Song / Video switch like YT Music's - Song shows the cover
   (`artUrl`), Video the live stream; on music.youtube.com it also flips YTM's own Song/Video
   mode through the adapter. The dock is the quickshell session's file; this side provides
   `/tabs/<id>/video` and a `hasVideo` field per tab.
   Controls (asked 2026-10-28): take them from Takt Play
   (`/mnt/storage/dev/projects/WAVR_container/wavr-play`, React): `SquiggleSeek.tsx` (wavy played
   part that flows while playing, flat when paused, draggable thumb), the morphing play button
   (`materialShapes.ts`), and `MiniPlayer.tsx`'s swipes (left/right = next/prev). Port to QML in
   the dock; seek/volume go to `/tabs/<id>/cmd` (or `/cmd` for the YTM tab).
Lyrics line tracking (fixed 2026-10-28): the bridge's `seen` was bumped by every command poll,
   so the dock extrapolated a stale position from a fresh time and the line jumped back up to
   15 s. `seen` is now when the state arrived (0 backward jumps in 90 samples, live). Seeks:
   adapter 1.1.4 reports on >1 s drift, checked every 0.5 s - not yet installed by the user.

### 58. Background YouTube Music from the desktop (ytm bridge) — LIVE 2026-10-28
Requested 2026-10-28: play YTM in the logged-in tela session from the desktop, tab in the
background (no focus, no raise), and a share-panel target for YouTube links.
- `userscripts/ytm-bridge.user.js` (Violentmonkey, music.youtube.com): long-polls
  `127.0.0.1:8788/poll`, posts `/state` every 2s on change. Uses `GM_xmlhttpRequest` (YTM's CSP
  blocks a plain fetch). `open` uses the SPA's own `yt-navigate` (keeps the queue, plays in a
  background tab; a reload would wait for the tab to be foregrounded), `loadVideoById` as fallback.
- `~/.scripts/ytm`: the bridge (`ytm serve`, `~/.config/systemd/user/ytm-bridge.service`) and
  CLI: `status [--json]`, `toggle|play|pause|next|prev`, `open <url|id>`, `volume N`. A command
  fails with "no YouTube Music tab connected" if no page fetched it within 3s.
- Share target `~/.config/share/targets/21-ytmusic` ("Play in YT Music (background)"), notifies on failure.
- Test: `scripts/ytm_bridge_test.py` — logged-out throwaway browser on an unseen workspace,
  volume_scale 0 (a logged-in second session could pause the user's own playback).
Live: service enabled, userscript installed by the user; status/pause/play verified on their session.
Lyrics (1.1.0, asked by the shell session for the now-playing dock): `lyrics` in /state = [{t, line}] when YTM gives cue times (ANDROID_MUSIC browse, signed in via SAPISIDHASH), else the plain string, null when none; cached per videoId. Live 1.1.3 (2026-10-28): plain lyrics arrive in the user's tab (Never Gonna Give You Up), no error; timed did not come back - the ANDROID_MUSIC try gives no cue times or fails silently (its error is swallowed). `script` in /state = running version. Trap: an old copy in Tampermonkey ran beside Violentmonkey; both got every command (a toggle would cancel out).
Left: `open`/`next` and the share target not yet tried live (they change the track). The test fails at connect: its fetch shim, not GM_xmlhttpRequest - fix or drop it.

### 50. Test browsers must not publish MPRIS (they take over the desktop media widget) — OPEN 2026-10-14
The regression suite's browsers play `/tmp/claude-1000/regress-tone-*.html` and each one
registers `org.mpris.MediaPlayer2.firefox.instance_*` ("tela-zen – Regress Tone"). The user saw
the test tone in the dock's media widget instead of their YouTube Music track. The shell now
ignores browser duplicates when picking its player (`services/MprisController.qml`), but the
tests should not appear on the session bus at all:
- In the test profile/launch prefs (`regress.launch`), set `media.hardwaremediakeys.enabled =
  false` (no MPRIS service) — except in the one test that checks MPRIS (#49), which should use
  its own bus or clean up right after.
- Delete the `regress-tone-*.html` files when a run ends (≈25 × 640 KB left in /tmp/claude-1000).

### 49. MPRIS: real metadata from the page's Media Session, and the tab URL — FIXED in -18 2026-10-14, switch pending
Cause: Plasma Browser Integration's page-script.js redefines navigator.mediaSession.metadata and
playbackState with accessors that never call the native setters, so Firefox (cards and its own
MPRIS player) only ever had the page title. Nothing in the fork dropped it: with no extension a
test browser carried title and artist. Fix: zen-media-frame.js copies the page's value into the
real session through an Xray while media plays, only on pages with that override
(`zen.mediacontrols.mirror-session`). `scripts/mpris_metadata_test.py` 3/3 (hooked page: the
controller and the test browser's own MPRIS player show title|artist; mirror off: page title only).
SoundCloud: its bundle sets mediaSession.metadata {title, artist: uploader, album, artwork} - same
path. Could not play it under automation (navigator.webdriver); verified from its code only.
Filter: ~/.config/rescrobbled/ytmusic-only.sh now also passes soundcloud.com (backup .bak-20261014).
Left: once -18 is installed and running, switch player-whitelist to firefox and the filter's
`playerctl -p` to firefox - not before, or scrobbling stops until then.
Also in -18: card icon click goes to its tab (MediaController.focus() left an essential
unselected; media_focus_test 5/5, fails 3/5 with the old path), and the 4th card in an open stack
takes the pointer (card_stack_gap_test 8/8).

---- original request ----
Requested for Last.fm scrobbling + Discord status from **YouTube Music only** (desktop side is
done: rescrobbled in `~/.config/rescrobbled/`, filter `ytmusic-only.sh`). tela-zen's own MPRIS
player (`org.mpris.MediaPlayer2.firefox.instance_*`) publishes only the document title
(`xesam:title = "Free Murder | YouTube Music"`, empty `xesam:artist`/`xesam:album`, artist
"tela-zen" on other pages), although music.youtube.com sets `navigator.mediaSession.metadata`
(title, artist, album, artwork). Today the scrobbler has to use the KDE Plasma Browser
Integration player instead, which does carry artist/album/url.
- Publish `navigator.mediaSession.metadata` title/artist/album and `mpris:artUrl` (largest
  artwork) from the playing tab — check `media.mediacontrol.*` / `MPRISServiceHandler` first;
  stock Firefox does this, so something in the fork or a pref drops it.
- Keep `xesam:url` = the playing tab's URL (already works: `https://music.youtube.com/`), so
  desktop filters can tell YouTube Music from YouTube videos.
- Done when `playerctl -p firefox metadata` shows artist + album for a YouTube Music track.
  Then switch `player-whitelist` in `~/.config/rescrobbled/config.toml` to the firefox player
  and the filter's `playerctl -p` to match, so the Plasma integration is no longer needed.

### ~~56. Media card stayed hidden after its video left fullscreen~~ — DONE 2026-10-14

A card hides while its video is fullscreen or in PiP. Gecko fires
`pictureinpicturemodechange` for PiP but nothing when *fullscreen* ends
(MediaController::NotifyMediaFullScreenState only notifies internally), and
leaving fullscreen lands just after the tab switch that ends it - so the card
read "still fullscreen", hid, and was never re-checked. Hit by sites that
fullscreen the `<video>` itself (direct video files, e.g. cdn.discordapp.com);
YouTube fullscreens a wrapper and was fine. Fix: while hidden for
fullscreen/PiP the card re-checks every 400ms (ZenMediaController
`#watchFullscreen`). `scripts/card_fullscreen_test.py` 3/4 before, 4/4 after.
`scripts/card_single_vis_test.py` (random switches/flips/clicks/hover, compact
on or off) 110/110 without the fix - not the cause, kept as a guard.
Tracer: also samples 450ms after the sidebar slides in; stacked-behind cards
no longer flagged as "covered"; logs bar hover/focus/reveal and card inner style.

### ~~57. New tab in Juxtopposed's style~~ — DONE 2026-10-14

From her transcripts (docs/juxtopposed/reference.md): search box first ("a
search bar to put the question in and get going"), category filters right
under it, quick-access shortcuts next to search, no clutter. Page now: engine
icon + box (address or search, via uriFixup), Images/News/Videos/Maps chips
per engine (Google, DDG, Bing, Brave, Startpage), 8 top-origin tiles, 6
history cards, "Earlier" list. Uses the browser's font, `--tela-radius`,
`--tela-surface`, accent and text colours, read from the chrome window.
Fixed: empty section headings showed (`.sect{display:flex}` beat `hidden`);
serif headlines. `Services.search` is gone in 154 - uses SearchService.sys.mjs.
`scripts/newtab_test.py` 9/9.

### ~~55. Agent control could not be switched back on; panel padding~~ — DONE 2026-10-14
Stop turns `zen.agent.enabled` off on purpose (it came back every launch), and the panel then said
"Off" with no control; turning the setting on only cleared a flag, so only a restart helped.
Now the off panel offers "Start: own tab only" / "Start: may use this tab" (re-enables the
setting), the setting starts the channel at once, and concurrent starts are guarded (the second
waits, then switches mode). Panel padding 16+12 -> 6+4. `scripts/agent_panel_test.py` 7/7.

### Card log names what covers a card — 2026-10-14 (diagnostic for the vanished card)
The user saw the music card hidden under the tab list while the log called it visible ("seen"
only measured the card; not reproduced in test windows). The log now records the element at each
card's centre, the card's computed style and the tab list rect, and files "card covered ... by ..."
as a problem. `scripts/card_cover_trace_test.py` proves it names a covering element.

### 54. Juxtopposed-led UI pass — IN PROGRESS 2026-10-14
Horizontal tab strip read small and soft on the user's monitor: titles were fixed 12px (group
labels 11px) next to the 14.7px UI font. Now relative to the UI font (1em / 0.85em), strip
36 -> 40px. urlbar-centres-and-returns and the rest of regress pass.
Reference: docs/juxtopposed/reference.md (her video list; her own points still to be read - agent
control is off, YouTube blocks transcript downloads here). Done from her documented "design
consistency" criterion: one row radius, cards on the sidebar's text size and one padding, cards on
the address bar's raised grey instead of near-black (dark + light checked by screenshot).
Second pass, everywhere: menus/panels/⋯ panel/tooltips/toasts/Settings on one shape rule
(surface 10, rows 6, text buttons pills) and one surface colour `--tela-surface`; audited per
surface before and after. Left: Settings colour pass (tiles ~= page, purple accent).

### ~~53. Music card came back half a second late~~ — DONE 2026-10-14
Zen waits after a tab switch before re-showing a card (anti-flicker); at 500ms the user caught
the gap (log: hidden at 17.341, shown 17.844). Now 120ms: back by 250ms, measured.

### ~~52. Band over the tab list after hovering the stack~~ — DONE 2026-10-14
User's log: bar 115px over a 34px card. When the cards changed with the pointer on the stack, the
front card was measured with its title/progress rows unfolded and kept as the resting height.
measure() now skips the resting height while hovered or held (marks it stale) and measures again
350ms after the stack folds. `scripts/card_band_test.py` reproduces it (was 115/34, now 34/34).

### ~~51. Card stack stays open while a card's ⋯ menu is up~~ — DONE 2026-10-14
`gZenCardStack.hold()`: the media panel holds the stack (locked :hover, full reveal, pointerleave
ignored) from popupshowing to popuphidden; folds on close if the pointer is elsewhere.
`scripts/stack_hold_test.py` 3/3.

### ~~50. Card stack hole, urlbar with breakout off, panel names its tab~~ — DONE 2026-10-14
- Opened card stack showed a hole between cards of different heights: the open height summed
  the cards' held (stacked) heights, and the bar's space-between put the spare between them.
  Now summed from each card's content, and the stack packs from the bottom.
  `scripts/card_stack_gap_test.py` 6/6 (both orders: gap = stack gap, bar fits exactly).
- User's profile has `zen.urlbar.disable-breakout`: the field is then a row item and was squeezed
  back to the row while the results widened. Overlay now lifts the field out of the row itself
  (`zen-urlbar-lift`, slot height held). urlbar_overlay_test 24/24 incl. that case.
- "Doesn't work in YT Music": the card on screen was a paused YouTube tab's (YT Music's own card
  hidden while on its tab), so ⋯ was setting that tab's volume. The panel now leads with the
  tab's icon and name. media_more_test 14/14.

### ~~47. Dotfile: ~/.config/tela-zen/config.toml~~ — DONE 2026-10-14
`TelaConfig.sys.mjs`. TOML subset ([section], key = value, # comments; strings, integers,
booleans). Friendly keys (`KEYS`: layout, tabs, glow, urlbar, spaces, media, glance,
translations) plus `[prefs]` for any about:config name. Read synchronously in
ZenStartup.init so the first window lays out with it; re-read on mtime change (1s poll).
Entries become locked defaults (greyed in Settings); a deleted line unlocks and restores the
old default, so a value the user set in Settings comes back. Bad lines are reported with line
numbers and skipped. Settings > Look and Feel > Config file: path, status, errors, Create from
my settings (live lines for changed settings, the rest commented with defaults), Open, Folder.
Test browsers point `zen.config.file` at a missing file (regress.launch) so the user's dotfile
never leaks into the suite. Test: `scripts/config_test.py` 14/14.

### ~~48. Translated sites remembered, with a list~~ — DONE 2026-10-14
`zen.translations.sites` ({host: {from, to, auto, at, title}}, newest 200): recorded when a page
is translated; returning to the site translates it again by itself, once per load, while
`zen.translations.remember-sites` and the site's own switch are on. Lists: right-click the
Translate button (recent 12, click opens the site), Settings > Tab Management > Translated sites
(languages, date, per-site switch, remove, forget all). Test: `scripts/translation_sites_test.py`
7/7 with real models; translations_button_test 12/12.

### ~~46. Address bar as an overlay; field and results one grey~~ — DONE 2026-10-13
Focusing the sidebar address bar used to widen the whole sidebar (`_anchorWide`/`_setWidth`),
a width animation that re-laid-out the tab list every frame - the cost on slow machines.
`zen.urlbar.sidebar.overlay` (default on): the field (already `position: absolute`, Firefox's
breakout) widens alone and the toolbox's layer goes above the page; results are an absolute
overlay under it, animated with opacity/transform only, on a solid base so sidebar text does
not show through. Compact pins the field inline !important, so the overlay width is set
inline too and restored on blur. While results show, field and results share the field's
grey (`--zen-sidebar-results-bg`).
Field and open results are one panel: the panel starts at the field's exact bottom edge,
same x and width (unrounded; right side anchored on the field's right edge, which does not
move), seam corners squared.
Test: `scripts/urlbar_overlay_test.py` 18/18 (comfortable, compact, right side: sidebar width
identical on every frame, field/results over the page, exact rest rect on blur).
`urlbar-sidebar-geometry` updated to the new contract (focused: sidebar width and left edge
fixed, may grow outward; at rest unchanged). Regress 0 failed.

### ~~45. Tab colours, update card, media card on its own tab, urlbar surface~~ — DONE 2026-10-13
- Tab colours (`zen.tabs.look.color` off/selected/all): a tab's own or site colour drives its
  selection (mark/fill/outline/bold) and, on "all", tints every coloured tab. Uncoloured tabs
  untouched. Right-click > Appearance > Colour (moved up from Tab Focus). tab_looks_test 26/26.
- "Update Complete!" card restyled as one of our cards (left title + version, rows, countdown
  hairline at the bottom); the rainbow text is gone. Links unchanged (upstream Zen's).
- Why the YT Music card never showed: the user's own card log - YT Music's card existed every
  time it played, hidden because it was the selected tab (Zen's rule). New
  `zen.mediacontrols.show-on-own-tab` (Settings > Pop-out video). Also fixed: the ⋯ button
  pushed the card's close button outside the card when there is no PiP button.
- Tab colours reach the horizontal strip (its tiles mirror the tab, incl. pinned/essential
  icon tiles) and sidebar essentials. Tab Focus submenu renamed "Glow" (was a second
  "Change color" beside Colour).
- Right rail: hover/pressed backgrounds were painted on the 20px icon box Firefox uses, so
  they hugged the glyph; now on the 36px button.
- Sidebar urlbar: while results show, the field takes the results' background
  (`--zen-sidebar-results-bg`). Known flake: media_more_test's panel-open check failed once,
  passed 2/2 on rerun.

### ~~44. Spaces: easier, and one per virtual desktop~~ — DONE 2026-10-13
Ctrl+1..9 switch spaces on Linux (Firefox uses Alt+N for tabs there; Zen left these unbound
off macOS). Shortcut version 23 binds them only where unbound; checked against a copy of the
user's real shortcuts file - no conflicts. Settings › Tab Management › Your spaces lists
every space, has New space, and "Each virtual desktop shows its own space" (off by default).
`ZenDesktopSpaces.sys.mjs`: on window focus, ask the desktop which one is current
(hyprctl / swaymsg / i3-msg / KWin over gdbus / EWMH via xprop); desktop N shows the Nth
unpinned space or the one pinned to N. Read-only, never moves windows. Refocusing on the same
desktop keeps a space picked by hand. GNOME Wayland without xprop: settings says unsupported.
Test: `scripts/desktop_spaces_test.py` 18/18 (parsers for every desktop against real output
shapes, live on Hyprland only).

### ~~43. Media card ⋯ panel: the site's own volume~~ — DONE 2026-10-13
⋯ on the media card (hover row, beside PiP/close) opens a panel: volume, speed (0.75-2x),
Copy link (YouTube: at the current second), Go to tab. `zen-media-frame.js` is the content
side, idle until the panel asks. YouTube Music is driven through its player-bar slider:
the player's volume sits on a loudness curve under it (slider 40 = player 13) and setting
the player left the slider at 100 - the mismatch the user saw. YouTube: player API (its
controls follow). Anything else: the page's <audio>/<video>. While the panel is open the
site's own slider moving updates ours (volumechange, captured).
Test: `scripts/media_more_test.py` 13/13 against real YouTube Music (consent wall clicked
in the throwaway profile). The panel's look is unverified: popups do not appear in grim.

### 42. Nova-direction refresh (#73) — radii DONE 2026-10-13, rest OPEN
One scale: `--tela-radius` (10px, zen-theme.css) for tabs, the address bar and the page
(`--zen-webview-border-radius`); folder cards and their header `R + 2` (tabs sit 2px in);
compact tabs `R - 4`; small controls (horizontal close/new-tab, rail target) `--tela-radius-sm`
= 0.6R. Tabs › Corner radius now sets R, so everything moves together.
Before: tabs 14, folders 10, page 5, compact 6, horizontal controls 4/7. Screenshots compared
in comfortable and horizontal; regress 0 failed, tab_looks 18/18.
Open: horizontal chrome as segmented islands, one icon weight, warm base palette - each
needs the user's eye, not computed style.
Also added: `scripts/selector_match.py` - walks every rule of our zen stylesheets in a fresh
browser per preset and fails when a selector that matched an element stops matching (CSS that
still loads but styles nothing after an upstream move). Baseline `scripts/selector-baseline.json`:
589 of 1622 match, stable across two runs. Re-baseline with `--update` after a deliberate change.

### ~~41. Tab looks: glow off/subtle/full, selected style, folder spacing~~ — DONE 2026-10-13
Settings › Look and Feel › Tab Focus › **Tabs**, all live (prefs `zen.tabs.focus.strength`,
`zen.tabs.look.*`, mirrored onto :root by ZenTabFocus.mjs):
glow full / subtle (inside the tab, no halo spill) / off (no layers at all);
selected tab side mark / filled / outline / bold text; close button hover / always / never;
corner radius; tab height; hover shade on/off; space between folders (default 6px - the
tinted folder cards used to touch).
Found on the way: the side mark sat in the gutter that `#tabbrowser-tabs` clips, and was
coloured `--zen-primary-color` (near-black on the default theme) - it was never visible.
Now inside the tab, mixed with the text colour. Selected styles carry `#tabbrowser-tabs`
to outrank the glow's own selected fill; radius goes through `--border-radius-medium`
because Zen sets it from two-ID rules.
Test: `scripts/tab_looks_test.py` 18/18; regress 0 failed.

### ~~39. Translations, as a button you can place anywhere~~ — DONE 2026-10-13
Firefox's local (Bergamot) translations were in the engine but switched off in
the daily profile, and their urlbar icon cannot show: tela's sidebar urlbar
collapses `#page-action-buttons`. Now `zen-translations-button`
(`src/zen/tabs/ZenTranslationsButton.mjs`), a CustomizableUI widget defaulting
to the sidebar's bottom row. It mirrors the hidden urlbar icon (dimmed when the
page is already in your language, disabled on about: pages, loading arrows,
target-language tag as a badge) and opens Firefox's own panel on itself;
`fullPageTranslationsPanel-js.patch` anchors it there and opens it away from the
nearest window edges. A stored `browser.translations.enable=false` is cleared
once (`zen.translations.enable-migrated`). Proof: `scripts/translations_button_test.py`
12/12, including a real German→English translation. Popups do not show in
screenshots of the unfocused test window, so the panel's look needs a human eye.

### ~~40. Save/open dialogs looked like GNOME Files~~ — DONE 2026-10-13
Firefox draws its own GTK file chooser unless it runs in Flatpak/Snap. Now
`widget.use-xdg-desktop-portal.file-picker = 1` (prefs/zen/gtk.yaml), so the
portal's chooser is used - KDE's, per `~/.config/xdg-desktop-portal/*.conf`.
"Show in folder" already reached Dolphin (user D-Bus override of FileManager1).

### ~~38. Real glass: see-through window background, blurred by Hyprland~~ — DONE 2026-10-13
Done as `src/zen/glass/TelaGlass.sys.mjs` (started from `ZenStartup.mjs`).
Findings: the GTK toplevel already has an alpha visual on Wayland, and Zen's
`zen.widget.linux.transparency` (CSS-only, `-moz-pref`) clears the chrome -
fully, with no tint. It can be switched live, but the window keeps its old
opaque region until a repaint; the module runs Zen's theme refresh 200 ms after
the switch, which does it. The tint is `--zen-themed-toolbar-bg-transparent`
mixed to `--tela-glass-opacity` (zen-theme.css). Pages: `"pages": true` sets
`browser.tabs.allow_transparent_browser` and toggles `transparent` on open tabs
(live, Zen's empty tab left alone), so pages painting no background show the
glass. The shell's Glass.qml now lists Zen as "native" (default off; saved
state kept) and writes `~/.config/tela-zen/glass.json` =
`{enabled, opacity, pages: <Websites row>}`; backup `Glass.qml.bak-20261013`.
Proof: `scripts/glass_test.py` 9/9 (on, opacity linear and live, off exactly
opaque, page pixels untouched, page glass on/off incl. new tabs). Not done:
tela-newtab opting in on its own (it paints its own background).

Original request:
The shell's new Palette > Glass panel (`~/.config/quickshell/ii/services/Glass.qml`)
makes apps see-through over Hyprland's blur. Apps that can make only their
*background* transparent ("real glass": WezTerm, Kitty, Discord) keep text
solid. tela-zen is currently in the "whole window" group: Hyprland fades the
entire window, text and page included, which reads badly. Wanted: real glass
for the browser chrome (toolbar, sidebar, tab strip, new-tab page), with web
pages left opaque unless a page itself is transparent.

What to work out (none of this is verified yet):
1. **Transparent toplevel on Wayland.** The GTK window must be created with an
   alpha visual and nothing may paint an opaque base. Find the prefs and
   widget code involved (candidates to check, not facts:
   `browser.tabs.allow_transparent_browser`, the `widget.*` transparency prefs,
   and how upstream Zen does its macOS/Windows translucency) and whether
   WebRender keeps the alpha through to the compositor.
2. **Chrome CSS.** `#main-window`, the toolbox, the sidebar and the tab strip
   painted with the theme colours at an opacity, instead of opaque fills.
   One variable, e.g. `--tela-glass-opacity`, so everything follows one value.
3. **Content area.** Keep `browser` elements opaque by default; the new-tab
   page (`tela-newtab`) can opt in, since it is ours.
4. **Live control from the shell.** The shell writes per-app glass files and
   reloads each app live; tela-zen should do the same. Proposed:
   `~/.config/tela-zen/glass.json` = `{ "enabled": true, "opacity": 0.85 }`,
   watched by the browser, applied without a restart (set the CSS variable;
   if the window needs re-creating for alpha, say so in the file's reader).
   Glass.qml then moves Zen from the "window" list to the "native" list and
   writes that file instead of a Hyprland opacity rule.
5. **Blur.** Nothing to do in the browser: Hyprland blurs behind any
   translucent window once the shell's `glass-zen` rule sets `no_blur = false`.

Website side already done (2026-10-13): Palette > Glass has a "Websites" row
that writes `~/.local/share/stylus-themes/glass.json` ({enabled, opacity}); the
tinct live userscript 1.2.0 makes `--m3-surface*`/`--m3-background` see-through and
`html, body` transparent from it. So once the window and content area can be
transparent, pages follow with no further work.

Done when: with Glass on for Zen, the toolbar and sidebar show the blurred
wallpaper/windows behind them, page text is fully crisp, and moving the
opacity slider in the shell changes the browser live.

### ~~37. Publish download progress for the desktop dock~~ — DONE 2026-10-13
Built as `src/zen/downloads/TelaDownloadProgress.sys.mjs`, started from `ZenStartup.mjs`.
One change to the ready-made code: the quit-time remove was not awaited and the
process exited first, leaving a stale ring - it is now an `IOUtils.profileBeforeChange`
blocker. `zen.downloads.progress-file` redirects the feed (tests use it, so a test
browser never drives the real dock). Proof: `scripts/download_progress_test.py`, 10/10.

The quickshell dock shows a ring on the tela-zen icon while a download runs
(`~/.config/quickshell/ii/services/Downloads.qml`), but it can only see the
`.part` files: which files and how fast, never a percentage. Firefox's own
taskbar progress goes through `_NET_WM_XAPP_PROGRESS`, an X11 window property,
and tela-zen runs as a native Wayland window - so it is published nowhere
(`libxul.so` has no `com.canonical.Unity.LauncherEntry` code either).

Wanted: from `Downloads.getList(Downloads.ALL)` + a view's `onDownloadChanged`,
write the in-progress set as JSON to `$XDG_RUNTIME_DIR/tela-zen/downloads.json`
(`[{ "file", "currentBytes", "totalBytes", "speed" }]`, rewritten at most
~2×/s, removed when empty), or emit the Unity LauncherEntry `Update` signal
(`progress`, `progress-visible`, `count`) on the session bus, which other docks
read too. `Downloads.qml` then sets `progress` from it; it already falls back
to the `.part` view when the file is absent.

**Ready-made implementation (2026-10-13, from the quickshell session).** Not
built or run yet. The dock side is final: it sums `currentBytes` and
`totalBytes` over the list, and treats `totalBytes: 0` as unknown. Drop this in
as e.g. `src/zen/downloads/TelaDownloadProgress.sys.mjs`, register it in the
module's `moz.build` (`EXTRA_JS_MODULES.zen += [...]`), and call
`TelaDownloadProgress.init()` once from browser startup, after the first
window (where the other `Zen*` startup modules are initialised).

```js
/* Publishes in-progress downloads for the desktop dock.
 * $XDG_RUNTIME_DIR/tela-zen/downloads.json:
 *   [{ "file", "currentBytes", "totalBytes", "speed" }]
 * Rewritten at most twice a second, removed when nothing is downloading.
 * Wayland has no _NET_WM_XAPP_PROGRESS, so Firefox publishes this nowhere. */
const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Downloads: "resource://gre/modules/Downloads.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

const MIN_INTERVAL_MS = 500;

export const TelaDownloadProgress = {
  _list: null,
  _timer: null,
  _lastWrite: 0,

  get _dir() {
    const runtime = Services.env.get("XDG_RUNTIME_DIR");
    return runtime ? PathUtils.join(runtime, "tela-zen") : null;
  },
  get _path() {
    const dir = this._dir;
    return dir ? PathUtils.join(dir, "downloads.json") : null;
  },

  async init() {
    if (this._list || !this._path) return;
    this._list = await lazy.Downloads.getList(lazy.Downloads.ALL);
    // addView replays onDownloadAdded for downloads that already exist.
    await this._list.addView({
      onDownloadAdded: () => this._schedule(),
      onDownloadChanged: () => this._schedule(),
      onDownloadRemoved: () => this._schedule(),
    });
    Services.obs.addObserver(this, "quit-application-granted");
  },

  // onDownloadChanged fires many times a second per download.
  _schedule() {
    if (this._timer) return;
    const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - this._lastWrite));
    this._timer = lazy.setTimeout(() => {
      this._timer = null;
      this._write().catch(console.error);
    }, wait);
  },

  async _write() {
    this._lastWrite = Date.now();
    const path = this._path;
    // Running = started and not yet stopped. Paused and failed downloads
    // are `stopped`; finished ones are `succeeded`.
    const running = (await this._list.getAll()).filter(d => !d.stopped && !d.succeeded);
    if (!running.length) {
      await IOUtils.remove(path, { ignoreAbsent: true });
      return;
    }
    const items = running.map(d => ({
      file: PathUtils.filename(d.target.path),
      currentBytes: d.currentBytes,
      totalBytes: d.hasProgress ? d.totalBytes : 0,
      speed: Math.round(d.speed),
    }));
    await IOUtils.makeDirectory(this._dir, { ignoreExisting: true, permissions: 0o700 });
    // tmpPath = write then rename: the dock never reads half a file.
    await IOUtils.writeJSON(path, items, { tmpPath: path + ".tmp" });
  },

  observe(_subject, topic) {
    if (topic === "quit-application-granted" && this._path)
      IOUtils.remove(this._path, { ignoreAbsent: true });
  },
};
```

Check after building: start a large download, then
`cat $XDG_RUNTIME_DIR/tela-zen/downloads.json` should change about twice a
second, the dock ring on the tela-zen icon should fill, and the file should be
gone once the download finishes or is paused.

### ~~36. Two mechanisms decided widget visibility~~ — DONE 2026-09-08
The onion had a pref of its own (`zen.tor.hide-on-empty-tab`: never /
unrouted / always) doing what the layout presets' per-state `widgets` config
does for every other widget. Folded into the presets; the pref, its yaml entry
and its Settings menulist are gone.

The three-way pref needed a state `WIDGET_STATES` did not have. Resolution is
"the last active state that defines something wins", so with `["normal",
"emptyTab", "tor"]` a Tor state always outranks the empty tab: `unrouted`
(hide on the empty tab, but not when routed) is expressible and `always` (hide
on the empty tab *including* when routed) is not. Reversing the two only swaps
which one is expressible. Their intersection is therefore its own state,
`torEmptyTab`, walked last - a fourth column in the picker, and the smallest
thing that keeps both meanings.

Visibility is now read from the live `zen.ui.layout-preset.widgets` rather than
`configOf(current).widgets`, so a built-in preset (which pins no widgets, like
right-side) leaves it as the user's own choice, and the picker in Settings
moved out of the Custom-slot controls to match. The shipped default of that
pref *is* what "unrouted" meant. `_migrateV8` translates a user's old value
into the live pref and into any custom slot that already holds something -
never into an empty slot, which a user value would turn into a configured card.

Verified over Marionette in throwaway profiles, per state, measuring computed
display and a painted rect rather than the attribute alone. Fresh profile:
empty tab hidden, normal tab shown, Tor window's empty tab shown, Tor window's
normal tab shown - identical to the old default. A profile carrying
`always`: hidden on both empty tabs, shown on both normal tabs. Carrying
`never`: shown in all four. Ticking the new "Tor + empty" box in Settings hid
the onion in an already-open Tor window immediately; Customize Mode still
shows and drags it, and the hiding comes back on exit. `regress.py`: 0 failed.

### ~~16. Compact-mode sidebar isn't resizable~~ — DONE 2026-09-08
`#zen-sidebar-splitter` is `display: none` in compact (a XUL splitter resizes
a flow sibling; compact's toolbox is `position: fixed`, out of the flow).
Built `ZenSidebarResizer.mjs`: an `hbox` grab strip appended to the toolbox
itself, 8px along its trailing edge, plain mouse events. Width is stored the
same way Zen already stores it — the toolbox's `width` attribute and inline
style, both named in its `persist="width style"`, so a restart restores it via
native XUL persist (xulstore.json) with no pref of our own. Drag sets width
directly with no transition (rAF-coalesced so it tracks the pointer, one
frame per paint); programmatic changes (double-click reset, leaving/entering
compact) get a 180ms transition. Verified over Marionette in a throwaway
profile: a real mousedown/mousemove×6/mouseup drag resized 276px -> 496px;
double-click reset applied a transition and settled at the default 186px;
clamping holds at the computed max-width (500px) and the 150px floor; toggling
compact off and back on preserved the stored width (340px) including
re-pinning `min-width`; a clean quit + relaunch restored 340px from
`xulstore.json`. Screenshots confirm the floating panel renders correctly at
the resized width both live and after restart.

### ~~15. Layout presets manager (cards, previews, drag-reorder, save/rename)~~ — DONE 2026-09-08
Built on the data layer from task 7/14's follow-on
(`ZenLayoutPresetData.mjs`, already in place when this session started): a
card grid in Settings > Look and Feel > Layout (`gZenLayoutPresetsUI` in
`zen-settings.js`, container `#zenUILayoutList` in `zenLooksAndFeel.inc.xhtml`).
Nine cards - the five built-ins plus four `custom1..4` slots, ordered by
`zen.ui.layout-preset.order`. An unconfigured slot renders as a dashed
"Save current layout" target; clicking it saves and selects. Each configured
card draws a small CSS preview (`buildPreview()`) from the preset's own
config - sidebar vs. top strip, thin/narrow sidebar for compact, dashed bare
inset for minimal, hairline for shy - not a screenshot. Drag reorders
(HTML5 DnD, `moveTo()` splices `ZenLayoutPresetData.order`); Alt+Left/Right
does the same from the keyboard since dragging isn't reachable that way.
Custom slots get Rename/Update/Reset actions; rename writes
`customN.name` and both the card label and the toolbar context submenu
(`ZenLayoutPresets.mjs: _fillContextMenu`) pick it up, since both read
`ZenLayoutPresetData.nameOf()`. Applying a card just writes
`zen.ui.layout-preset` - the same pref the context menu and the
`Accel+Alt+L` cycle write - so there is one path, not three.

Verified over Marionette in a throwaway profile: clicking a card changes the
live pref and the browser window's own attributes (`compactMode: true` etc.
after clicking Compact); saving the live arrangement into `custom1` set
`saved=true` and copied the right values; renaming it "Wide Screen" changed
both the card label and the toolbar submenu's `label` for that item; dragging
`shy` before `comfortable` (via `moveTo`, the same function the real drop
handler calls) changed `zen.ui.layout-preset.order`, the card DOM order, AND
`gZenLayoutPresets.cycle` on the live browser window, all in agreement;
Reset cleared `custom1` back to an empty slot and fell through to the new
`cycle[0]`. Screenshotted at 0.6x page zoom (tiling WM wouldn't grant a
wider window via `WebDriver:SetWindowRect`) - looks right, matches the
`zen-choice`/`zen-card` tokens the "Browser Layout" section below it
already uses.

Left for phase 2 (per-state config, out of scope here): no per-card toolbar
widget layout (empty tab / Tor window get their own widget sets), and no
dragging individual widgets between chrome areas. The natural extension is a
`widgets` key alongside `compactMode`/`hideTabbar`/etc. in
`ZenLayoutPresetData`'s config shape, applied the same way `LIVE_PREFS` is
applied now, with the card preview drawing the actual widget set instead of
a generic toolbar box.

### ~~14. Tabs on top (classic Firefox layout)~~ — DONE 2026-09-05
Zen has no horizontal tabs: `zen.tabs.vertical` is vestigial (flipping it
relayouts nothing) and the `horizontal` preset did nothing. A CSS-only reuse of
`#tabbrowser-tabs` is a dead end - one `#navigator-toolbox` IS the sidebar, its
`zen-workspace` children are `position: absolute` (contributing no size, so every
ancestor collapses to 0), and the arrowscrollboxes take flex-direction from XUL
`orient`. Built `ZenHorizontalTabs.mjs` instead: its own strip in
`#zen-appcontent-wrapper`, synced to `gBrowser.tabs`, shown on
`:root[zen-layout="horizontal"]`. The sidebar is untouched and keeps working.
Still to do: drag-to-reorder, a context menu on strip tabs, workspace filtering.

### ~~6. Floating vertical tabs do not widen on urlbar focus~~ — FIXED 2026-09-05
Compact/floating pins `--zen-toolbox-max-width: 74px !important` on the toolbox
(`compact-mode/sidebar.inc.css`), and `vertical-tabs.css` turns that variable
into `min/max-width !important`. The focus override set the same variable
WITHOUT `!important`, and from a selector lighter than compact's guard chain
(`:root[zen-compact-mode='true']:not([customizing]):not([inDOMFullscreen])` plus
a nested `:not([zen-compact-animating])`), so it lost twice over. Fixed by
adding a second rule in `zen-omnibox.css` that matches that guard chain and
uses `!important`. Measured collapsed+compact: resting var 74px -> max-width
74px; focused var 320px -> max-width 320px.

### 7. Zen layouts should follow ShyFox — OPEN 2026-09-05
Current layout presets are not what is wanted; reference is the ShyFox fork on
GitHub. **Blocked**: need the repo link before reading how it lays things out.
Do not guess the repo.

### ~~8. SearchJumper engine-list panel needs restyling~~ — FIXED 2026-09-05
The "all engines" popup (`#search-jumper-alllist .sitelist > .sitelistCon`,
rows are `div > a > (div>img) + p`) is still stock: loose rows, centred bold
title, no Zen treatment. Tokens currently sit on `.search-jumper-searchBar`,
but the panel is a SIBLING of the bar - move them to `#search-jumper-root` so
the panel inherits them.

### ~~9. SearchJumper per-site preferred engine / icons / colour~~ — FIXED 2026-09-05
Extend the `SITE_POSITIONS` table in `searchjumper-tela.skin.js` into one
per-site config: `side`/`y` (done), plus `accent` (sets `--tela-accent`),
`prefer` (mark tiles `data-tela-prefer`, CSS `order:-1`; do NOT reorder nodes)
and `icons` (engine name -> glyph override, checked before the global RULES).

### ~~10. Tab context menu feels slow~~ — FIXED 2026-09-05 (`ui.submenuDelay` 300 -> 120)
`popupshowing` is 0.82ms total, our submenu 0.066ms, colour panel 0.33ms,
colour reads 0.01ms. The delay is XUL's submenu hover delay now that colours
live behind "Change color >". `ui.submenuDelay` is unset (default ~300ms).
Decide: drop the pref to ~120ms, or promote Colors back to the top level.

### 11. Which "opus script" for the AI module — OPEN 2026-09-05
The AI actions in the skin (insert selection, copy last answer, copy chat as
Markdown, jump to latest) were built on an assumption: no script named "opus"
is installed. The AI-site scripts present are OmniChat Exporter and Multi-OCH
Helper. Confirm which behaviour was meant before extending.

### ~~12. `npm run import` is broken~~ — FIXED 2026-09-05
Fails on an already-applied `PictureInPicture.sys.mjs` patch. Every new file
this session is hand-symlinked into `engine/`, and pref defaults went straight
into the compiled `zen.js` rather than `prefs/zen/*.yaml` (correct but inert).

### ~~13. Menu labels are hardcoded English~~ — FIXED 2026-09-05
The `.ftl` is not symlinked into `src/`, so "Change color", "Colors",
"Animation", the unload items and the settings section are all literals.

### ~~1. The urlbar opens itself on startup~~ — FIXED 2026-09-04
A new window comes up with the urlbar focused and the sidebar results already
showing. Cause is upstream Zen, not our code:

```js
// src/zen/common/modules/ZenStartup.mjs:97 — zen-browser/desktop#7605
if (gURLBar.hasAttribute("breakout-extend")) {
  gURLBar.focus();
}
```

An empty/new tab leaves `breakout-extend` set, so the guard passes. Now
skipped when `zen.urlbar.behavior === "sidebar"`: there is no floating popup
in that mode, so #7605 has nothing to protect, while this was focusing the
search field on every new window. Non-sidebar users keep upstream behaviour.

### ~~2. Stock urlbar popup shows alongside the sidebar results~~ — FIXED 2026-09-04
In sidebar mode both render: the floating `#urlbar[breakout-extend]` panel AND
`#zen-sidebar-results`. Not a regression — `ZenSidebarResults.sys.mjs` says so
in its own header ("the stock view … we never touch either"), and no CSS keys
off `zen.urlbar.behavior`. `_setup()` now marks the document
`zen-sidebar-urlbar="true"` (a string pref has no -moz-pref media query, and
setup is the point we can actually render), and CSS hides
`#urlbar > .urlbarView` under it. Zen's own open/close machinery is untouched
— only the duplicate view is hidden.

### 3. Vertical tabs should stay visible in a new window while typing — LIKELY RESOLVED, needs confirming
Opening a new window in the vertical-tabs layout should show the tab strip,
since the urlbar is focused for typing. NOTE before changing anything: the
sidebar's `:has()` observer already watches `[breakout-extend]`, which Firefox
sets on focus — so the expand may already be firing and something else is
overriding it. Observe the real behaviour first (hidden outright, or flashes
then collapses?); those point at different code.

2026-09-04: compact mode is OFF in the test profile
(`zen.view.compact.enable-at-startup = false`), so nothing was auto-hiding the
sidebar there — which means the symptom was most likely task 1's startup
autofocus, now fixed. Also confirmed `zen-floating-urlbar` is only set for
`float`/`floating-on-type`, so the observer's
`:not(#urlbar[zen-floating-urlbar='true'])` exclusion never applied in sidebar
mode and `[breakout-extend]` should already expand it. Open a new window and
confirm before changing anything.

### 5. Empty-tab search box reads as "the urlbar opening itself"
Traced over Marionette 2026-09-04, NOT a focus bug:

    zen-has-empty-tab: "true"    selectedTabUri: "about:blank"
    zen-single-toolbar: "true"   focused: false

zen-omnibox.css:168 applies the compact urlbar padding only
`:not([zen-single-toolbar]):not([zen-has-empty-tab])`. Both are set on a new
window, so the urlbar renders full size — Zen's intended blank-tab search
field. The focus half IS fixed (measured: focused true at 0ms, false from
150ms). Suppressing the big box is a deliberate design change; awaiting a
decision. One-liner if wanted:

```css
:root[zen-sidebar-urlbar="true"][zen-has-empty-tab="true"]
  #urlbar:not([breakout-extend]) .urlbar-input-container {
  padding: 2px 3px;
  gap: 2px;
}
```

### 4. Sidebar widen smoothness — REGRESSED then FIXED 2026-09-05
Regressed when the tab-focus glow landed. Two real causes, both measured:
`_trackSelected()` reads the tab box (forces layout) and ran on EVERY resize
event - a width animation fires those continuously; and the glow animates
`offset-distance`, which Gecko cannot composite, over four blurred layers.
Fixed by coalescing tracking to one rAF (60 resize events -> 1 track call) and
pausing the glow while geometry moves: `:root[zen-tab-focus-busy]` sets
`animation-play-state: paused`, `filter: none`, hides the halo, and kills the
layer transition, clearing 200ms after the last event.

Earlier win, still standing: `_render()` tore down and rebuilt the whole
result list on every batch. If it regresses again, capture a real Gecko
profile rather than guessing.

## Done, not committed

### Open a video in another app (reel / mpv / custom) 2026-10-28
Media card button (beside pop-out) and "Open video in …" on a video's context menu hand the stream to
`media external` (~/.scripts/media): reel gets a yt-dlp-resolved URL (it cannot send referrer or
cookies; falls back to mpv), mpv uses its yt-dlp hook with referrer + cookies.txt. Settings → Pop-out
video → "Open in another app" (`zen.media.external.*`). reel learnt http(s) streams (reel repo,
uncommitted). regress: `external-player-hands-off`. Not packaged yet; not tried on a real hoster.

### Startup hold OFF by default (-32) 2026-10-22
`zen.startup.show-when-ready` (the -29 hold) now defaults to false. On the user's Hyprland (1.6 scale)
-29..-31 opened the window drawn ~44px smaller and offset inside a correctly sized window
(hyprctl: 6,46 1588x948 - right), blank until a repaint; -28 did not. Headless loom shows no fault
either way, so it only appears on the real compositor. The code stays, opt-in; the smooth start
needs a way that leaves Gecko's native show alone (cover the chrome instead of hiding the window).

### Two layers only in the Android sidebar (-41) 2026-10-23
The user: "layered backgrounds that make no sense". The sidebar had a panel, a tab card, folder cards,
a header pill, a footer pill and bordered tiles - boxes in boxes. Rule now (written in `_mixins.scss`):
the panel (layer 1, the only border) and tiles one step above it (`m.tile`: address bar, extension
chips, essentials, folders, the focused field); the header, tab list and footer are flat on the panel.
Unused mixins (pill, card, panel) removed. Checked in the lab after a full rebuild - note a CSS
injection cannot show a *removed* rule, only a rebuild can.

### Sidebar and page share one top edge (-40) 2026-10-23
The user's session showed the sidebar panel ~50px above the page card. Cause: Zen forces
`#navigator-toolbox { margin-top: 0 }`, so the theme's top margin never applied (the sidebar was
flush with the window top, the page 8px lower), and the page's own offset varies with the layout.
ZenStartup `#alignPanels` measures the page and sets `--a-panel-top/-bottom`; `_window.scss` applies
them with !important. Checked in the lab, incl. a simulated 42/12px page gap: both panels end up on
the same edges. Compact mode is left to Zen (the panel floats there).

### Android Settings page (-39) 2026-10-22
`zen-preferences-android.scss` (+ `android/_page,_sections,_controls`), linked from zen-preferences-links.xhtml:
the shell's settings window - layer-0 page, one layer-1 sheet (10px), sections with a Material Symbols icon
and a tonal title, flat rows with hover layers, M3 switches for checkboxes, outlined pill selects, tonal
buttons. The theme tag + palette now come from one helper (`ZenMaterialPalette.syncTheme`) used by the
window and the Settings page. Seen in the lab; the search field is still Firefox's own.

### Custom colours + more of the Android theme (-38) 2026-10-22
`zen.theme.palette` = desktop | custom; custom turns `zen.theme.accent` (+ `zen.theme.scheme`
dark/light/auto) into the full role set (`ZenMaterialPalette.fromSeed`, Material 3 tones in OKLCH;
the accent is primaryContainer), set under the same `--zen-m3-*` names, so the theme follows with no
CSS change. Settings > Theme (accent picker shows only for custom), config.toml `[theme]`.
`scripts/material_palette_test.mjs` 21/21. Also: extension chips (`unified-extensions-item`, seen
with a temporary add-on in the lab), tab states (loading pulse, unloaded, attention), folders as
layer-2 cards, `zen.startup.cover` (opt-in smooth start that leaves the native window alone;
reveals by "ready" in the lab). Still unseen on the real session: popup corners, the user's own
extension row.

### Themes: `zen.theme.style` + the Android look - FIRST PASS 2026-10-22, NOT SEEN ON SCREEN
`zen.theme.style` (default | android; Settings > Look and Feel > Theme, `[theme] style` in
config.toml) tags `:root[zen-theme-style]`; ZenStartup `#applyThemeStyle` loads the desktop's
Material palette (ZenMaterialPalette, `--zen-m3-*`) into the window while a theme other than
default is on. Android = `zen-theme-android.scss` + `android/_*.scss` (tokens, window, tabs, urlbar, buttons,
popups, dialogs), translated from the desktop shell's QML: layer stack, rounding scale, 8%/15%
state overlays, 32px menu rows, PillTextField address bar, tonal selected tab + 103 Material Symbols icons, generated by
`scripts/material_icons.py` (system font -> `zen-icons/material/`, `icons-android.css` derived
from icons.css). Default theme is untouched (every rule hangs off the tag).
Seen since in headless loom (single-process browser, `scripts/theme_lab.py`, `theme_popup_shot.py`):
floating sidebar panel + tab card + pill dock, compact mode hidden/revealed (the user's real
layout), urlbar results list, Settings. Motion tokens (`$motion`) and spacing (`$space`) come from
Appearance.qml. Menu corners look square there (headless popups have no alpha) - unconfirmed on
the real session.
Needs a look: tab pills in both sidebar styles, essentials, urlbar focus ring, menus/panels,
folders, the settings page, and which sidebar icons still show the old glyph.
Next: more of the chrome (folders, split view, glance, compact mode), a real theme picker
with previews, a second contrasting theme.


- **Window opens once, complete (-29).** Gecko showed the window at chrome
  load, before session restore: a placeholder sidebar, then the real one ~0.5s
  later. `ZenStartup.#showWhenReady` holds it (`nsIBaseWindow.visibility =
  false` at MozBeforeInitialXULLayout, again at DOMContentLoaded/load since the
  window watcher re-sets it), starts delayed startup itself (it waits for a
  paint a hidden window never has), defers `window.focus()` (session restore
  raises the window, which shows it), shows after restore; 3s safety timeout.
  `zen.startup.show-when-ready`. `scripts/startup_show_test.py` (widget log:
  one native Show, at ours). Filmed with loom `--headless --record`.

- **Invisible card, the cause (-28).** `hideMediaControls` fades the bar to
  opacity 0 over 0.1s; a card returning mid-fade made the `.then` return early
  without restoring opacity, and `showMediaControls` skipped an unhidden bar.
  Bar stayed transparent until restart. Found in the user's events log: bar
  opacity 0 in 195/470 open-sidebar samples. Show now takes over the fade;
  the 5s mirror heals and logs a stuck bar; `seen` includes bar opacity.
  `scripts/card_bar_fade_test.py` (old build 21/72, fixed 72/72).
- **regress picks the live Hyprland**: nested compositors leave newer dead
  sockets; it took the newest and reported no spare monitor.

- **Blank new tab on startup (-27).** Session restore loaded the saved
  `chrome://…/zen-newtab.html` in the content process, which refuses it.
  `ZenSpaceManager.#ensureNewTabPage` reloads the empty tab with the system
  principal on SSTabRestored and TabSelect. `scripts/newtab_startup_test.py`.
- **Continue where you left off, unless away long (-27).** On by default;
  `zen.newtab.after-away-hours` (4) starts on the new tab after a longer gap,
  measured from zen-sessions `lastCollected`. Zen's `_tabToSelect = selectTab
  - 2` landed on the empty tab, so the last tab is matched by its saved
  `lastAccessed` instead. Urlbar no longer opens over the new tab page.
- **New tab views (-27):** Start / History (filter, by day) / Settings, `[ ]`
  or 1-3. Start layouts full|minimal|sites|recent (`zen.newtab.layout`),
  show-* switches, live via pref observer; `[newtab]` in the dotfile.
- **Card report (-27):** Ctrl+Alt+Shift+C writes zen-cards-report-<t>.json
  (styles, ancestors, animations, elementsFromPoint, trace, last 20 mirror
  states) and .png (drawWindow of the sidebar), then forces a repaint and
  asks whether the card came back. `scripts/card_report_test.py`.

- **Sidebar widens on urlbar focus.** Was a flat `width: 320px !important`, so
  a sidebar already ≥320 never changed. Now `max(resting + 80, 320)`, measured
  once per focus in `_applyFocusWidth()` — deriving it in CSS from
  `--actual-zen-sidebar-width` would feed the ResizeObserver that writes that
  variable and grow unbounded. `_clearFocusWidth()` pins the resting width back
  on blur, or every focus/blur cycle widens it permanently.
- **Result rendering batched** into one rebuild per frame via
  `requestAnimationFrame` (was one full teardown per result batch, several per
  query).
- **Tab rows contained** (`contain: layout style`, `content-visibility: auto`)
  while focused, so the width animation stops scaling with tab count.
- **Custom layout slots join the keybind cycle** (`Accel+Alt+L`). They were
  excluded outright, which also meant pressing it *while on one* dropped you
  back to comfortable. A slot joins only once `prefHasUserValue` says it holds
  something. Toast strings added for `custom1–4`.
- **Startup urlbar focus suppressed per window.** `ZenStartup` only runs for
  the first window, so the blur moved into `ZenSidebarResults._setup()` where
  it runs per window. Measured before: focused for the full 2s; after: false
  from 150ms. The listener releases on the first mousedown/keydown so it can
  never fight a deliberate click.
- **`horizontal` layout preset** — tabs across the top like a stock browser,
  via `zen.tabs.vertical: false`. In the cycle. `zen.tabs.vertical` also added
  to `LIVE_PREFS` so custom slots remember orientation.

## Notes

- ~~`_muteSidebarResize()` is redundant~~ — removed 2026-09-04.
- `src/zen/common/styles/zen-omnibox.css` has ~165 uncommitted insertions from
  a parallel session (sidebar results styling, `ZenColorPicker` work). Don't
  commit that file wholesale without checking what belongs to whom.
- Rebuild: `cd engine && ./mach build faster` (~2s). Restart the test browser
  with a real TERM→poll→KILL sequence and clear
  `~/.tela-zen-profile/startupCache` first, or you test stale chrome.
