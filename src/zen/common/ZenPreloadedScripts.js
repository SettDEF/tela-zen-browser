// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// prettier-ignore
// eslint-disable-next-line no-lone-blocks
{
  ChromeUtils.defineESModuleGetters(this, {
    gZenSpaceRoutingManager:
      "resource:///modules/zen/spacerouting/ZenSpaceRoutingManager.sys.mjs",
  });

  Services.scriptloader.loadSubScript("chrome://browser/content/zen-components/ZenSpaceBookmarksStorage.js", this);

  let scripts = [
    "chrome://browser/content/ZenStartup.mjs",
    "resource:///modules/zen/ZenSpaceManager.mjs",
    "chrome://browser/content/zen-components/ZenCompactMode.mjs",
    "chrome://browser/content/zen-components/ZenLayoutPresets.mjs",
    "chrome://browser/content/ZenUIManager.mjs",
    "chrome://browser/content/zen-components/ZenMods.mjs",
    "chrome://browser/content/zen-components/ZenKeyboardShortcuts.mjs",
    "chrome://browser/content/zen-components/ZenSessionStore.mjs",
    "chrome://browser/content/zen-components/ZenCardStack.mjs",
    "chrome://browser/content/zen-components/ZenComfyUI.mjs",
    "chrome://browser/content/zen-components/ZenMediaController.mjs",
    "chrome://browser/content/zen-components/ZenGlanceManager.mjs",
    "chrome://browser/content/zen-components/ZenPinnedTabManager.mjs",
    "chrome://browser/content/zen-components/ZenViewSplitter.mjs",
    "chrome://browser/content/zen-components/ZenFolders.mjs",
    "chrome://browser/content/zen-components/ZenEmojiPicker.mjs",
    "chrome://browser/content/zen-components/ZenLiveFoldersUI.mjs",
    "chrome://browser/content/zen-components/ZenDownloadAnimation.mjs",
    "resource:///modules/ZenSidebarResults.sys.mjs",
    "chrome://browser/content/zen-components/ZenTabFocus.mjs",
    "chrome://browser/content/zen-components/ZenTabUnload.mjs",
    "chrome://browser/content/zen-components/ZenAgentUI.mjs",
    "chrome://browser/content/zen-components/ZenClosedTabs.mjs",
    "chrome://browser/content/zen-components/ZenTranslationsButton.mjs",
    "chrome://browser/content/zen-components/ZenHorizontalTabs.mjs",
    "chrome://browser/content/zen-components/ZenStickyTabs.mjs",
    "chrome://browser/content/zen-components/ZenSiteIcons.mjs",
    "chrome://browser/content/zen-components/ZenPageCards.mjs",
    "chrome://browser/content/zen-components/ZenClipboardToast.mjs",
    "chrome://browser/content/zen-components/ZenPictureInPicture.mjs",
    "chrome://browser/content/zen-components/ZenSiteWidths.mjs",
    "chrome://browser/content/zen-components/ZenSidebarResizer.mjs",
    "chrome://browser/content/zen-components/ZenRightRail.mjs",
    "chrome://browser/content/zen-components/ZenTor.mjs",
    "chrome://browser/content/zen-components/ZenTorPanel.mjs",
    "resource:///modules/ZenSearchEngine.sys.mjs",
  ];

  for (let script of scripts) {
    // Without this, one throwing module aborted the loop and silently
    // dropped every script after it.
    try {
      ChromeUtils.importESModule(script, { global: "current" });
    } catch (ex) {
      console.error("[zen] failed to load " + script, ex);
    }
  }

  let customZenElements = [
    ["zen-folder", "chrome://browser/content/zen-components/ZenFolder.mjs"],
    ["zen-workspace-creation", "resource:///modules/zen/ZenSpaceCreation.mjs"],
    ["zen-workspace", "resource:///modules/zen/ZenSpace.mjs"],
    ["zen-workspace-icons", "resource:///modules/zen/ZenSpaceIcons.mjs"]
  ];

  document.addEventListener(
    "DOMContentLoaded",
    () => {
      // Only sync-import widgets once the document has loaded. If a widget is
      // used before DOMContentLoaded it will be imported and upgraded when
      // registering the customElements.setElementCreationCallback().
      for (let [tag, script] of customZenElements) {
        customElements.setElementCreationCallback(
          tag,
          function customElementCreationCallback() {
            ChromeUtils.importESModule(script, { global: "current" });
          }
        );
      }
    },
    { once: true }
  );

  Services.scriptloader.loadSubScript("chrome://browser/content/zen-components/ZenDragAndDrop.js", this);
}
