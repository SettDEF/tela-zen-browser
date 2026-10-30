# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

zen-panel-ui-current-profile-text = current profile

unified-extensions-description = Extensions are used to bring more extra functionality into { -brand-short-name }.
tab-context-zen-reset-pinned-tab =
    .label =
        { $isEssential ->
            [true] Reset Essential Tab
           *[false] Reset Pinned Tab
        }
    .accesskey = R
tab-context-zen-add-essential =
    .label = Add to Essentials
    .accesskey = E
tab-context-zen-add-essential-badge = { $num } / { $max }
tab-context-zen-remove-essential =
    .label = Remove from Essentials
    .accesskey = R
tab-context-zen-edit-pinned-page =
    .label =
        { $isEssential ->
            [true] Edit Essential URL
           *[false] Edit Pinned URL
        }
    .accesskey = P
tab-context-zen-replace-pinned-url-with-current =
    .label = Replace with Current URL
    .accesskey = C
tab-context-zen-edit-pinned-url =
    .label = Edit…
    .accesskey = E
tab-context-zen-edit-title =
    .label = Change Label…
tab-context-zen-edit-icon =
    .label = Change Icon…

zen-themes-corrupted = Your { -brand-short-name } mods file is corrupted. They have been reset to the default theme.
zen-shortcuts-corrupted = Your { -brand-short-name } shortcuts file is corrupted. They have been reset to the default shortcuts.

# note: Do not translate the "<br/>" tags in the following string
zen-new-urlbar-notification = The new URL bar has been enabled, removing the need for new tab pages.<br/><br/>
    Try opening a new tab to see the new URL bar in action!

zen-disable = Disable

pictureinpicture-minimize-btn =
  .aria-label = Minimize
  .tooltip = Minimize

zen-panel-ui-gradient-generator-custom-color = Custom Color

zen-copy-current-url-confirmation = Copied current URL!
zen-copy-current-url-as-markdown-confirmation = Copied current URL as Markdown!

zen-general-cancel-label =
    .label = Cancel
zen-general-confirm =
    .label = Confirm

zen-pinned-tab-replaced = Pinned tab URL has been replaced with the current URL!
zen-pinned-tab-url-edited = Pinned tab URL has been updated!
zen-pinned-tab-url-invalid = That doesn't look like a valid URL.
zen-pinned-tab-edit-url-title = Edit Pinned URL
zen-pinned-tab-edit-url-label = Enter the URL this pinned tab should point to:
zen-tabs-renamed = Tab has been successfully renamed!
zen-background-tab-opened-toast = New background tab opened!
zen-workspace-renamed-toast = Workspace has been successfully renamed!
zen-split-view-limit-toast = Can't add more panels to the split view!

zen-toggle-compact-mode-button =
    .label = Compact Mode
    .tooltiptext = Toggle Compact Mode

# note: Do not translate the "<br/>" tags in the following string

zen-learn-more-text = Learn More

zen-close-label = Close

zen-singletoolbar-urlbar-placeholder-with-name =
  .placeholder = Search...

zen-icons-picker-emoji =
  .label = Emojis
zen-icons-picker-svg =
  .label = Icons
zen-emojis-picker-search =
  .placeholder = Search emojis

urlbar-search-mode-zen_actions = Actions
zen-site-data-settings = Settings

zen-generic-manage = Manage
zen-generic-more = More
zen-generic-next = Next

zen-essentials-promo-label = Add to Essentials
zen-essentials-promo-sublabel = Keep your favorite tabs just a click away

# These labels will be used for the site data panel settings
zen-site-data-setting-allow = Allowed
zen-site-data-setting-block = Blocked
zen-site-data-protections-enabled = Enabled
zen-site-data-protections-disabled = Disabled
zen-site-data-setting-cross-site = Cross-Site cookie
zen-site-data-security-info-extension =
    .label = Extension
zen-site-data-security-info-secure =
    .label = Secure
zen-site-data-security-info-not-secure =
    .label = Not Secure

zen-site-data-manage-addons =
    .label = Manage Extensions
zen-site-data-get-addons =
    .label = Add Extensions
zen-site-data-site-settings =
    .label = All Site Settings


zen-site-data-header-share =
    .tooltiptext = Share This Page
zen-site-data-header-reader-mode =
    .tooltiptext = Enter Reader Mode
zen-site-data-header-screenshot =
    .tooltiptext = Take a Screenshot
zen-site-data-header-bookmark =
    .tooltiptext = Bookmark This Page

zen-urlbar-copy-url-button =
  .tooltiptext = Copy URL

zen-site-data-setting-site-protection = Tracking Protection

# Section: Feature callouts

zen-site-data-panel-feature-callout-title = A new home for add-ons, permissions, and more
zen-site-data-panel-feature-callout-subtitle = Click the icon to manage site settings, view security info, access extensions, and perform common actions.

zen-open-link-in-glance =
    .label = Open Link in Glance
    .accesskey = G

zen-sidebar-notification-updated-heading = Update Complete!
# $version is the browser version, e.g. 1.21.16b.
zen-sidebar-notification-updated-version = Version { $version }

# See ZenSidebarNotification.mjs to see how these would be used

zen-sidebar-notification-updated-label = What's new in { -brand-short-name }
zen-sidebar-notification-updated-tooltip =
    .title = View Release Notes
zen-sidebar-notification-donate-label = Support { -brand-short-name }
zen-sidebar-notification-donate-tooltip =
    .title = Donate to the project
zen-sidebar-notification-restart-safe-mode-label = Something broke?
zen-sidebar-notification-restart-safe-mode-tooltip =
    .title = Restart in Safe Mode

zen-window-sync-migration-dialog-title = Keep Your Windows in Sync
zen-window-sync-migration-dialog-message = Zen now syncs windows on the same device, so changes in one window are reflected across the others instantly.
zen-window-sync-migration-dialog-learn-more = Learn More
zen-window-sync-migration-dialog-accept = Got It

zen-appmenu-new-blank-window =
    .label = New Blank Window


zen-clipboard-copied =
    .value = Copied to clipboard

zen-tab-stick-bottom =
    .label = Pin to Bottom
zen-tab-unstick-bottom =
    .label = Unpin from Bottom

## Layout submenu on the toolbar context menu.

zen-layout-context-menu =
    .label = Layout
zen-layout-context-comfortable =
    .label = Comfortable
zen-layout-context-compact =
    .label = Compact
zen-layout-context-minimal =
    .label = Minimal
zen-layout-context-horizontal =
    .label = Horizontal tabs
zen-layout-context-shy =
    .label = Shy
zen-layout-context-custom-1 =
    .label = Custom 1
zen-layout-context-custom-2 =
    .label = Custom 2
zen-layout-context-custom-3 =
    .label = Custom 3
zen-layout-context-custom-4 =
    .label = Custom 4

zen-ui-layout-comfortable-toast = Layout: Comfortable
zen-ui-layout-compact-toast = Layout: Compact
zen-ui-layout-minimal-toast = Layout: Minimal
zen-ui-layout-horizontal-toast = Layout: Horizontal tabs
zen-ui-layout-shy-toast = Layout: Shy
zen-ui-layout-custom1-toast = Layout: Custom 1
zen-ui-layout-custom2-toast = Layout: Custom 2
zen-ui-layout-custom3-toast = Layout: Custom 3
zen-ui-layout-custom4-toast = Layout: Custom 4
zen-ui-layout-named-toast = Layout: { $name }

zen-right-rail-label =
    .value = Right rail

# Icon-only dismiss button on a sidebar card (page cards / Activity / Tor route).
zen-page-card-close =
    .aria-label = Dismiss card
    .tooltiptext = Dismiss card

zen-page-card-answering = Answering…
zen-page-card-finished = { $title } finished
zen-page-card-show-less = Show less
zen-page-card-show-more =
    { $count ->
        [one] Show 1 more
       *[other] Show { $count } more
    }

## Horizontal tab strip. The buttons are glyphs ("+", "×"), so the accessible
## name has to come from here rather than their text.

zen-htabs-new-tab =
    .title = New tab
    .aria-label = New tab
zen-htabs-close-tab =
    .title = Close tab
    .aria-label = Close tab

## Recently closed tabs, listed from a toolbar button.

zen-closed-tabs-button =
    .label = Recently Closed
    .tooltiptext = Reopen a recently closed tab
zen-closed-tabs-empty =
    .label = No recently closed tabs
zen-closed-tabs-restore-all =
    .label = Reopen All
zen-closed-tabs-clear =
    .label = Clear List

# The category tag on a page card. $kind comes from SITE_RULES; anything not
# listed falls through to the catch-all rather than rendering blank.
zen-page-card-kind =
    { $kind ->
        [chat] Chat
        [search] Search
        [image] Image
        [gallery] Gallery
        [artifact] Artifact
        [video] Video
        [code] Code
        [media] Media
        [status] Status
       *[other] { $kind }
    }

## ComfyUI activity card

zen-comfyui-title = ComfyUI
zen-comfyui-subtitle =
    { $running ->
        [0] { $pending } queued
       *[other] { $pending ->
            [0] Generating
           *[other] Generating · { $pending } queued
        }
    }
zen-comfyui-generating = Generating image
zen-comfyui-waiting = Waiting in queue

# Sidebar address-bar results. Only the kinds that are not obvious from the
# row itself get a tag. These sit in a narrow badge beside the address and are
# ellipsised past about 16 characters, so keep them short.
zen-sidebar-result-tag-tab = Open tab
zen-sidebar-result-tag-remote-tab = Other device
zen-sidebar-result-tag-bookmark = Bookmark

## Translate button: Firefox's urlbar translate icon as a movable toolbar button.

zen-translations-button =
    .label = Translate
    .tooltiptext = Translate this page
zen-translations-button-loading =
    .label = Translate
    .tooltiptext = Translation in progress
# $fromLanguage and $toLanguage are language names, e.g. "German", "English".
zen-translations-button-translated =
    .label = Translate
    .tooltiptext = Page translated from { $fromLanguage } to { $toLanguage }

## Media card: the ⋯ panel.
zen-media-external-button =
    .tooltiptext = Open in another app
zen-media-open-external =
    .label = Open video in { $player }
zen-media-more-button =
    .tooltiptext = More options
zen-media-more-volume = Volume
zen-media-more-speed = Speed
zen-media-more-source-site = Moves the site's own volume slider
zen-media-more-source-page = Sets the page's player directly
zen-media-more-source-none = This page has no volume to set
zen-media-more-copy = Copy link
zen-media-more-go = Go to tab

## Reel: the video's hover button, the address bar icon and their right-click menu.
zen-reel-button-label = reel
zen-reel-button-title = Open this video in reel
zen-reel-always = Always open { $host } videos in reel
zen-reel-after-header = After handing over
zen-reel-after-pause = Pause
zen-reel-after-close = Close tab
zen-reel-after-keep = Keep playing

## Translate button: right-click list of sites translated before.
zen-translations-sites-heading =
    .label = Translated before
zen-translations-sites-empty =
    .label = No translated sites yet
# $from and $to are language names, e.g. "German", "English".
zen-translations-sites-item =
    .label = { $host } ({ $from } → { $to })
zen-translations-sites-manage =
    .label = Manage translated sites…
