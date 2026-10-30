# Juxtopposed - reference for tela's UI

Channel: https://www.youtube.com/@juxtopposed (UI/UX designer; redesigns real apps and reviews UIs).
Collected 2026-10-14 for the request "improve the full tela UI using her as a reference".

## Status: what this file really contains

- **Verified:** the video list below (titles from YouTube's oEmbed, IDs from her channel page).
- **From summaries only (not her words):** the browser-video criteria in the next section.
- **Not yet captured:** what she actually says in the videos. YouTube refused transcript
  downloads from the build machine (HTTP 429); the plan is to read them through the user's own
  browser via agent control (Settings > Privacy > Agent control) and fill in the "Her points"
  sections. Nothing below is to be treated as her guidance until that is done.

## Applied so far (2026-10-14) - "design consistency"

Measured every sidebar surface, then unified what disagreed (see TASKS.md #54):

- One small radius (`--tela-radius-sm`) for every row inside a surface: card rows were 4px,
  update-card rows 6px, address-bar result rows 5px.
- Cards use the sidebar's own text size: the update card was fixed at 12px next to 14.7px cards.
- One card padding (4px 6px) for media, page and update cards.
- Cards share the address bar's raised grey (opaque, since stacked cards overlap); they were
  near-black, reading as holes in a dark sidebar. Checked in dark and light themes.
- Earlier, same thread: one corner scale `--tela-radius` for tabs, address bar and page (#73).
- Everywhere, not just the sidebar (second pass): one shape rule -
  surfaces (cards, menus, panels incl. the card ⋯ panel, toasts, Settings groups) = `--tela-radius`
  (10px); rows inside them (menu items, list rows, tooltips, Settings tiles' inner corners) =
  `--tela-radius-sm` (6px); text buttons and chips = pills, everywhere.
  One surface colour `--tela-surface` for cards, menus, panels and tooltips (was rgb(31,31,31)
  for menus and near-black for cards). Measured before/after per surface.
- Not done yet: Settings' own colours (its tiles barely differ from its page; purple accent vs
  the browser's accent) - a colour pass, separate from shape.

## "I Tested EVERY Modern Browser UI to find the BEST" - what summaries say

Video: https://www.youtube.com/watch?v=YrxhVA5NVQ4 (32:27)

- Judged on: onboarding, customization, navigation ease, design consistency, tab management,
  extension support. Tiered from minimal to amazing. ([daily.dev](https://daily.dev/posts/i-tested-every-modern-browser-ui--pcmje4gaa))
- Arc, Zen and Orion singled out for design and customization; Edge noted for its customizable
  sidebar and Mac onboarding. ([Rewiz summary](https://rewiz.app/channels/@juxtopposed/i-tested-every-modern-browser-ui-to-find-the-best))
- Minimal / keyboard-centric browsers mentioned: Min, a Vim-style one, Nyx.

Her points (transcript read 2026-10-14 via agent control, youtubetotranscript.com):

- Criteria, her words: "how intrusive it is, how much you can customize it, how easy it is to
  navigate, if it's clean and clutter-free, if it follows every UI principle".
- Firefox: different icons have "completely different container sizes and paddings"; sidebar font
  "so huge in the settings but way smaller in the Firefox view"; duplicate buttons.
- Floorp: duplicates ("two back buttons ... two reload buttons") make it confusing.
- DuckDuckGo: colour-coded icons helped her navigate faster; nag reminders with no
  "don't ask again" are bad.
- Brave: over-saturated brand colour "shoved somewhere in the UI" hurts; goofy transitions.
- Vivaldi (top tier): settings well categorised, smooth animations; only complaint: "not enough
  contrast, especially with the background colour" when elements crowd.
- Opera: one long settings page with random headings is confusing; needs search to be usable.
- Safari: customisation is "mostly for the new page look".
- Zen (amazing): customisation and lightness; nitpick - compact mode has a shortcut but no
  visible icon anywhere.
- Comet: "the homepage with the widgets is pretty useful ... quick access, especially prompts
  that you use often"; wants shortcuts placed next to the search box "for even faster searching".
- Min: everything reachable by typing in the address bar; "the theme changes with every tab".
- Horse: "trails" keep track of where you came from; less-relevant items fade.

## "What if Apple made a Search Engine" - her points

Video: https://www.youtube.com/watch?v=J1cQtjS7AAE (transcript read 2026-10-14)

- "When you have a question all you want is a search bar to put the damn question and get going."
- Then filters for content types (images, news) right away; at least one quick answer on top.
- Suggestions under the box "that take you straight to the category you're looking for".
- Ambiguous queries: show both meanings rather than making you re-type.
- Spotlight layout: results list on the left, the selected result's preview on the right.
- In the browser: search straight from the address bar, suggestions "in the new style below".
- Plugins (a "+" next to search) that add sources; personal sources processed locally.

## Videos most relevant to tela

| Video | Why it matters for tela |
|---|---|
| [I Redesigned VLC After 25 Years](https://www.youtube.com/watch?v=ERFeOgqk324) | a media player redesign: media cards, the ⋯ panel, playback controls |
| [I Tried Designing an "Easy" Linux Theme](https://www.youtube.com/watch?v=57j7W7coQMg) | a Linux theme: tela runs on Linux, look and feel |
| [I Tested Your Favorite “Alternative” Design Tools](https://www.youtube.com/watch?v=j9j_d7AGSDc) | alternative design tools: her own working environment |
| [I Redesigned the ENTIRE Apple Music UI](https://www.youtube.com/watch?v=yT_aFozeDc8) | Apple Music redesign: music cards, the now-playing surface |
| [I Tried Designing My FIRST Linux UI](https://www.youtube.com/watch?v=prG9xFkvlNg) | her first Linux UI: system-level patterns on Linux |
| [I Tested EVERY Modern Browser UI to find the BEST](https://www.youtube.com/watch?v=YrxhVA5NVQ4) | the browser-UI comparison: the closest reference for tela as a whole |
| [I Redesigned the ENTIRE YouTube UI from Scratch](https://www.youtube.com/watch?v=OUM6XmhViN4) | YouTube redesign: navigation, lists, video cards |
| [I Redesigned Discord UI just to make it Cozier](https://www.youtube.com/watch?v=gmmPmnKFsTQ) | Discord made cozier: sidebar density, warmth (#73 warm palette) |
| [Everything About Color in 25 Minutes](https://www.youtube.com/watch?v=srRI7yMjGz0) | colour: tela's palette and accent rules (#73) |
| [I Redesigned the ENTIRE Spotify UI from Scratch](https://www.youtube.com/watch?v=suhEIUapSJQ) | Spotify redesign: music cards, the now-playing surface |
| [I tried Blurring things in Quirky ways](https://www.youtube.com/watch?v=--4n9c4-h1Y) | blur: glass (#38) and the overlay surfaces |
| [100 Years of Fictional UI - Were They ALL Wrong?](https://www.youtube.com/watch?v=hs-yH-WnjBQ) | fictional UI: what a futuristic UI gets right or wrong |

## How each tela area maps to her criteria (our questions, to answer from her videos)

| Her criterion (browser video) | tela area | Question to check against her videos |
|---|---|---|
| Onboarding | first run, Settings | Is there a first-run that explains the sidebar, spaces, cards? |
| Customization | Tabs, glow, config file | Too many knobs in one place? Sensible defaults? |
| Navigation ease | address bar overlay, spaces, Ctrl+1-9 | Can every main action be found without a menu? |
| Design consistency | radii (#73), cards, panels | One radius, one card style, one icon weight? |
| Tab management | folders, colours, essentials | Is grouping obvious; are folders and spaces distinguishable? |
| Extensions | toolbar, unified extensions | Where do extension buttons live in the sidebar layout? |

## All videos (newest first, as listed on her channel)

- [I Redesigned VLC After 25 Years](https://www.youtube.com/watch?v=ERFeOgqk324)
- [I Tried CLI... as a GUI Person](https://www.youtube.com/watch?v=pQFoPOTL5cU)
- [I Tried Designing an "Easy" Linux Theme](https://www.youtube.com/watch?v=57j7W7coQMg)
- [I Tested Food Delivery UI from Around the World](https://www.youtube.com/watch?v=USwP7w9BKC0)
- [I Tested Your Favorite “Alternative” Design Tools](https://www.youtube.com/watch?v=j9j_d7AGSDc)
- [I Redesigned the ENTIRE Apple Music UI](https://www.youtube.com/watch?v=yT_aFozeDc8)
- [I Redesigned Apps to Look Like Their NAMES](https://www.youtube.com/watch?v=d26zVaVJZgM)
- [I Tried Designing My FIRST Linux UI](https://www.youtube.com/watch?v=prG9xFkvlNg)
- [I Tested EVERY Modern Browser UI to find the BEST](https://www.youtube.com/watch?v=YrxhVA5NVQ4)
- [I Tried Apple as a Windows Person for a Year](https://www.youtube.com/watch?v=qO-Ctcvrd4s)
- [I CRAFTED My Own UI for the MINES](https://www.youtube.com/watch?v=_Dm9_lUV3uA)
- [Severance Terrifies Me… in a Good Way](https://www.youtube.com/watch?v=FwhLf2gB3Cg)
- [I Designed Your Goofiest UI Ideas](https://www.youtube.com/watch?v=0N87f5wfxr0)
- [I Redesigned the New Twitter](https://www.youtube.com/watch?v=Z_7dBFoscwA)
- [I Redesigned the ENTIRE YouTube UI from Scratch](https://www.youtube.com/watch?v=OUM6XmhViN4)
- [What if Apple made a Search Engine](https://www.youtube.com/watch?v=J1cQtjS7AAE)
- [I Redesigned Discord UI just to make it Cozier](https://www.youtube.com/watch?v=gmmPmnKFsTQ)
- [MKBHD's Wallpaper App Could be Way Better](https://www.youtube.com/watch?v=BOmbLyJ9PYc)
- [The Identity Crisis of Nothing’s UI](https://www.youtube.com/watch?v=xKLKl3H9rro)
- [Everything About Color in 25 Minutes](https://www.youtube.com/watch?v=srRI7yMjGz0)
- [How Websites Learned to Fit Everywhere](https://www.youtube.com/watch?v=ckEdTprbQas)
- [world's shortest Framer course](https://www.youtube.com/watch?v=MRxskO0sCOU)
- [I Redesigned the ENTIRE Spotify UI from Scratch](https://www.youtube.com/watch?v=suhEIUapSJQ)
- [I Redesigned Wikipedia JUST to MAKE IT MONEY](https://www.youtube.com/watch?v=Bzj7u4Q5GG0)
- [I Redesigned the ENTIRE IMDb UI from Scratch](https://www.youtube.com/watch?v=XK0HQcGQGLg)
- [I tried Blurring things in Quirky ways](https://www.youtube.com/watch?v=--4n9c4-h1Y)
- [When Animators Become Web Designers](https://www.youtube.com/watch?v=_8Zs_cVJAx4)
- [Stop “Learning” Design.](https://www.youtube.com/watch?v=DUM4ZiPM8cU)
- [100 Years of Fictional UI - Were They ALL Wrong?](https://www.youtube.com/watch?v=hs-yH-WnjBQ)
- [I Redesigned the ENTIRE Instagram UI… But is that enough?](https://www.youtube.com/watch?v=GtffucAmM78)
