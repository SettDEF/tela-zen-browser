/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  SessionStore: "resource:///modules/sessionstore/SessionStore.sys.mjs",
});

class nsZenUIMigration {
  PREF_NAME = "zen.ui.migration.version";
  MIGRATION_VERSION = 8;

  init(isNewProfile) {
    if (!isNewProfile) {
      try {
        this._migrate();
      } catch (e) {
        console.error("ZenUIMigration: Error during migration", e);
      }
    }
    this.clearVariables();
    if (this.shouldRestart) {
      Services.startup.quit(
        Ci.nsIAppStartup.eAttemptQuit | Ci.nsIAppStartup.eRestart
      );
    }
  }

  get _migrationVersion() {
    return Services.prefs.getIntPref(this.PREF_NAME, 0);
  }

  set _migrationVersion(value) {
    Services.prefs.setIntPref(this.PREF_NAME, value);
  }

  _migrate() {
    for (let i = 0; i <= this.MIGRATION_VERSION; i++) {
      if (this._migrationVersion < i) {
        this[`_migrateV${i}`]?.();
      }
    }
  }

  clearVariables() {
    this._migrationVersion = this.MIGRATION_VERSION;
  }

  _migrateV1() {
    // If there's an userChrome.css or userContent.css existing, we set
    // 'toolkit.legacyUserProfileCustomizations.stylesheets' back to true
    // We do this to avoid existing user stylesheets to be ignored
    const profileDir = Services.dirsvc.get("ProfD", Ci.nsIFile);
    const userChromeFile = profileDir.clone();
    userChromeFile.append("chrome");
    userChromeFile.append("userChrome.css");
    const userContentFile = profileDir.clone();
    userContentFile.append("chrome");
    userContentFile.append("userContent.css");
    Services.prefs.setBoolPref(
      "zen.workspaces.separate-essentials",
      Services.prefs.getBoolPref(
        "zen.workspaces.container-specific-essentials-enabled",
        false
      )
    );
    const theme = Services.prefs.getIntPref(
      "layout.css.prefers-color-scheme.content-override",
      0
    );
    Services.prefs.setIntPref("zen.view.window.scheme", theme);
    if (userChromeFile.exists() || userContentFile.exists()) {
      Services.prefs.setBoolPref(
        "toolkit.legacyUserProfileCustomizations.stylesheets",
        true
      );
      console.warn(
        "ZenUIMigration: User stylesheets detected, enabling legacy stylesheets."
      );
      this.shouldRestart = true;
    }
  }

  _migrateV2() {
    if (AppConstants.platform !== "linux") {
      Services.prefs.setIntPref("zen.theme.gradient-legacy-version", 0);
    }
  }

  _migrateV3() {
    if (
      Services.prefs
        .getStringPref("zen.theme.accent-color", "")
        .startsWith("system")
    ) {
      Services.prefs.setStringPref("zen.theme.accent-color", "AccentColor");
    }
  }

  _migrateV4() {
    // Fix spelling mistake in preference name
    Services.prefs.setBoolPref(
      "zen.theme.use-system-colors",
      Services.prefs.getBoolPref("zen.theme.use-sysyem-colors", false)
    );
  }

  _migrateV5() {
    Services.prefs.setBoolPref("zen.site-data-panel.show-callout", true);
  }

  _migrateV6() {
    lazy.SessionStore.promiseAllWindowsRestored.then(() => {
      const win = Services.wm.getMostRecentWindow("navigator:browser");
      win.setTimeout(async () => {
        const [title, message, learnMore, accept] =
          await win.document.l10n.formatMessages([
            "zen-window-sync-migration-dialog-title",
            "zen-window-sync-migration-dialog-message",
            "zen-window-sync-migration-dialog-learn-more",
            "zen-window-sync-migration-dialog-accept",
          ]);

        // buttonPressed will be 0 for cancel, 1 for "more info"
        let buttonPressed = Services.prompt.confirmEx(
          win,
          title.value,
          message.value,
          Services.prompt.BUTTON_POS_0 *
            Services.prompt.BUTTON_TITLE_IS_STRING +
            Services.prompt.BUTTON_POS_1 *
              Services.prompt.BUTTON_TITLE_IS_STRING,
          learnMore.value,
          accept.value,
          null,
          null,
          {}
        );
        // User has clicked on "Learn More"
        if (buttonPressed === 0) {
          win.openTrustedLinkIn(
            "https://docs.zen-browser.app/user-manual/window-sync",
            "tab"
          );
        }
      }, 1000);
    });
  }

  _migrateV7() {
    if (
      AppConstants.platform === "macosx" &&
      Services.prefs.prefHasUserValue(
        "widget.macos.sidebar-blend-mode.behind-window"
      ) &&
      !Services.prefs.getBoolPref(
        "widget.macos.sidebar-blend-mode.behind-window"
      )
    ) {
      Services.prefs.setBoolPref("zen.widget.macos.window-vibrancy", false);
    }
  }

  /* The onion's empty-tab visibility was zen.tor.hide-on-empty-tab
     (never | unrouted | always); the layout presets' per-state widget config
     owns it now, and its shipped default is what "unrouted" meant. Written
     out in pref names because a migration has to keep meaning what it meant. */
  _migrateV8() {
    const OLD_PREF = "zen.tor.hide-on-empty-tab";
    if (!Services.prefs.prefHasUserValue(OLD_PREF)) {
      return;
    }
    const mode = Services.prefs.getStringPref(OLD_PREF, "unrouted");
    Services.prefs.clearUserPref(OLD_PREF);

    const ONION = "zen-tor-status-button";
    const SLOT_KEYS = [
      "compact-mode",
      "hide-tabbar",
      "hide-toolbar",
      "tab-style",
      "right-side",
      "vertical-tabs",
    ];
    const targets = ["zen.ui.layout-preset.widgets"];
    for (const slot of ["custom1", "custom2", "custom3", "custom4"]) {
      const base = `zen.ui.layout-preset.${slot}`;
      // Only slots that already hold something: a user value on an empty one
      // would turn it into a configured card in the presets manager.
      if (
        Services.prefs.getBoolPref(`${base}.saved`, false) ||
        SLOT_KEYS.some(key => Services.prefs.prefHasUserValue(`${base}.${key}`))
      ) {
        targets.push(`${base}.widgets`);
      }
    }

    for (const pref of targets) {
      let widgets;
      try {
        widgets = JSON.parse(Services.prefs.getStringPref(pref, "{}")) || {};
      } catch {
        widgets = {};
      }
      const place = (state, hidden) => {
        const ids = new Set(widgets[state] ?? []);
        if (hidden) {
          ids.add(ONION);
        } else {
          ids.delete(ONION);
        }
        widgets[state] = [...ids];
      };
      place("emptyTab", mode !== "never");
      place("torEmptyTab", mode === "always");
      Services.prefs.setStringPref(pref, JSON.stringify(widgets));
    }
  }
}

export var gZenUIMigration = new nsZenUIMigration();
