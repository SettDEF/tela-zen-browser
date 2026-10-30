# SASS for chrome CSS

`src/**/*.scss` compiles to the sibling `.css` that `jar.inc.mn` and the
`engine/zen/**` symlinks already point at. `npm run styles` does it;
`build`, `build:ui`, `package` and `ci` each run it first through an npm
`pre` hook, so the step cannot be skipped by editing one build line.
The generated `.css` is build output: `scripts/build_styles.py` keeps
`.gitignore`'s list of it in step with the sources on every run.

Verify a conversion with `scripts/css_equiv.py`, which parses the old and new
text with Gecko's own CSS parser in a throwaway browser and compares the
resulting declarations in order. A textual diff proves nothing here - SASS
reformats freely - and a rule silently swallowed by a broken comment is
invisible to every static check. That has happened in this tree before.

## What does not survive a SASS parse

Measured against dart-sass 1.104, one construct at a time.

**`@media -moz-pref(...)` without parentheses** is a parse error
(`expected "{"`). So is `@media A or B` with either side unparenthesised, and
`(not -moz-pref(...))`, which wants `expected media condition in parentheses`.
There is no escape hatch: `@media #{"..."}` re-parses the interpolated text and
fails the same way.

The fix is to parenthesise, and it is safe. Every form below was checked
against `matchMedia` in a real window while toggling the pref, and the
rewritten query matched exactly when the original did:

| written as | must become |
| --- | --- |
| `@media -moz-pref("x")` | `@media (-moz-pref("x"))` |
| `@media not -moz-pref("x")` | `@media not (-moz-pref("x"))` |
| `@media -moz-pref("a") or -moz-pref("b")` | `@media (-moz-pref("a")) or (-moz-pref("b"))` |
| `@media (not -moz-pref("x")) and (y)` | `@media (not (-moz-pref("x"))) and (y)` |

**`%include`** is a line-level Mozilla-preprocessor directive and SASS cannot
emit one. `meta.load-css` and mixins both come close but neither is exact -
see the nesting section below for why the difference matters.

**`filter: invert()`** is valid CSS and a SASS error: SASS owns `invert` and
demands a `$color`. `min()` and `max()` are also intercepted - SASS folds
`max(0px, 10px)` to `10px` and strips a nested `calc()` - though every current
use has a `var()` or mixed units in it and passes through untouched.

Everything else tested came through intact: `color-mix`, relative colour
syntax, `light-dark`, `:has`/`:is`, XUL element and attribute selectors,
`@namespace`, `@supports -moz-bool-pref`, custom properties, `!important`,
`::part`, and `mask: url("data:...")` with percent-escapes. Attribute
selectors lose redundant quotes (`[x="horizontal"]` -> `[x=horizontal]`) and
values are rewhitespaced; Gecko parses both to the same declaration.

## Why most sheets are still plain CSS

Zen's CSS uses **CSS-native nesting**, and SASS flattens it. In CSS, `&`
resolves to `:is(<parent list>)`, which hands every branch the specificity of
the most specific one; SASS instead emits one selector per branch, each
keeping its own. The two agree only when the parent list's branches are
equally specific.

They are not, in 38 places across 12 sheets - `zen-tabs/vertical-tabs.css`
alone has 12. Converting those files would change which rule wins, silently,
with nothing in the build or in `css_equiv.py` able to tell an intended
flattening from an accidental one.

So the rule for now: **a sheet may become `.scss` when it contains no `&`
nesting and no `%include`.** Ten did; the rest stay as they are until each
one's nesting has been read by a human. `css_equiv.py` fails loudly on a
flattened sheet rather than waving it through, so a premature conversion
cannot pass unnoticed.

## The Android theme's layout

`src/zen/common/styles/zen-theme-android.scss` is only a list of parts; the parts live
in `android/` and the Settings page reuses them:

```
android/_tokens.scss      palette, rounding, spacing, motion - the shell's Appearance.qml as CSS
android/_mixins.scss      scoped, surface, tile, fab, motion, press-bounce, state-layer (two layers: panel, tile)
android/layout/           window frame, sidebar regions, compact mode
android/components/        tabs, essentials, urlbar, buttons, extensions, popups, dialogs
src/browser/themes/shared/preferences/
  zen-preferences-android.scss + android/   about:preferences: page, sections, controls
```

Every rule is written inside `m.scoped { ... }`, which prefixes `:root[zen-theme-style="android"]`,
so the default theme cannot be touched. Tokens are CSS custom properties (`--a-*`) read from
`--zen-m3-*`, so a new palette (the desktop's file or a custom accent) needs no CSS change.
Colours, sizes and durations are named tokens; do not write a literal in a component.
Use selectors that match the real DOM (Zen names the urlbar background `.urlbar-background`,
a class), and check them in the lab: `scripts/theme_lab.py` and `theme_popup_shot.py` run the
browser inside headless loom and screenshot it.

