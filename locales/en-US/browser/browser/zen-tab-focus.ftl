# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

## Tab context menu: the selected-tab focus effect.

zen-tab-appearance-menu =
    .label = Appearance
zen-tab-focus-menu =
    .label = Glow
zen-tab-focus-colors =
    .label = Colors
zen-tab-focus-animation =
    .label = Animation
zen-tab-focus-more =
    .label = Speed, blur, size…
zen-tab-focus-hover =
    .label = Preview on hover
zen-tab-focus-reverse =
    .label = Reverse direction

## Animation presets, as context-menu items.

zen-tab-focus-preset-siren =
    .label = Siren
zen-tab-focus-preset-beacon =
    .label = Beacon
zen-tab-focus-preset-scanner =
    .label = Scanner
zen-tab-focus-preset-pulse =
    .label = Pulse
zen-tab-focus-preset-aurora =
    .label = Aurora
zen-tab-focus-preset-trail =
    .label = Trail
zen-tab-focus-preset-flat =
    .label = Flat (off)

## Colour panel.

zen-tab-focus-primary = Primary
zen-tab-focus-secondary = Secondary
zen-tab-focus-reset = Reset
    .title = Drop this tab's own colour
# $host (String) - the site this colour would also apply to, e.g. github.com
zen-tab-focus-remember-site = Also use for { $host }
zen-tab-focus-remember-none = Also use for this site

## Sliders in the variables panel.

zen-tab-focus-speed = Speed
zen-tab-focus-blur = Blur
zen-tab-focus-size = Size
zen-tab-focus-intensity = Intensity

## The same preset and toggle names again, as plain values: the panel is HTML,
## where a .label attribute renders nothing, and a menuitem cannot take the
## value form - it wipes its own text content when it first renders.

zen-tab-focus-preset-name-siren = Siren
zen-tab-focus-preset-name-beacon = Beacon
zen-tab-focus-preset-name-scanner = Scanner
zen-tab-focus-preset-name-pulse = Pulse
zen-tab-focus-preset-name-aurora = Aurora
zen-tab-focus-preset-name-trail = Trail
zen-tab-focus-preset-name-flat = Flat (off)
zen-tab-focus-toggle-hover = Preview on hover
zen-tab-focus-toggle-reverse = Reverse direction

## Tab unloading.

zen-tab-unload-menu =
    .label = Unload
zen-tab-unload-tab =
    .label = Unload Tab
zen-tab-unload-others =
    .label = Unload Other Tabs
zen-tab-unload-auto =
    .label = Unload idle tabs automatically

## Search engine picker in the urlbar.

zen-search-engine-button =
    .tooltiptext = Change search engine
zen-search-engine-heading = Search with
# $engine (String) - the current default search engine, e.g. Google
zen-search-engine-current =
    .tooltiptext = Search with { $engine }

# Right-click a tab > Appearance > Colour: that tab's own colour.
zen-tab-color-menu =
    .label = Colour
