# Chrome architecture

Who owns what in the browser chrome, and — more usefully — **where our code and
Zen's fight over the same DOM**. Most of the expensive bugs in this project have
been two writers disagreeing, not one writer being wrong.

## Ownership

| Area | Module | Notes |
|---|---|---|
| Layout presets, data | `src/zen/compact-mode/ZenLayoutPresetData.mjs` | `PRESETS`, `order`, `cycle`, `configOf`, `saveToSlot`, per-state `widgets`. The single source of truth. |
| Layout presets, applying | `src/zen/compact-mode/ZenLayoutPresets.mjs` | Applies a config to a window, builds the Layout context submenu, toggles `zen-preset-hidden`. |
| Layout presets, UI | `gZenLayoutPresetsUI` in `zen-settings.js` | Cards, previews, drag reorder, slot editor. |
| Horizontal (tabs-on-top) | `src/zen/tabs/ZenHorizontalTabs.mjs` | Builds `#zen-horizontal-chrome`, **moves `#nav-bar` into it**. |
| Right rail | `src/zen/tabs/ZenRightRail.mjs` | A real `CustomizableUI` area, `zen-right-rail`. |
| Urlbar centring | `src/zen/urlbar/ZenUrlbarCenter.sys.mjs` | The FLIP that lifts the field to the window centre. Horizontal only. |
| Sidebar urlbar + results | `src/zen/urlbar/ZenSidebarResults.sys.mjs` | Resting width, inset, results list, the focus widen (disabled in compact). |
| Sidebar resizing | `src/zen/sidebar/ZenSidebarResizer.mjs` | The compact drag handle. Width persists via XUL `persist="width style"`. |
| Card stack | `src/zen/cards/ZenCardStack.mjs` | The **only** writer of stack state. Producers register a source and call `layout()`. |
| Page/Activity cards | `src/zen/cards/ZenPageCards.mjs`, `zen-activity-frame.js` | Registers a source with the stack. |
| Media cards | Zen's `ZenMediaController` | Registers a source with the same stack. |
| Site icons | `src/zen/icons/ZenSiteIcons.mjs` | Built-in marks plus per-site overrides. Paints into script-created `<img>`. |
| Tor routing | `src/zen/tor/ZenTorProxy.sys.mjs` | `nsIProtocolProxyFilter`, keyed on `userContextId`. |
| Tor daemon + control | `ZenTorDaemon.sys.mjs`, `ZenTorControl.sys.mjs` | Our own `/usr/bin/tor` under the profile; SAFECOOKIE auth. |
| Tor UI | `ZenTor.mjs`, `ZenTorPanel.mjs` | Widget, panel, circuit diagram. |
| Privacy lifetimes | `src/zen/privacy/ZenSiteDataLifetime.sys.mjs` | Per-site `keep`/`session`/`tab`, expressed as Gecko permissions. |

## Root attributes, and who writes them

Chrome branches heavily on attributes on `document.documentElement`. Knowing
the writer is usually the fastest way to a diagnosis.

| Attribute | Written by | Read by |
|---|---|---|
| `zen-layout` | `ZenLayoutPresets` | horizontal tabs, right rail, urlbar centring, most layout CSS |
| `zen-compact-mode` | Zen's compact mode manager | sidebar CSS, sidebar results (`_fixedWidth`), resizer |
| `zen-single-toolbar` | Zen's `gZenVerticalTabsManager` | omnibox and vertical-tab CSS |
| `zen-sidebar-expanded` | Zen | sidebar CSS, resizer visibility |
| `zen-has-empty-tab` | `ZenSpaceManager` | omnibox CSS, per-state widget hiding |
| `zen-tor`, `zen-tor-status` | `ZenTor` | Tor markings, widget state, per-state widget hiding |
| `zen-sidebar-animating` | `ZenSidebarResults`, `ZenSidebarResizer`, `ZenSiteWidths` | suppresses resize feedback and resting measurement |
| `zen-preset-hidden` (per widget) | `ZenLayoutPresets` | `zen-compact-mode.css`, scoped `:root:not([customizing])` |
| `customizing` | Firefox | must disable our hiding, or widgets cannot be dragged |

## Where we contend with Zen

These are real, and each one cost a debugging session.

**`#nav-bar` ownership.** `ZenHorizontalTabs` moves `#nav-bar` into
`#zen-horizontal-chrome`. Zen's own `gZenVerticalTabsManager._updateEvent`
re-parents it into the toolbox whenever the layout prefs change — which is
exactly what switching preset does. Racing it does not work; the horizontal
module watches for the node leaving and re-asserts, with a burst cap so two
writers cannot loop. Symptom when it fails: the urlbar stays sidebar-width and
floats, and no extensions appear in the top bar.

**The extensions button is not a CustomizableUI widget.** Zen places
`unified-extensions-button` as a plain node, so `addWidgetToArea` silently
no-ops on it (`currentArea` and `removable` are both undefined). The right rail
has to move the node by hand and defend it with an observer. Any *new* widget
should be registered properly — the Tor button is, and needs none of this.

**Stack state has one owner now.** The media controller and the page cards each
used to compute slotting independently and raced. `ZenCardStack` is the only
writer; producers register a source. If you add a third kind of card, register
it — do not slot it yourself.

**Two modules write `#urlbar`'s inline width, and it has no stable resting
value in horizontal.** `ZenUrlbarCenter` pins it during the centring FLIP;
`ZenSidebarResults` pins it for the focus widen and restores a saved copy in
`_clearWidth()`. Measured, the field's resting width was 181 on one open/close
cycle and 265.7 on the next, and a second consecutive cycle flashes at the
container width (320) for a frame before settling. The end state is always
correct, so this is a visual artifact rather than a wrong layout — but the fix
is to give that inline width **one owner**, not to add another guard. Four
narrower fixes were tried and none held.

**`zen-sidebar-animating` is set for ~7s at window startup.** `_suspend()` sets
it and an 8s watchdog clears it (measured: true at t=0..6, false from t=7), so
it is self-healing rather than stuck — but while set, the sidebar's resting
measurement returns early, so anything that must be correct in a window's first
seconds cannot sit behind that guard. The compact field fit runs on its own
interval for this reason.

## Traps that are not obvious

- **A new file needs its `jar.inc.mn` entry *and* the manifest touched.**
  `npm run build:ui` does not notice a newly added entry; the file silently will
  not exist at runtime. Check `dist/`, never the exit code. (`.sys.mjs` modules
  under `EXTRA_JS_MODULES` are different — they need no jar entry.)
- **`engine/zen/**` is 212 symlinks into `src/zen/**`**, so editing a *tracked*
  file is immediately visible to the build. A **new** file is not linked
  automatically: create the symlink yourself (a copy silently diverges — one
  was found tonight) and add its `jar.inc.mn` entry, then rebuild.
- **Pref defaults**: `value: '"{}"'` in the yaml ships the quotes *inside* the
  string. The generator now quotes anything that is not `true`, `false` or an
  integer; write string defaults plainly and run `npm run ffprefs`.
- **XUL `flex="1"` maps as a UA-origin `!important`** declaration — no author
  stylesheet can outrank it. Remove the attribute instead.
- **XUL `<image>` fires no error event**, so a broken `src` leaves a hole
  rather than a fallback. HTML `<img>` does.
- **A CSS `mask` is sampled**, so an animated GIF or SVG used as one is frozen.
  Anything that may need to animate must be a real element with a `src`.
- **`popover=manual` on `#urlbar`** puts it in the top layer, so a percentage
  width resolves against the viewport, not its slot.

## Verifying changes

`python3 scripts/regress.py` runs the checks that cover the above: sidebar
urlbar geometry, layout switching, the rail actually painting, the urlbar
return, presets order and cycle, the card stack, chrome errors, and Tor routing
with its leak check. `--only <substring>` narrows it; `--keep` leaves the
browser up to poke at.
