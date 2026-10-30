/* eslint-disable no-undef */
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

const { nsZenMultiWindowFeature } = ChromeUtils.importESModule(
  "chrome://browser/content/zen-components/ZenCommonUtils.mjs",
  { global: "current" }
);

const { nsKeyShortcutModifiers } = ChromeUtils.importESModule(
  "chrome://browser/content/zen-components/ZenKeyboardShortcuts.mjs",
  {
    global: "current",
  }
);

const { ZenMaterialPalette } = ChromeUtils.importESModule(
  "chrome://browser/content/preferences/zen-material-palette.mjs",
  { global: "current" }
);

const { ZenLayoutPresetData } = ChromeUtils.importESModule(
  "chrome://browser/content/zen-components/ZenLayoutPresetData.mjs",
  { global: "current" }
);

// about:preferences is its own top-level document - no gZenLayoutPresets, no
// gBrowser - so the widget picker below reads placements straight from here.
// Their *names* it still has to ask the browser window for; see widgetName.
const { CustomizableUI } = ChromeUtils.importESModule(
  "moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs"
);

// The theme tag and palette, the same as the browser window's: the desktop
// shell's generated Material palette when there is one (never awaited: the
// page paints on the browser's own tokens and swaps a frame later), or the
// custom accent. The Settings page has always followed the palette, in the
// default theme too.
ZenMaterialPalette.syncTheme(window, { paletteInDefault: true });

var gZenMarketplaceManager = {
  async init() {
    const checkForUpdates = document.getElementById("zenThemeMarketplaceCheckForUpdates");
    const header = document.getElementById("zenMarketplaceHeader");

    if (!checkForUpdates || !header) {
      return; // We haven't entered the settings page yet.
    }

    if (this.__hasInitializedEvents) {
      return;
    }

    if (!window.gZenMods) {
      window.gZenMods = nsZenMultiWindowFeature.currentBrowser.gZenMods;
    }

    header.appendChild(this._initDisableAll());

    this._initImportExport();

    this.__hasInitializedEvents = true;

    await this._buildModsList();

    Services.prefs.addObserver(gZenMods.updatePref, this);

    const checkForUpdateClick = (event) => {
      if (event.target === checkForUpdates) {
        event.preventDefault();

        this._checkForThemeUpdates(event);
      }
    };

    checkForUpdates.addEventListener("click", checkForUpdateClick);

    document.addEventListener("ZenModsMarketplace:CheckForUpdatesFinished", (event) => {
      checkForUpdates.disabled = false;

      const updates = event.detail.updates;
      const success = document.getElementById("zenThemeMarketplaceUpdatesSuccess");
      const error = document.getElementById("zenThemeMarketplaceUpdatesFailure");

      if (updates) {
        success.hidden = false;
        error.hidden = true;
      } else {
        success.hidden = true;
        error.hidden = false;
      }
    });

    window.addEventListener("unload", () => {
      Services.prefs.removeObserver(gZenMods.updatePref, this);
      this.__hasInitializedEvents = false;

      document.removeEventListener("ZenModsMarketplace:CheckForUpdatesFinished", this);
      document.removeEventListener("ZenCheckForModUpdates", this);

      checkForUpdates.removeEventListener("click", checkForUpdateClick);

      this.modsList.innerHTML = "";
      this._doNotRebuildModsList = false;
    });
  },

  _initImportExport() {
    const importButton = document.getElementById("zenThemeMarketplaceImport");
    const exportButton = document.getElementById("zenThemeMarketplaceExport");

    if (importButton) {
      importButton.addEventListener("click", this._importThemes.bind(this));
    }

    if (exportButton) {
      exportButton.addEventListener("click", this._exportThemes.bind(this));
    }
  },

  _initDisableAll() {
    const areModsDisabled = Services.prefs.getBoolPref("zen.themes.disable-all", false);
    const browser = nsZenMultiWindowFeature.currentBrowser;
    const mozToggle = document.createElement("moz-toggle");

    mozToggle.className =
      "zenThemeMarketplaceItemPreferenceToggle zenThemeMarketplaceDisableAllToggle";
    mozToggle.pressed = !areModsDisabled;

    browser.document.l10n.setAttributes(
      mozToggle,
      `zen-theme-disable-all-${!areModsDisabled ? "enabled" : "disabled"}`
    );

    mozToggle.addEventListener("toggle", async (event) => {
      const { pressed = false } = event.target || {};

      this.modsList.style.display = pressed ? "" : "none";
      Services.prefs.setBoolPref("zen.themes.disable-all", !pressed);
      browser.document.l10n.setAttributes(
        mozToggle,
        `zen-theme-disable-all-${pressed ? "enabled" : "disabled"}`
      );
    });

    if (areModsDisabled) {
      this.modsList.style.display = "none";
    }

    return mozToggle;
  },

  async observe() {
    await this._buildModsList();
  },

  _checkForThemeUpdates(event) {
    // Send a message to the child to check for theme updates.
    event.target.disabled = true;
    // send an event that will be listened by the child process.
    document.dispatchEvent(new CustomEvent("ZenCheckForModUpdates"));
  },

  get modsList() {
    if (!this._modsList) {
      this._modsList = document.getElementById("zenThemeMarketplaceList");
    }
    return this._modsList;
  },

  _triggerBuildUpdateWithoutRebuild() {
    this._doNotRebuildModsList = true;
    gZenMods.triggerModsUpdate();
  },

  async removeMod(modId) {
    await gZenMods.removeMod(modId);

    gZenMods.triggerModsUpdate();
  },

  async disableMod(modId) {
    await gZenMods.disableMod(modId);

    this._triggerBuildUpdateWithoutRebuild();
  },

  async enableMod(modId) {
    await gZenMods.enableMod(modId);

    this._triggerBuildUpdateWithoutRebuild();
  },

  async _importThemes() {
    const errorBox = document.getElementById("zenThemeMarketplaceImportFailure");
    const successBox = document.getElementById("zenThemeMarketplaceImportSuccess");

    successBox.hidden = true;
    errorBox.hidden = true;

    const input = document.createElement("input");

    input.type = "file";
    input.accept = ".json";
    input.style.display = "none";
    input.setAttribute("moz-accept", ".json");
    input.setAttribute("accept", ".json");

    let timeout;

    const filePromise = new Promise((resolve) => {
      input.addEventListener("change", (event) => {
        if (timeout) {
          clearTimeout(timeout);
        }

        const file = event.target.files[0];
        resolve(file);
      });

      timeout = setTimeout(() => {
        console.warn("[ZenSettings:ZenMods]: Import timeout reached, aborting.");
        resolve(null);
      }, 60000);
    });

    input.addEventListener("cancel", () => {
      console.warn("[ZenSettings:ZenMods]: Import cancelled by user.");
      clearTimeout(timeout);
    });

    input.click();

    try {
      const file = await filePromise;

      if (!file) {
        return;
      }

      const content = await file.text();

      const mods = JSON.parse(content);

      for (const mod of Object.values(mods)) {
        mod.modId = mod.id;
        await window.ZenInstallMod(mod);
      }
    } catch (error) {
      console.error("[ZenSettings:ZenMods]: Error while importing mods:", error);
      errorBox.hidden = false;
    }

    if (input) {
      input.remove();
    }
  },

  async _exportThemes() {
    const errorBox = document.getElementById("zenThemeMarketplaceExportFailure");
    const successBox = document.getElementById("zenThemeMarketplaceExportSuccess");

    successBox.hidden = true;
    errorBox.hidden = true;

    let temporalAnchor, temporalUrl;
    try {
      const mods = await gZenMods.getMods();
      const modsJson = JSON.stringify(mods, null, 2);
      const blob = new Blob([modsJson], { type: "application/json" });

      temporalUrl = URL.createObjectURL(blob);
      // Creating a link to download the JSON file
      temporalAnchor = document.createElement("a");
      temporalAnchor.href = temporalUrl;
      temporalAnchor.download = "zen-mods-export.json";

      document.body.appendChild(temporalAnchor);
      temporalAnchor.click();
      temporalAnchor.remove();

      successBox.hidden = false;
    } catch (error) {
      console.error("[ZenSettings:ZenMods]: Error while exporting mods:", error);
      errorBox.hidden = false;
    }

    if (temporalAnchor) {
      temporalAnchor.remove();
    }

    if (temporalUrl) {
      URL.revokeObjectURL(temporalUrl);
    }
  },

  async _buildModsList() {
    if (!this.modsList) {
      return;
    }

    if (this._doNotRebuildModsList) {
      this._doNotRebuildModsList = false;
      return;
    }

    const mods = await gZenMods.getMods();
    const browser = nsZenMultiWindowFeature.currentBrowser;
    const modList = document.createElement("div");

    for (const mod of Object.values(mods).sort((a, b) => a.name.localeCompare(b.name))) {
      const sanitizedName = gZenMods.sanitizeModName(mod.name);
      const isModEnabled = mod.enabled === undefined || mod.enabled;
      const fragment = window.MozXULElement.parseXULToFragment(`
        <vbox class="zenThemeMarketplaceItem">
          <vbox class="zenThemeMarketplaceItemContent">
            <hbox flex="1" id="zenThemeMarketplaceItemContentHeader">
              <label><h3 class="zenThemeMarketplaceItemTitle"></h3></label>
            </hbox>
            <description class="description-deemphasized zenThemeMarketplaceItemDescription"></description>
          </vbox>
          <hbox class="zenThemeMarketplaceItemActions">
            ${mod.preferences ? `<button id="zenThemeMarketplaceItemConfigureButton-${sanitizedName}" class="zenThemeMarketplaceItemConfigureButton" hidden="true"></button>` : ""}
            ${mod.homepage ? `<button id="zenThemeMarketplaceItemHomePageLink-${sanitizedName}" class="zenThemeMarketplaceItemHomepageButton" zen-mod-id="${mod.id}"></button>` : ""}
            <button class="zenThemeMarketplaceItemUninstallButton" data-l10n-id="zen-theme-marketplace-remove-button" zen-mod-id="${mod.id}"></button>
          </hbox>
        </vbox>
      `);

      const modName = `${mod.name} (v${mod.version ?? "1.0.0"})`;

      const base = fragment.querySelector(".zenThemeMarketplaceItem");
      const baseHeader = fragment.querySelector("#zenThemeMarketplaceItemContentHeader");

      const dialog = document.createElement("dialog");
      const mainDialogDiv = document.createElement("div");
      const headerDiv = document.createElement("div");
      const headerTitle = document.createElement("h3");
      const closeButton = document.createElement("button");
      const contentDiv = document.createElement("div");
      const mozToggle = document.createElement("moz-toggle");

      mainDialogDiv.className = "zenThemeMarketplaceItemPreferenceDialog";
      headerDiv.className = "zenThemeMarketplaceItemPreferenceDialogTopBar";
      headerTitle.textContent = modName;
      browser.document.l10n.setAttributes(headerTitle, "zen-theme-marketplace-theme-header-title", {
        name: sanitizedName,
      });
      headerTitle.className = "zenThemeMarketplaceItemTitle";
      closeButton.id = `${sanitizedName}-modal-close`;
      browser.document.l10n.setAttributes(closeButton, "zen-theme-marketplace-close-modal");
      contentDiv.id = `${sanitizedName}-preferences-content`;
      contentDiv.className = "zenThemeMarketplaceItemPreferenceDialogContent";
      mozToggle.className = "zenThemeMarketplaceItemPreferenceToggle";

      mozToggle.pressed = isModEnabled;
      browser.document.l10n.setAttributes(
        mozToggle,
        `zen-theme-marketplace-toggle-${isModEnabled ? "enabled" : "disabled"}-button`
      );

      baseHeader.appendChild(mozToggle);

      headerDiv.appendChild(headerTitle);
      headerDiv.appendChild(closeButton);

      mainDialogDiv.appendChild(headerDiv);
      mainDialogDiv.appendChild(contentDiv);
      dialog.appendChild(mainDialogDiv);
      base.appendChild(dialog);

      closeButton.addEventListener("click", () => {
        dialog.close();
      });

      mozToggle.addEventListener("toggle", async (event) => {
        const modId = event.target
          .closest(".zenThemeMarketplaceItem")
          .querySelector(".zenThemeMarketplaceItemUninstallButton")
          .getAttribute("zen-mod-id");
        event.target.setAttribute("disabled", true);

        if (!event.target.hasAttribute("pressed")) {
          await this.disableMod(modId);

          browser.document.l10n.setAttributes(
            mozToggle,
            "zen-theme-marketplace-toggle-disabled-button"
          );

          if (mod.preferences) {
            document
              .getElementById(`zenThemeMarketplaceItemConfigureButton-${sanitizedName}`)
              .setAttribute("hidden", true);
          }
        } else {
          await this.enableMod(modId);

          browser.document.l10n.setAttributes(
            mozToggle,
            "zen-theme-marketplace-toggle-enabled-button"
          );

          if (mod.preferences) {
            document
              .getElementById(`zenThemeMarketplaceItemConfigureButton-${sanitizedName}`)
              .removeAttribute("hidden");
          }
        }
        setTimeout(() => {
          // We use a timeout to make sure the theme list has been updated before re-enabling the button.
          event.target.removeAttribute("disabled");
        }, 400);
      });

      fragment.querySelector(".zenThemeMarketplaceItemTitle").textContent = modName;
      fragment.querySelector(".zenThemeMarketplaceItemDescription").textContent = mod.description;
      fragment
        .querySelector(".zenThemeMarketplaceItemUninstallButton")
        .addEventListener("click", async (event) => {
          const [msg] = await document.l10n.formatValues([
            { id: "zen-theme-marketplace-remove-confirmation" },
          ]);

          if (!confirm(msg)) {
            return;
          }

          await this.removeMod(event.target.getAttribute("zen-mod-id"));
        });

      if (mod.homepage) {
        const homepageButton = fragment.querySelector(".zenThemeMarketplaceItemHomepageButton");
        homepageButton.addEventListener("click", () => {
          // open the homepage url in a new tab
          const url = mod.homepage;

          window.open(url, "_blank");
        });
      }

      if (mod.preferences) {
        fragment
          .querySelector(".zenThemeMarketplaceItemConfigureButton")
          .addEventListener("click", () => {
            dialog.showModal();
          });

        if (isModEnabled) {
          fragment
            .querySelector(".zenThemeMarketplaceItemConfigureButton")
            .removeAttribute("hidden");
        }
      }

      const preferences = await gZenMods.getModPreferences(mod);

      if (preferences.length) {
        const preferencesWrapper = document.createXULElement("vbox");

        preferencesWrapper.setAttribute("flex", "1");

        for (const entry of preferences) {
          const { property, label, type, placeholder, defaultValue } = entry;

          switch (type) {
            case "dropdown": {
              const { options } = entry;

              const container = document.createXULElement("hbox");
              container.classList.add("zenThemeMarketplaceItemPreference");
              container.setAttribute("align", "center");
              container.setAttribute("role", "group");

              const menulist = document.createXULElement("menulist");
              const menupopup = document.createXULElement("menupopup");

              menulist.setAttribute("sizetopopup", "none");
              menulist.setAttribute("id", property + "-popup-menulist");

              const savedValue = Services.prefs.getStringPref(property, defaultValue ?? "none");

              menulist.setAttribute("value", savedValue);
              menulist.setAttribute("tooltiptext", property);

              const defaultItem = document.createXULElement("menuitem");

              defaultItem.setAttribute("value", "none");

              if (placeholder) {
                defaultItem.setAttribute("label", placeholder || "-");
              } else {
                browser.document.l10n.setAttributes(
                  defaultItem,
                  "zen-theme-marketplace-dropdown-default-label"
                );
              }

              menupopup.appendChild(defaultItem);

              for (const option of options) {
                let { label: optionLabel, value } = option;
                let valueType = typeof value;

                if (!["string", "number"].includes(valueType)) {
                  console.warn(
                    `[ZenSettings:ZenMods]: Warning, invalid data type received (${valueType}), skipping.`
                  );
                  continue;
                }

                let menuitem = document.createXULElement("menuitem");

                menuitem.setAttribute("value", value.toString());
                menuitem.setAttribute("label", optionLabel);

                menupopup.appendChild(menuitem);
              }

              menulist.appendChild(menupopup);

              menulist.addEventListener("command", () => {
                const value = menulist.selectedItem.value;

                let element = browser.document.getElementById(sanitizedName);

                if (!element) {
                  element = browser.document.createElement("div");

                  element.style.display = "none";
                  element.setAttribute("id", sanitizedName);

                  browser.document.body.appendChild(element);
                }

                element.setAttribute(property?.replaceAll(/\./g, "-"), value);

                Services.prefs.setStringPref(property, value === "none" ? "" : value);
                this._triggerBuildUpdateWithoutRebuild();
              });

              const nameLabel = document.createXULElement("label");
              nameLabel.setAttribute("flex", "1");
              nameLabel.setAttribute("class", "zenThemeMarketplaceItemPreferenceLabel");
              nameLabel.setAttribute("value", label);
              nameLabel.setAttribute("tooltiptext", property);

              container.appendChild(nameLabel);
              container.appendChild(menulist);
              container.setAttribute("aria-labelledby", label);

              preferencesWrapper.appendChild(container);
              break;
            }

            case "checkbox": {
              const checkbox = window.MozXULElement.parseXULToFragment(`
                <hbox class="zenThemeMarketplaceItemPreference">
                  <checkbox class="zenThemeMarketplaceItemPreferenceCheckbox"></checkbox>
                </hbox>
              `);

              const checkboxElement = checkbox.querySelector(
                ".zenThemeMarketplaceItemPreferenceCheckbox"
              );
              checkboxElement.setAttribute("label", label);
              checkboxElement.setAttribute("tooltiptext", property);
              checkboxElement.setAttribute("zen-pref", property);

              // Checkbox only works with "true" and "false" values, it's not like HTML checkboxes.
              if (Services.prefs.getBoolPref(property, defaultValue ?? false)) {
                checkboxElement.setAttribute("checked", "true");
              }

              checkboxElement.addEventListener("click", (event) => {
                const target = event.target.closest(".zenThemeMarketplaceItemPreferenceCheckbox");
                const key = target.getAttribute("zen-pref");
                const checked = target.hasAttribute("checked");

                if (!checked) {
                  target.removeAttribute("checked");
                } else {
                  target.setAttribute("checked", "true");
                }

                Services.prefs.setBoolPref(key, !checked);
              });

              preferencesWrapper.appendChild(checkbox);
              break;
            }

            case "string": {
              const container = document.createXULElement("hbox");
              container.classList.add("zenThemeMarketplaceItemPreference");
              container.setAttribute("align", "center");
              container.setAttribute("role", "group");

              const savedValue = Services.prefs.getStringPref(property, defaultValue ?? "");
              const sanitizedProperty = property?.replaceAll(/\./g, "-");

              const input = document.createElement("input");
              input.setAttribute("flex", "1");
              input.setAttribute("type", "text");
              input.id = `${sanitizedProperty}-input`;
              input.value = savedValue;

              if (placeholder) {
                input.setAttribute("placeholder", placeholder || "-");
              } else {
                browser.document.l10n.setAttributes(
                  input,
                  "zen-theme-marketplace-input-default-placeholder"
                );
              }

              input.addEventListener(
                "change",
                gZenMods.debounce((event) => {
                  const value = event.target.value;

                  Services.prefs.setStringPref(property, value);
                  this._triggerBuildUpdateWithoutRebuild();

                  if (value === "") {
                    browser.document
                      .querySelector(":root")
                      .style.removeProperty(`--${sanitizedProperty}`);
                  } else {
                    browser.document
                      .querySelector(":root")
                      .style.setProperty(`--${sanitizedProperty}`, value);
                  }
                }, 500)
              );

              const nameLabel = document.createXULElement("label");
              nameLabel.setAttribute("flex", "1");
              nameLabel.setAttribute("class", "zenThemeMarketplaceItemPreferenceLabel");
              nameLabel.setAttribute("value", label);
              nameLabel.setAttribute("tooltiptext", property);

              container.appendChild(nameLabel);
              container.appendChild(input);
              container.setAttribute("aria-labelledby", label);

              preferencesWrapper.appendChild(container);
              break;
            }

            default:
              console.warn(
                `[ZenSettings:ZenMods]: Warning, unknown preference type received (${type}), skipping.`
              );
              continue;
          }
        }
        contentDiv.appendChild(preferencesWrapper);
      }
      modList.appendChild(fragment);
    }

    this.modsList.replaceChildren(...modList.children);
    modList.remove();
  },
};

// ---------------------------------------------------------------- presets
//
// The layout manager: one card per preset, ordered by the user, previewed
// from what the preset actually holds. Everything it stores goes through
// ZenLayoutPresetData, so the cards, the toolbar context submenu and the
// cycle shortcut are one list rather than three.

var gZenLayoutPresetsUI = {
  init() {
    if (this.__hasInitialized) {
      return;
    }
    this.__hasInitialized = true;
    this.list = document.getElementById("zenUILayoutList");
    if (!this.list) {
      return;
    }
    this.widgetsList = document.getElementById("zenUILayoutWidgetsList");

    const watched = [
      ZenLayoutPresetData.PRESET_PREF,
      ZenLayoutPresetData.ORDER_PREF,
      ...ZenLayoutPresetData.LIVE_PREFS.map(entry => entry.live),
    ];
    for (const pref of watched) {
      Services.prefs.addObserver(pref, this);
    }
    window.addEventListener("unload", () => {
      for (const pref of watched) {
        Services.prefs.removeObserver(pref, this);
      }
    });

    this.list.addEventListener("dragover", this);
    this.list.addEventListener("drop", this);
    this.list.addEventListener("dragend", this);
    this.render();
  },

  observe(_subject, _topic, data) {
    if (data === ZenLayoutPresetData.PRESET_PREF) {
      this.syncSelection();
      return;
    }
    if (data === ZenLayoutPresetData.ORDER_PREF) {
      this.render();
      return;
    }
    // A live pref moved, which under a custom slot means that slot's own
    // arrangement changed - so its picture is now wrong.
    const current = ZenLayoutPresetData.current;
    if (ZenLayoutPresetData.isCustomSlot(current) && !this._renaming) {
      this.render();
    }
  },

  // Configured presets in the user's order, then the empty slots. An empty
  // slot is an invitation, not a stop on the cycle, so it does not sit in
  // the middle of the row it is not part of.
  get displayOrder() {
    const order = ZenLayoutPresetData.order;
    return order
      .filter(name => ZenLayoutPresetData.isConfigured(name))
      .concat(order.filter(name => !ZenLayoutPresetData.isConfigured(name)));
  },

  render() {
    this.list.replaceChildren(...this.displayOrder.map(name => this.buildCard(name)));
    this.syncSelection();
  },

  syncSelection() {
    const current = ZenLayoutPresetData.current;
    for (const card of this.list.children) {
      card
        .querySelector(".zen-choice")
        .classList.toggle("selected", card.dataset.preset === current);
    }
    /* gZenLayoutPresets is a global on the BROWSER window; about:preferences is
       a different window and never had it, so reaching for it here threw and
       killed the rest of the script - taking every section below it with it. */
    const isCustom = ZenLayoutPresetData.isCustomSlot(current);
    document.getElementById("zenUILayoutCustomControls").hidden = !isCustom;
    this.renderWidgetsList();
  },

  // Widgets actually placed somewhere a preset could plausibly want to hide
  // them - the areas a person can drag a button into from Customize Toolbar.
  WIDGET_AREAS: [CustomizableUI.AREA_NAVBAR, CustomizableUI.AREA_BOOKMARKS, "zen-right-rail"],

  // Springs, separators and the vertical spacer are layout filler, not
  // something a person would ever mean to hide in one state.
  NOT_HIDEABLE: /^customizableui-special-|^vertical-spacer$/,

  availableWidgets() {
    const seen = new Set();
    for (const area of this.WIDGET_AREAS) {
      if (!CustomizableUI.areas.includes(area)) {
        continue;
      }
      for (const id of CustomizableUI.getWidgetIdsInArea(area)) {
        if (!this.NOT_HIDEABLE.test(id)) {
          seen.add(id);
        }
      }
    }
    return [...seen];
  },

  // Reads and writes the *live* widgets pref directly, same as the
  // compact-mode/hide-tabbar/etc. checkboxes above bind straight to their
  // live prefs - ZenLayoutPresets mirrors it into the selected slot's own
  // copy the moment it changes, so there is nothing to save explicitly.
  renderWidgetsList() {
    if (!this.widgetsList) {
      return;
    }
    const widgets = ZenLayoutPresetData.getLiveWidgets();
    this.widgetsList.replaceChildren(
      ...this.availableWidgets().map(id => this.buildWidgetRow(id, widgets))
    );
  },

  // Ordered by how likely the attribute is to be a name and not a sentence.
  NAME_ATTRIBUTES: ["label", "title", "aria-label", "tooltiptext"],

  // The one placeable item Firefox names nowhere at all. Not a general
  // id -> string map: everything else carries its own name, read below.
  UNNAMED_WIDGETS: { "urlbar-container": "zen-ui-layout-widget-urlbar-container" },

  get browserWindow() {
    return window.browsingContext?.topChromeWindow ?? null;
  },

  // A widget can be placed without being built into the window, and then the
  // palette holds the only node there is.
  widgetNode(id) {
    const win = this.browserWindow;
    return (
      win?.document.getElementById(id) ??
      win?.gNavToolbox?.palette?.querySelector("#" + CSS.escape(id)) ??
      null
    );
  },

  // Asked of the browser window rather than listed here, so a widget that
  // brings its own .ftl needs no entry. Sync: a row's name is needed where
  // the row is built.
  get widgetL10n() {
    if (!this._widgetL10n) {
      const links = this.browserWindow?.document.querySelectorAll("link[rel=localization]");
      const files = [...(links ?? [])].map(link => link.getAttribute("href"));
      this._widgetL10n = new Localization(
        files.concat("browser/preferences/zen-preferences.ftl"),
        true
      );
    }
    return this._widgetL10n;
  },

  /* CustomizableUI.getLocalizedProperty reads customizableWidgets.properties,
     a dozen legacy widgets and nothing since, so it answers with the id for
     back-button as readily as for ours. Names live on the node now - and an
     extension's button is named nowhere else at all. */
  widgetName(id) {
    const node = this.widgetNode(id);
    for (const attribute of this.NAME_ATTRIBUTES) {
      const value = node?.getAttribute(attribute)?.trim();
      if (value) {
        return value;
      }
    }
    // Nothing painted it, so nothing translated it either - but it still says
    // which message names it.
    return (
      this.messageName(node?.getAttribute("data-l10n-id")) ??
      this.messageName(this.UNNAMED_WIDGETS[id] ?? "zen-ui-layout-widget-unnamed", { id }) ??
      id
    );
  },

  // A widget's name is an attribute of its message, not the message's value.
  messageName(message, args) {
    if (!message) {
      return null;
    }
    try {
      const [formatted] = this.widgetL10n.formatMessagesSync([{ id: message, args }]);
      const named = this.NAME_ATTRIBUTES.map(
        name => formatted?.attributes?.find(attribute => attribute.name === name)?.value
      );
      return named.find(value => value) ?? formatted?.value ?? null;
    } catch (ex) {
      console.error("[zen-settings] could not format " + message, ex);
      return null;
    }
  },

  buildWidgetRow(id, widgets) {
    const row = document.createElement("div");
    row.className = "zen-ui-layout-widget-row";
    const widgetName = this.widgetName(id);
    const label = document.createElement("span");
    label.className = "zen-ui-layout-widget-row-label";
    label.textContent = widgetName;
    row.appendChild(label);
    for (const state of ZenLayoutPresetData.WIDGET_STATES) {
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "zen-ui-layout-widget-checkbox";
      checkbox.checked = !!widgets[state]?.includes(id);
      // The visible column header already says "Normal"/"Empty tab"/"Tor" -
      // a screen reader lands on the checkbox alone, so its name has to carry
      // the widget too or every row in the column reads identically.
      document.l10n.setAttributes(checkbox, `zen-ui-layout-widgets-state-${this.widgetStateId(state)}`, {
        widget: widgetName,
      });
      checkbox.addEventListener("change", () => this.setWidgetHidden(id, state, checkbox.checked));
      row.appendChild(checkbox);
    }
    return row;
  },

  setWidgetHidden(id, state, hidden) {
    const widgets = ZenLayoutPresetData.getLiveWidgets();
    const forState = new Set(widgets[state] ?? []);
    if (hidden) {
      forState.add(id);
    } else {
      forState.delete(id);
    }
    widgets[state] = [...forState];
    ZenLayoutPresetData.setLiveWidgets(widgets);
  },

  buildCard(name) {
    const configured = ZenLayoutPresetData.isConfigured(name);
    const card = document.createElement("div");
    card.className = "zen-preset-card";
    card.dataset.preset = name;
    card.draggable = configured;
    card.addEventListener("dragstart", this);
    card.addEventListener("keydown", this);

    const choice = document.createElement("button");
    choice.type = "button";
    choice.className = "zen-choice";
    if (configured) {
      // Dragging has no keyboard equivalent of its own affordance; this is
      // the only place that says Alt+Arrow reorders the card.
      choice.setAttribute("aria-keyshortcuts", "Alt+ArrowLeft Alt+ArrowRight");
    }
    choice.addEventListener("click", () => {
      if (configured) {
        Services.prefs.setStringPref(ZenLayoutPresetData.PRESET_PREF, name);
      } else {
        this.saveInto(name);
      }
    });

    const label = document.createElement("span");
    label.className = "zen-choice-label";
    const customName = ZenLayoutPresetData.nameOf(name);
    if (!configured) {
      choice.classList.add("zen-preset-empty");
      choice.appendChild(this.buildEmptyPreview());
      document.l10n.setAttributes(label, "zen-ui-layout-slot-save");
    } else {
      const config = ZenLayoutPresetData.configOf(name);
      choice.appendChild(this.buildPreview(config));
      if (customName) {
        label.textContent = customName;
      } else {
        document.l10n.setAttributes(label, this.labelIdFor(name));
      }
      const widgets = this.buildWidgetBadges(config.widgets);
      if (widgets) {
        choice.appendChild(widgets);
      }
    }
    choice.appendChild(label);
    card.appendChild(choice);

    if (configured && ZenLayoutPresetData.isCustomSlot(name)) {
      card.appendChild(this.buildActions(name));
    }
    return card;
  },

  labelIdFor(name) {
    return ZenLayoutPresetData.isCustomSlot(name)
      ? `zen-ui-layout-${name.replace("custom", "custom-")}`
      : `zen-ui-layout-${name}`;
  },

  buildActions(name) {
    const actions = document.createElement("div");
    actions.className = "zen-preset-actions";
    const add = (id, run) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "zen-button-ghost zen-preset-action";
      document.l10n.setAttributes(button, id);
      button.addEventListener("click", run);
      actions.appendChild(button);
    };
    add("zen-ui-layout-action-rename", event => this.startRename(event.target, name));
    add("zen-ui-layout-action-update", () => this.saveInto(name));
    add("zen-ui-layout-action-reset", () => {
      ZenLayoutPresetData.resetSlot(name);
      if (ZenLayoutPresetData.current === name) {
        Services.prefs.setStringPref(
          ZenLayoutPresetData.PRESET_PREF,
          ZenLayoutPresetData.cycle[0]
        );
      }
      this.render();
    });
    return actions;
  },

  // Saving is also how an empty slot gets filled, so it selects the slot
  // afterwards: the arrangement on screen is now that slot's, and further
  // edits belong to it.
  saveInto(slot) {
    ZenLayoutPresetData.saveToSlot(slot);
    Services.prefs.setStringPref(ZenLayoutPresetData.PRESET_PREF, slot);
    this.render();
  },

  startRename(button, name) {
    const card = button.closest(".zen-preset-card");
    const input = document.createElement("input");
    input.className = "zen-input zen-preset-name";
    input.value = card.querySelector(".zen-choice-label").textContent;
    document.l10n.setAttributes(input, "zen-ui-layout-name-input");
    // The observers below rebuild the list on any pref move; without this
    // the field would vanish from under the caret mid-rename.
    this._renaming = true;
    const finish = commit => {
      if (!this._renaming) {
        return;
      }
      this._renaming = false;
      if (commit) {
        ZenLayoutPresetData.setName(name, input.value);
      }
      this.render();
    };
    input.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        finish(true);
      } else if (event.key === "Escape") {
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
    card.replaceChildren(input);
    input.focus();
    input.select();
  },

  // A few boxes standing in for the window: the tab strip, the toolbar and
  // the page. Drawn from the preset's own values so a custom slot shows what
  // it holds rather than a generic placeholder.
  buildPreview(config) {
    const box = className => {
      const span = document.createElement("span");
      span.className = className;
      return span;
    };
    const preview = box("zen-ui-layout-preview");
    const body = box("zen-ui-layout-preview-body");
    let bare = true;

    if (config.verticalTabs === false) {
      body.classList.add("zen-ui-layout-preview-body-column");
      if (config.shyChrome) {
        // Shy pulls the chrome into the window border; the hairlines are CSS.
        body.classList.add("zen-ui-layout-preview-body-shy");
        bare = false;
      } else {
        if (!config.hideTabbar) {
          body.appendChild(box("zen-ui-layout-preview-tabstrip"));
          bare = false;
        }
        if (!config.hideToolbar) {
          body.appendChild(box("zen-ui-layout-preview-toolbar"));
          bare = false;
        }
      }
      body.appendChild(box("zen-ui-layout-preview-content"));
    } else {
      if (config.rightSide) {
        body.classList.add("zen-ui-layout-preview-body-reverse");
      }
      if (!config.hideTabbar) {
        const sidebar = box("zen-ui-layout-preview-sidebar");
        if (config.compactMode) {
          sidebar.classList.add("zen-ui-layout-preview-sidebar-thin");
        } else if (config.tabStyle === "compact") {
          sidebar.classList.add("zen-ui-layout-preview-sidebar-narrow");
        }
        body.appendChild(sidebar);
        bare = false;
      }
      const main = box("zen-ui-layout-preview-main");
      // Compact mode collapses the toolbar into the floating sidebar, so it
      // has none to draw even when nothing hid it.
      if (!config.hideToolbar && !config.compactMode) {
        main.appendChild(box("zen-ui-layout-preview-toolbar"));
        bare = false;
      }
      main.appendChild(box("zen-ui-layout-preview-content"));
      body.appendChild(main);
    }

    // Nothing but the page left: a dashed inset, or the card reads as broken
    // rather than empty on purpose.
    body.classList.toggle("zen-ui-layout-preview-bare", bare);
    preview.appendChild(body);
    return preview;
  },

  buildEmptyPreview() {
    const preview = document.createElement("span");
    preview.className = "zen-ui-layout-preview zen-ui-layout-preview-custom";
    const icon = document.createElement("img");
    icon.src = "chrome://browser/skin/zen-icons/plus.svg";
    icon.alt = "";
    preview.appendChild(icon);
    return preview;
  },

  // One badge per state the preset actually hides something in, so an
  // untouched preset (the common case) adds nothing under its preview.
  buildWidgetBadges(widgets) {
    if (!widgets) {
      return null;
    }
    const row = document.createElement("span");
    row.className = "zen-ui-layout-widget-badges";
    for (const state of ZenLayoutPresetData.WIDGET_STATES) {
      const ids = widgets[state];
      if (!ids?.length) {
        continue;
      }
      const badge = document.createElement("span");
      badge.className = "zen-ui-layout-widget-badge";
      document.l10n.setAttributes(badge, `zen-ui-layout-widgets-badge-${this.widgetStateId(state)}`, {
        count: ids.length,
      });
      badge.title = ids.map(id => this.widgetName(id)).join(", ");
      row.appendChild(badge);
    }
    return row.childElementCount ? row : null;
  },

  widgetStateId(state) {
    // camelCase state name -> the kebab-case an ftl id uses.
    return state.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
  },

  handleEvent(event) {
    switch (event.type) {
      case "dragstart":
        this._dragged = event.currentTarget;
        event.dataTransfer.effectAllowed = "move";
        // Firefox refuses to start a drag with an empty data transfer.
        event.dataTransfer.setData("text/plain", this._dragged.dataset.preset);
        this._dragged.classList.add("zen-preset-dragging");
        break;
      case "dragover": {
        const target = this.dropTarget(event);
        if (!target) {
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        this.markDrop(target.card, target.after);
        break;
      }
      case "drop": {
        const target = this.dropTarget(event);
        if (!target) {
          return;
        }
        event.preventDefault();
        this.moveTo(this._dragged.dataset.preset, target.card.dataset.preset, target.after);
        break;
      }
      case "dragend":
        this.clearDropMarks();
        this._dragged?.classList.remove("zen-preset-dragging");
        this._dragged = null;
        break;
      case "keydown":
        // Dragging is not reachable from the keyboard, so the same move is
        // on Alt+Arrow.
        if (!event.altKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) {
          return;
        }
        event.preventDefault();
        this.nudge(event.currentTarget.dataset.preset, event.key === "ArrowRight" ? 1 : -1);
        break;
    }
  },

  dropTarget(event) {
    const card = event.target.closest?.(".zen-preset-card");
    if (!card || !this._dragged || card === this._dragged) {
      return null;
    }
    const rect = card.getBoundingClientRect();
    return { card, after: event.clientX > rect.left + rect.width / 2 };
  },

  markDrop(card, after) {
    this.clearDropMarks();
    card.classList.add(after ? "zen-preset-drop-after" : "zen-preset-drop-before");
  },

  clearDropMarks() {
    for (const card of this.list.children) {
      card.classList.remove("zen-preset-drop-before", "zen-preset-drop-after");
    }
  },

  moveTo(name, targetName, after) {
    const order = ZenLayoutPresetData.order.filter(id => id !== name);
    const index = order.indexOf(targetName);
    order.splice(index < 0 ? order.length : index + (after ? 1 : 0), 0, name);
    ZenLayoutPresetData.order = order;
    this.render();
    this.list.querySelector(`[data-preset="${name}"] .zen-choice`)?.focus();
  },

  nudge(name, delta) {
    const shown = this.displayOrder.filter(id => ZenLayoutPresetData.isConfigured(id));
    const index = shown.indexOf(name);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= shown.length) {
      return;
    }
    this.moveTo(name, shown[target], delta > 0);
  },
};

const kZenExtendedSidebar = "zen.view.sidebar-expanded";
const kZenSingleToolbar = "zen.view.use-single-toolbar";

var gZenLooksAndFeel = {
  init() {
    if (this.__hasInitialized) {
      return;
    }
    this.__hasInitialized = true;
    gZenMarketplaceManager.init();
    for (const pref of [kZenExtendedSidebar, kZenSingleToolbar]) {
      Services.prefs.addObserver(pref, this);
    }
    window.addEventListener("unload", () => {
      for (const pref of [kZenExtendedSidebar, kZenSingleToolbar]) {
        Services.prefs.removeObserver(pref, this);
      }
    });
    this.applySidebarLayout();
    this.wireSidebarResults();
    gZenLayoutPresetsUI.init();
  },

  /* The path settings only do anything while results are grouped by site, and
     the count only while the paths themselves are shown. Left live they are
     controls that visibly accept a change and silently discard it. */
  syncSidebarResults() {
    const grouped = Services.prefs.getBoolPref(
      "zen.urlbar.sidebar.group-by-site",
      true
    );
    const paths =
      grouped && Services.prefs.getBoolPref("zen.urlbar.sidebar.show-paths", true);
    for (const [id, on] of [
      ["zenUrlbarSidebarPaths", grouped],
      ["zenUrlbarSidebarMaxPaths", paths],
    ]) {
      const el = document.getElementById(id);
      el?.toggleAttribute("disabled", !on);
      el?.closest(".zen-row")?.toggleAttribute("disabled", !on);
    }
  },

  /* Counts, unlike the checkboxes beside them, have no `preference` binding:
     they are written back only when the typed value is in range. */
  wireSidebarResults() {
    const counts = [
      ["zenUrlbarSidebarMaxRows", "zen.urlbar.sidebar.max-rows", 8, 1, 20],
      ["zenUrlbarSidebarMaxPaths", "zen.urlbar.sidebar.max-paths", 3, 0, 6],
    ];
    for (const [id, pref, fallback, min, max] of counts) {
      const input = document.getElementById(id);
      if (!input) {
        continue;
      }
      input.value = Services.prefs.getIntPref(pref, fallback);
      input.addEventListener("change", () => {
        const value = parseInt(input.value, 10);
        if (Number.isInteger(value) && value >= min && value <= max) {
          Services.prefs.setIntPref(pref, value);
        } else {
          input.value = Services.prefs.getIntPref(pref, fallback);
        }
      });
    }
    const deps = [
      "zen.urlbar.sidebar.group-by-site",
      "zen.urlbar.sidebar.show-paths",
    ];
    for (const pref of deps) {
      Services.prefs.addObserver(pref, this);
    }
    window.addEventListener("unload", () => {
      for (const pref of deps) {
        Services.prefs.removeObserver(pref, this);
      }
    });
    this.syncSidebarResults();
  },

  observe(_subject, _topic, data) {
    if (data?.startsWith("zen.urlbar.sidebar.")) {
      this.syncSidebarResults();
      return;
    }
    this.applySidebarLayout();
  },

  applySidebarLayout() {
    const isSingleToolbar = Services.prefs.getBoolPref(kZenSingleToolbar);
    const isExtendedSidebar = Services.prefs.getBoolPref(kZenExtendedSidebar);
    for (const layout of document.getElementById("zenLayoutList").children) {
      layout.classList.remove("selected");
      if (layout.getAttribute("layout") == "single" && isSingleToolbar) {
        layout.classList.add("selected");
      } else if (
        layout.getAttribute("layout") == "multiple" &&
        !isSingleToolbar &&
        isExtendedSidebar
      ) {
        layout.classList.add("selected");
      } else if (layout.getAttribute("layout") == "collapsed" && !isExtendedSidebar) {
        layout.classList.add("selected");
      }
    }
    if (this.__hasInitializedLayout) {
      return;
    }
    this.__hasInitializedLayout = true;
    for (const layout of document.getElementById("zenLayoutList").children) {
      layout.addEventListener("click", () => {
        if (layout.hasAttribute("disabled")) {
          return;
        }

        for (const el of document.getElementById("zenLayoutList").children) {
          el.classList.remove("selected");
        }

        layout.classList.add("selected");

        Services.prefs.setBoolPref(
          kZenExtendedSidebar,
          layout.getAttribute("layout") != "collapsed"
        );
        Services.prefs.setBoolPref(kZenSingleToolbar, layout.getAttribute("layout") == "single");
      });
    }
  },
};

var gZenWorkspacesSettings = {
  init() {
    var tabsUnloaderPrefListener = {
      async observe() {
        let buttonIndex = await confirmRestartPrompt(true, 1, true, true);
        if (buttonIndex == CONFIRM_RESTART_PROMPT_RESTART_NOW) {
          Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit | Ci.nsIAppStartup.eRestart);
        }
      },
    };

    let toggleZenCycleByAttrWarning = {
      observe() {
        const warning = document.getElementById("zenTabsCycleByAttributeWarning");
        warning.hidden = !(
          Services.prefs.getBoolPref("zen.tabs.ctrl-tab.ignore-essential-tabs", false) &&
          Services.prefs.getBoolPref("browser.ctrlTab.sortByRecentlyUsed", false)
        );
      },
    };

    toggleZenCycleByAttrWarning.observe(); // call it once on initial load

    Services.prefs.addObserver("zen.glance.enabled", tabsUnloaderPrefListener); // We can use the same listener for both prefs
    Services.prefs.addObserver("zen.workspaces.separate-essentials", tabsUnloaderPrefListener);
    Services.prefs.addObserver("zen.glance.activation-method", tabsUnloaderPrefListener);
    Services.prefs.addObserver("zen.window-sync.sync-only-pinned-tabs", tabsUnloaderPrefListener);
    Services.prefs.addObserver(
      "zen.tabs.ctrl-tab.ignore-essential-tabs",
      toggleZenCycleByAttrWarning
    );
    Services.prefs.addObserver("browser.ctrlTab.sortByRecentlyUsed", toggleZenCycleByAttrWarning);
    window.addEventListener("unload", () => {
      Services.prefs.removeObserver("zen.glance.enabled", tabsUnloaderPrefListener);
      Services.prefs.removeObserver("zen.glance.activation-method", tabsUnloaderPrefListener);
      Services.prefs.removeObserver("zen.workspaces.separate-essentials", tabsUnloaderPrefListener);
      Services.prefs.removeObserver(
        "zen.window-sync.sync-only-pinned-tabs",
        tabsUnloaderPrefListener
      );
      Services.prefs.removeObserver(
        "zen.tabs.ctrl-tab.ignore-essential-tabs",
        toggleZenCycleByAttrWarning
      );
      Services.prefs.removeObserver(
        "browser.ctrlTab.sortByRecentlyUsed",
        toggleZenCycleByAttrWarning
      );
    });
  },
};

const ZEN_CKS_CLASS_BASE = "zenCKSOption";
const ZEN_CKS_INPUT_FIELD_CLASS = `${ZEN_CKS_CLASS_BASE}-input`;
const ZEN_CKS_LABEL_CLASS = `${ZEN_CKS_CLASS_BASE}-label`;
const ZEN_CKS_WRAPPER_ID = `${ZEN_CKS_CLASS_BASE}-wrapper`;
const ZEN_CKS_GROUP_PREFIX = `${ZEN_CKS_CLASS_BASE}-group`;
const KEYBIND_ATTRIBUTE_KEY = "key";

const zenMissingKeyboardShortcutL10n = {
  key_quickRestart: "zen-key-quick-restart",
  key_delete: "zen-key-delete",
  goBackKb: "zen-key-go-back",
  goForwardKb: "zen-key-go-forward",
  key_enterFullScreen: "zen-key-enter-full-screen",
  key_exitFullScreen: "zen-key-exit-full-screen",
  key_aboutProcesses: "zen-key-about-processes",
  key_sanitize: "zen-key-sanitize",
  key_wrCaptureCmd: "zen-key-wr-capture-cmd",
  key_wrToggleCaptureSequenceCmd: "zen-key-wr-toggle-capture-sequence-cmd",
  key_undoCloseWindow: "zen-key-undo-close-window",

  "zen-glance-expand": "zen-glance-expand",

  key_selectTab1: "zen-key-select-tab-1",
  key_selectTab2: "zen-key-select-tab-2",
  key_selectTab3: "zen-key-select-tab-3",
  key_selectTab4: "zen-key-select-tab-4",
  key_selectTab5: "zen-key-select-tab-5",
  key_selectTab6: "zen-key-select-tab-6",
  key_selectTab7: "zen-key-select-tab-7",
  key_selectTab8: "zen-key-select-tab-8",
  key_selectLastTab: "zen-key-select-tab-last",
  key_duplicateTab: "customkeys-file-duplicate-tab",

  key_showAllTabs: "zen-key-show-all-tabs",
  key_gotoHistory: "zen-key-goto-history",

  goHome: "zen-key-go-home",
  key_redo: "zen-key-redo",

  key_inspectorMac: "zen-key-inspector-mac",
  key_findSelection: "zen-key-find-selection",
  key_findPrevious2: "zen-search-find-again-shortcut-prev-alt",

  // Devtools
  key_toggleToolbox: "zen-devtools-toggle-shortcut",
  key_browserToolbox: "zen-devtools-toggle-browser-toolbox-shortcut",
  key_browserConsole: "zen-devtools-toggle-browser-console-shortcut",
  key_responsiveDesignMode: "zen-devtools-toggle-responsive-design-mode-shortcut",
  key_inspector: "zen-devtools-toggle-inspector-shortcut",
  key_webconsole: "zen-devtools-toggle-web-console-shortcut",
  key_jsdebugger: "zen-devtools-toggle-js-debugger-shortcut",
  key_netmonitor: "zen-devtools-toggle-net-monitor-shortcut",
  key_styleeditor: "zen-devtools-toggle-style-editor-shortcut",
  key_performance: "zen-devtools-toggle-performance-shortcut",
  key_storage: "zen-devtools-toggle-storage-shortcut",
  key_dom: "zen-devtools-toggle-dom-shortcut",
  key_accessibility: "zen-devtools-toggle-accessibility-shortcut",
};

var zenIgnoreKeyboardShortcutIDs = [
  "key_enterFullScreen_old",
  "key_enterFullScreen_compat",
  "key_exitFullScreen_old",
  "key_exitFullScreen_compat",
  "key_duplicateTab",
  "key_addTabSplitView",
  "key_separateTabSplitView",
  "viewOpenTabsSidebarKb",
];

var zenIgnoreKeyboardShortcutL10n = [
  "zen-full-zoom-reduce-shortcut-alt-b",
  "zen-full-zoom-reduce-shortcut-alt-a",
];

var gZenCKSSettings = {
  async init() {
    await this._initializeCKS();
    if (this.__hasInitialized) {
      return;
    }
    this.__hasInitialized = true;
    this._currentActionID = null;
    this._initializeEvents();
    window.addEventListener("unload", () => {
      this.__hasInitialized = false;
      document.getElementById(ZEN_CKS_WRAPPER_ID).innerHTML = "";
    });
  },

  _initializeEvents() {
    const resetAllListener = this.resetAllShortcuts.bind(this);
    const handleKeyDown = this._handleKeyDown.bind(this);
    window.addEventListener("keydown", handleKeyDown);
    const button = document.getElementById("zenCKSResetButton");
    button.addEventListener("click", resetAllListener);
    window.addEventListener("unload", () => {
      window.removeEventListener("keydown", handleKeyDown);
      button.removeEventListener("click", resetAllListener);
    });
  },

  async resetAllShortcuts() {
    let buttonIndex = await confirmRestartPrompt(true, 1, true, false);
    if (buttonIndex == CONFIRM_RESTART_PROMPT_RESTART_NOW) {
      await gZenKeyboardShortcutsManager.resetAllShortcuts();
      Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit | Ci.nsIAppStartup.eRestart);
    }
  },

  async _initializeCKS() {
    let wrapper = document.getElementById(ZEN_CKS_WRAPPER_ID);
    wrapper.innerHTML = "";

    let shortcuts = await gZenKeyboardShortcutsManager.getModifiableShortcuts();

    if (!shortcuts) {
      throw Error("No shortcuts defined!");
    }

    // One section per group: heading, then a card the rows are appended to.
    for (let group of VALID_SHORTCUT_GROUPS) {
      let groupClass = `${ZEN_CKS_GROUP_PREFIX}-${group}`;
      if (!wrapper.querySelector(`[data-group="${groupClass}"]`)) {
        let section = document.createElement("div");
        section.className = "zen-section";
        let heading = document.createElement("h2");
        document.l10n.setAttributes(heading, groupClass);
        let card = document.createElement("div");
        card.className = "zen-card";
        card.setAttribute("data-group", groupClass);
        section.append(heading, card);
        wrapper.appendChild(section);
      }
    }

    for (let shortcut of shortcuts) {
      const keyID = shortcut.getID();
      const action = shortcut.getAction();
      const l10nID = shortcut.getL10NID();
      const group = shortcut.getGroup();
      const keyInString = shortcut.toDisplayString();

      const labelValue = zenMissingKeyboardShortcutL10n[keyID] ?? l10nID;

      if (
        zenIgnoreKeyboardShortcutIDs.includes(keyID) ||
        zenIgnoreKeyboardShortcutL10n.includes(labelValue) ||
        shortcut.shouldBeEmpty
      ) {
        continue;
      }

      let fragment = window.MozXULElement.parseXULToFragment(`
        <hbox class="${ZEN_CKS_CLASS_BASE}">
          <label class="${ZEN_CKS_LABEL_CLASS}" for="${ZEN_CKS_INPUT_FIELD_CLASS}-${keyID}"></label>
          <html:input readonly="1" class="${ZEN_CKS_INPUT_FIELD_CLASS}" id="${ZEN_CKS_INPUT_FIELD_CLASS}-${keyID}" />
        </hbox>
      `);

      const label = fragment.querySelector(`.${ZEN_CKS_LABEL_CLASS}`);
      if (!labelValue) {
        label.textContent = action; // Just in case
      } else {
        document.l10n.setAttributes(label, labelValue);
      }

      let input = fragment.querySelector(`.${ZEN_CKS_INPUT_FIELD_CLASS}`);
      if (keyInString && !shortcut.isEmpty()) {
        input.value = keyInString;
      } else {
        this._resetShortcut(input);
      }

      input.setAttribute(KEYBIND_ATTRIBUTE_KEY, keyID);
      input.setAttribute("data-group", group);
      input.setAttribute("data-id", keyID);

      input.addEventListener("focus", (event) => {
        this._currentActionID = event.target.getAttribute("data-id");
        event.target.classList.add(`${ZEN_CKS_INPUT_FIELD_CLASS}-editing`);
        this._hasSafed = true;
      });

      input.addEventListener("editDone", (event) => {
        const target = event.target;
        target.classList.add(`${ZEN_CKS_INPUT_FIELD_CLASS}-editing`);
      });

      input.addEventListener("blur", (event) => {
        this._currentActionID = null;
        const target = event.target;
        target.classList.remove(`${ZEN_CKS_INPUT_FIELD_CLASS}-editing`);
        if (!this._hasSafed) {
          target.classList.add(`${ZEN_CKS_INPUT_FIELD_CLASS}-unsafed`);
          if (!target.nextElementSibling) {
            target.after(
              window.MozXULElement.parseXULToFragment(`
              <label class="${ZEN_CKS_CLASS_BASE}-unsafed" data-l10n-id="zen-key-unsaved"></label>
            `)
            );
            target.value = "Not set";
          }
        } else {
          target.classList.remove(`${ZEN_CKS_INPUT_FIELD_CLASS}-unsafed`);
          const sibling = target.nextElementSibling;
          if (sibling && sibling.classList.contains(`${ZEN_CKS_CLASS_BASE}-unsafed`)) {
            sibling.remove();
          }
        }
        if (target.classList.contains(`${ZEN_CKS_INPUT_FIELD_CLASS}-not-set`)) {
          target.label = "Not set";
        }
      });

      // Prepended, because getModifiableShortcuts() hands them back in
      // descending order and the pane has always read the other way.
      wrapper.querySelector(`[data-group="${ZEN_CKS_GROUP_PREFIX}-${group}"]`).prepend(fragment);
    }
  },

  async _resetShortcut(input) {
    input.value = "Not set";
    input.classList.remove(`${ZEN_CKS_INPUT_FIELD_CLASS}-invalid`);
    input.classList.remove(`${ZEN_CKS_INPUT_FIELD_CLASS}-editing`);
    input.classList.add(`${ZEN_CKS_INPUT_FIELD_CLASS}-not-set`);

    if (this._currentActionID) {
      this._editDone();
      await gZenKeyboardShortcutsManager.setShortcut(this._currentActionID, null, null);
    }
  },

  _editDone(shortcut, modifiers) {
    // Check if we have a valid key
    if (!shortcut || !modifiers) {
      return;
    }
    gZenKeyboardShortcutsManager.setShortcut(this._currentActionID, shortcut, modifiers);
    this._currentActionID = null;
  },

  //TODO Check for duplicates
  async _handleKeyDown(event) {
    if (!this._currentActionID || document.hidden) {
      return;
    }

    event.preventDefault();

    let input = document.querySelector(
      `.${ZEN_CKS_INPUT_FIELD_CLASS}[${KEYBIND_ATTRIBUTE_KEY}="${this._currentActionID}"]`
    );
    const modifiers = new nsKeyShortcutModifiers(
      event.ctrlKey,
      event.altKey,
      event.shiftKey,
      event.metaKey,
      false
    );
    const modifiersActive = modifiers.areAnyActive();

    input.classList.remove(`${ZEN_CKS_INPUT_FIELD_CLASS}-not-set`);

    // First, try to read the *physical* key via event.code.
    // If event.code is like "KeyS", "KeyA", ..., strip off "Key" → "S".
    // Otherwise, fall back to event.key (e.g. "F5", "Enter", etc.).
    let shortcut;
    if (event.code && event.code.startsWith("Key")) {
      shortcut = event.code.slice(3);
    } else if (event.code && event.code.startsWith("Digit")) {
      shortcut = event.code.slice(5);
    } else {
      // Use physical key mapping for common symbols
      const CODE_TO_KEY_MAP = {
        Comma: ",",
        Period: ".",
        Slash: "/",
        Semicolon: ";",
        Quote: "'",
        BracketLeft: "[",
        BracketRight: "]",
        Backslash: "\\",
        Backquote: "`",
        Minus: "-",
        Equal: "=",
      };
      shortcut = CODE_TO_KEY_MAP[event.code] || event.key;
    }

    shortcut = shortcut.replace(/Ctrl|Control|Shift|Alt|Option|Cmd|Meta/, ""); // Remove all modifiers

    if (shortcut == "Tab" && !modifiersActive) {
      input.classList.remove(`${ZEN_CKS_INPUT_FIELD_CLASS}-not-set`);
      input.classList.remove(`${ZEN_CKS_INPUT_FIELD_CLASS}-editing`);
      this._latestValidKey = null;
      this._currentActionID = null;
      return;
    } else if (shortcut == "Escape" && !modifiersActive) {
      const { hasConflicts, conflictShortcut } = gZenKeyboardShortcutsManager.checkForConflicts(
        this._latestValidKey ? this._latestValidKey : shortcut,
        this._latestModifier ? this._latestModifier : modifiers,
        this._currentActionID
      );

      if (!this._latestValidKey && !this._latestModifier) {
        // todo(lint): This is a bit weird, we need to remove this empty block
      } else if (!this._latestValidKey || hasConflicts) {
        if (!input.classList.contains(`${ZEN_CKS_INPUT_FIELD_CLASS}-invalid`)) {
          input.classList.add(`${ZEN_CKS_INPUT_FIELD_CLASS}-invalid`);
        }
        input.classList.remove(`${ZEN_CKS_INPUT_FIELD_CLASS}-unsafed`);

        if (hasConflicts) {
          const shortcutL10nKey =
            zenMissingKeyboardShortcutL10n[conflictShortcut.getID()] ??
            conflictShortcut.getL10NID();

          const [group, conflictName] = await document.l10n.formatValues([
            { id: `${ZEN_CKS_GROUP_PREFIX}-${conflictShortcut.getGroup()}` },
            { id: shortcutL10nKey },
          ]);

          if (!input.nextElementSibling) {
            input.after(
              window.MozXULElement.parseXULToFragment(`
                <label class="${ZEN_CKS_CLASS_BASE}-conflict" data-l10n-id="zen-key-conflict"></label>
              `)
            );
          }

          document.l10n.setAttributes(input.nextElementSibling, "zen-key-conflict", {
            group: group ?? "",
            shortcut: conflictName ?? shortcut ?? "",
          });
        }
      } else {
        input.classList.remove(`${ZEN_CKS_INPUT_FIELD_CLASS}-editing`);

        this._editDone(this._latestValidKey, this._latestModifier);
        if (this.name == "Not set") {
          input.classList.add(`${ZEN_CKS_INPUT_FIELD_CLASS}-not-set`);
        }
        this._latestValidKey = null;
        this._latestModifier = null;
        input.classList.remove(`${ZEN_CKS_INPUT_FIELD_CLASS}-invalid`);
        input.classList.add(`${ZEN_CKS_INPUT_FIELD_CLASS}-valid`);
        setTimeout(() => {
          input.classList.remove(`${ZEN_CKS_INPUT_FIELD_CLASS}-valid`);
        }, 1000);
        const sibling = input.nextElementSibling;
        if (sibling && sibling.classList.contains(`${ZEN_CKS_CLASS_BASE}-conflict`)) {
          sibling.remove();
        }
      }
      this._hasSafed = true;
      input.blur();
      this._currentActionID = null;
      return;
    } else if (shortcut == "Backspace" && !modifiersActive) {
      this._resetShortcut(input);
      this._latestValidKey = null;
      this._latestModifier = null;
      this._hasSafed = true;
      const sibling = input.nextElementSibling;
      if (sibling && sibling.classList.contains(`${ZEN_CKS_CLASS_BASE}-conflict`)) {
        sibling.remove();
      }
      return;
    }

    this._latestModifier = modifiers;
    this._hasSafed = false;
    input.classList.remove(`${ZEN_CKS_INPUT_FIELD_CLASS}-invalid`);
    input.classList.remove(`${ZEN_CKS_INPUT_FIELD_CLASS}-not-set`);
    input.value = modifiers.toDisplayString() + gZenKeyboardShortcutsManager.getKeyDisplay(shortcut);
    this._latestValidKey = shortcut;
  },
};

// Firefox registers some of these itself, and Preferences.addAll throws on the
// first duplicate - taking every entry after it with it. Filtered, not trusted.
Preferences.addAll(
  [

  {
    id: "zen.theme.style",
    type: "string",
    default: "default",
  },
  {
    id: "zen.theme.palette",
    type: "string",
    default: "desktop",
  },
  {
    id: "zen.theme.accent",
    type: "string",
    default: "#478fff",
  },
  {
    id: "zen.theme.scheme",
    type: "string",
    default: "dark",
  },
  {
    id: "zen.tabs.focus.strength",
    type: "string",
    default: "full",
  },
  {
    id: "zen.tabs.look.selected",
    type: "string",
    default: "mark",
  },
  {
    id: "zen.tabs.look.close",
    type: "string",
    default: "hover",
  },
  {
    id: "zen.tabs.look.radius",
    type: "int",
    default: -1,
  },
  {
    id: "zen.tabs.look.height",
    type: "int",
    default: -1,
  },
  {
    id: "zen.tabs.look.folder-gap",
    type: "int",
    default: 6,
  },
  {
    id: "zen.mediacontrols.show-on-own-tab",
    type: "bool",
    default: false,
  },
  {
    id: "zen.tabs.look.color",
    type: "string",
    default: "selected",
  },
  {
    id: "zen.tabs.look.hover-shade",
    type: "bool",
    default: true,
  },
  {
    id: "zen.tabs.focus.selected.enabled",
    type: "bool",
    default: true,
  },
  {
    id: "zen.tabs.focus.hover.enabled",
    type: "bool",
    default: false,
  },
  {
    id: "zen.tabs.focus.loading.enabled",
    type: "bool",
    default: false,
  },
  {
    id: "zen.tabs.focus.audio.enabled",
    type: "bool",
    default: false,
  },
  {
    id: "zen.clipboard.toast",
    type: "bool",
    default: true,
  },
  {
    id: "zen.pictureinpicture.remember-per-site",
    type: "bool",
    default: true,
  },
  { id: "zen.media.external.player", type: "string", default: "reel" },
  { id: "zen.media.external.command", type: "string", default: "" },
  { id: "zen.media.external.pause-in-browser", type: "bool", default: true },
  { id: "zen.media.external.send-cookies", type: "bool", default: true },
  { id: "zen.media.external.context-menu", type: "bool", default: true },
  { id: "zen.media.external.sites", type: "string", default: "{}" },
  {
    id: "zen.tor.enabled",
    type: "bool",
    default: false,
  },
  {
    id: "zen.tor.log",
    type: "bool",
    default: false,
  },
  {
    id: "zen.tor.harden",
    type: "bool",
    default: false,
  },
  {
    id: "zen.tor.bridges.enabled",
    type: "bool",
    default: false,
  },
  {
    id: "zen.sidebar.remember-per-site",
    type: "bool",
    default: false,
  },
  {
    id: "media.videocontrols.picture-in-picture.video-toggle.position",
    type: "string",
    default: "right",
  },
  {
    id: "media.videocontrols.picture-in-picture.video-toggle.min-video-secs",
    type: "int",
    default: 45,
  },
  {
    id: "media.videocontrols.picture-in-picture.display-text-tracks.enabled",
    type: "bool",
    default: true,
  },
  {
    id: "media.videocontrols.picture-in-picture.enable-when-switching-tabs.enabled",
    type: "bool",
    default: false,
  },
  {
    id: "zen.view.compact.toolbar-flash-popup",
    type: "bool",
    default: true,
  },
  {
    id: "zen.workspaces.hide-default-container-indicator",
    type: "bool",
    default: true,
  },
  {
    id: "zen.tab-unloader.timeout-minutes",
    type: "int",
    default: 10,
  },
  {
    id: "zen.pinned-tab-manager.restore-pinned-tabs-to-pinned-url",
    type: "bool",
    default: true,
  },
  {
    id: "zen.pinned-tab-manager.close-shortcut-behavior",
    type: "string",
    default: "switch",
  },
  {
    id: "zen.workspaces.force-container-workspace",
    type: "bool",
    default: true,
  },
  {
    id: "zen.workspaces.open-new-tab-if-last-unpinned-tab-is-closed",
    type: "bool",
    default: true,
  },
  {
    id: "zen.glance.activation-method",
    type: "string",
    default: "ctrl",
  },
  {
    id: "zen.glance.enabled",
    type: "bool",
    default: true,
  },
  {
    id: "zen.view.drag-window-from-content",
    type: "bool",
    default: true,
  },
  {
    id: "zen.urlbar.behavior",
    type: "string",
    default: "float",
  },
  {
    id: "zen.urlbar.sidebar.group-by-site",
    type: "bool",
    default: true,
  },
  {
    id: "zen.urlbar.sidebar.show-paths",
    type: "bool",
    default: true,
  },
  {
    id: "zen.urlbar.sidebar.show-url",
    type: "bool",
    default: true,
  },
  {
    id: "zen.urlbar.sidebar.show-source",
    type: "bool",
    default: true,
  },
  {
    id: "zen.urlbar.sidebar.density",
    type: "string",
    default: "comfortable",
  },
  {
    id: "zen.workspaces.separate-essentials",
    type: "bool",
    default: false,
  },
  {
    id: "zen.tabs.show-newtab-vertical",
    type: "bool",
    default: true,
  },
  {
    id: "zen.view.show-newtab-button-top",
    type: "bool",
    default: true,
  },
  {
    id: "media.videocontrols.picture-in-picture.enabled",
    type: "bool",
    default: true,
  },
  {
    id: "zen.translations.remember-sites",
    type: "bool",
    default: true,
  },
  {
    id: "zen.spaces.desktop.enabled",
    type: "bool",
    default: false,
  },
  {
    id: "zen.workspaces.continue-where-left-off",
    type: "bool",
    default: true,
  },
  {
    id: "zen.newtab.after-away-hours",
    type: "int",
    default: 4,
  },
  {
    id: "zen.mods.auto-update",
    type: "bool",
    default: true,
  },
  {
    id: "zen.tabs.ctrl-tab.ignore-essential-tabs",
    type: "bool",
    default: false,
  },
  {
    id: "zen.tabs.ctrl-tab.ignore-pending-tabs",
    type: "bool",
    default: false,
  },
  {
    id: "zen.tabs.close-on-back-with-no-history",
    type: "bool",
    default: false,
  },
  {
    id: "zen.tabs.select-recently-used-on-close",
    type: "bool",
    default: true,
  },
  {
    id: "zen.window-sync.sync-only-pinned-tabs",
    type: "bool",
    default: false,
  },
  {
    id: "zen.privacy.site-data.clear-caches",
    type: "bool",
    default: true,
  },
  {
    id: "zen.agent.enabled",
    type: "bool",
    default: false,
  },
  {
    id: "zen.agent.isolate-tabs",
    type: "bool",
    default: true,
  },
  {
    id: "zen.agent.allow-guarded-origins",
    type: "bool",
    default: false,
  },
  {
    id: "privacy.clearOnShutdown_v2.cookiesAndStorage",
    type: "bool",
    default: true,
  },
  {
    id: "privacy.clearOnShutdown_v2.cache",
    type: "bool",
    default: true,
  },
  {
    id: "privacy.clearOnShutdown_v2.siteSettings",
    type: "bool",
    default: false,
  },
  ].filter(pref => !Preferences.get(pref.id))
);

Preferences.addSetting({
  id: "zenWorkspaceContinueWhereLeftOff",
  pref: "zen.workspaces.continue-where-left-off",
});

Preferences.addSetting({
  id: "zenNewTabAfterAway",
  pref: "zen.newtab.after-away-hours",
  deps: ["zenWorkspaceContinueWhereLeftOff"],
  disabled: deps => !deps.zenWorkspaceContinueWhereLeftOff.value,
});



/* Tab focus settings. Mirrors the tab context menu, on the same prefs, so
   whichever surface someone reaches for shows the same state. Every piece is
   built from the same primitives as the static panes (.zen-card, .zen-row,
   .zen-field), so nothing here is styled by hand. */
{
  const ZTF_PREF = "zen.tabs.focus.";
  // "custom" is what any of the sliders or swatches below leaves the preset
  // on, so it earns a segment of its own - otherwise nothing looks selected.
  const ZTF_PRESETS = ["siren", "beacon", "scanner", "pulse", "aurora", "flat", "custom"];
  const ZTF_SWATCHES = [
    "#ff3b3b", "#ff8a3c", "#ffd23c", "#5fcf6a", "#3fd48a", "#3fc4d4",
    "#3b6bff", "#8a4ae0", "#d05ac0", "#a9b4d1", "#e2e2e2", "#6b6b78",
  ];
  const ZTF_SLIDERS = [
    ["speed", 600, 12000, 100, "ms"],
    ["blur", 0, 40, 1, "px"],
    ["size", 30, 100, 1, "%"],
    ["intensity", 0, 100, 1, "%"],
  ];

  const ztfGetStr = (k, d) => Services.prefs.getStringPref(ZTF_PREF + k, d);
  const ztfGetInt = (k, d) => Services.prefs.getIntPref(ZTF_PREF + k, d);
  const ztfGetBool = (k) => Services.prefs.getBoolPref(ZTF_PREF + k, false);

  const ztfEl = (tag, className, l10nId) => {
    const el = document.createElement(tag);
    if (className) {
      el.className = className;
    }
    if (l10nId) {
      document.l10n.setAttributes(el, l10nId);
    }
    return el;
  };

  // A labelled block inside the editor card.
  const ztfField = (parent, l10nId) => {
    const field = ztfEl("div", "zen-field");
    field.append(ztfEl("span", "zen-field-label", l10nId));
    parent.append(field);
    return field;
  };

  function ztfBuild() {
    const host = document.getElementById("zenTabFocusSettings");
    if (!host) {
      return;
    }
    host.textContent = "";
    host.className = "zen-card";

    const editor = ztfEl("div", "zen-editor");
    host.append(editor);

    // Preset: a segmented control, so the six options read as one choice.
    const presets = ztfField(editor, "zen-tab-focus-animation-label");
    const segmented = ztfEl("div", "zen-segmented");
    segmented.setAttribute("role", "group");
    const presetButtons = new Map();
    for (const id of ZTF_PRESETS) {
      const segment = ztfEl("button", "zen-segment", `zen-tab-focus-preset-${id}`);
      segment.type = "button";
      segment.addEventListener("click", () => {
        Services.prefs.setStringPref(ZTF_PREF + "preset", id);
        syncPresets();
      });
      presetButtons.set(id, segment);
      segmented.append(segment);
    }
    presets.append(segmented);

    const syncPresets = () => {
      const current = ztfGetStr("preset", "siren");
      for (const [id, button] of presetButtons) {
        button.setAttribute("aria-pressed", String(id === current));
      }
    };
    syncPresets();

    for (const which of ["a", "b"]) {
      const field = ztfField(editor, `zen-tab-focus-color-${which}-label`);
      const grid = ztfEl("div", "zen-swatches");
      const swatches = new Map();
      const syncSwatches = () => {
        const current = ztfGetStr("color-" + which, "#a9b4d1").toLowerCase();
        for (const [color, button] of swatches) {
          button.setAttribute("aria-pressed", String(color === current));
        }
      };
      for (const color of ZTF_SWATCHES) {
        const swatch = ztfEl("button", "zen-swatch");
        swatch.type = "button";
        swatch.style.backgroundColor = color;
        swatch.title = color;
        swatch.addEventListener("click", () => {
          Services.prefs.setStringPref(ZTF_PREF + "color-" + which, color);
          Services.prefs.setStringPref(ZTF_PREF + "preset", "custom");
          syncSwatches();
          syncPresets();
        });
        swatches.set(color.toLowerCase(), swatch);
        grid.append(swatch);
      }
      syncSwatches();
      field.append(grid);
    }

    // Sliders share a grid, so the labels, tracks and read-outs line up.
    for (const [key, min, max, step, unit] of ZTF_SLIDERS) {
      const row = ztfEl("div", "zen-slider-row");
      row.append(ztfEl("span", "zen-field-label", `zen-tab-focus-slider-${key}`));

      const input = document.createElement("input");
      input.type = "range";
      input.min = min;
      input.max = max;
      input.step = step;
      input.value = ztfGetInt(key, min);

      const value = ztfEl("span", "zen-slider-value");
      value.textContent = input.value + unit;
      input.addEventListener("input", () => {
        Services.prefs.setIntPref(ZTF_PREF + key, Number(input.value));
        Services.prefs.setStringPref(ZTF_PREF + "preset", "custom");
        value.textContent = input.value + unit;
        syncPresets();
      });

      row.append(input, value);
      editor.append(row);
    }

    for (const key of ["hover", "reverse"]) {
      const row = ztfEl("label", "zen-check-row");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = ztfGetBool(key);
      box.addEventListener("change", () =>
        Services.prefs.setBoolPref(ZTF_PREF + key, box.checked)
      );
      row.append(box, ztfEl("span", null, `zen-tab-focus-${key}`));
      editor.append(row);
    }

    ztfBuildJsonEditor(host);
  }

  /* The colour data behind the per-site table, as an escape hatch. Collapsed
     by default: the table above is the way in, this is for pasting a set of
     colours in or out. A textarea over a highlighted <pre>, which is as close
     to a real editor as this gets without a library - chrome pages sanitise
     innerHTML, so every token is built as a DOM node. */
  function ztfBuildJsonEditor(host) {
    const details = ztfEl("details", "zen-disclosure");
    const summary = ztfEl("summary", null, "zen-tab-focus-json-summary");
    const body = ztfEl("div", "zen-disclosure-body");
    details.append(summary, body);
    host.append(details);

    const shell = ztfEl("div", "zen-code");
    const gutter = ztfEl("div", "zen-code-gutter");
    const stack = ztfEl("div", "zen-code-stack");
    const highlight = document.createElement("pre");
    highlight.className = "zen-code-highlight";
    const input = document.createElement("textarea");
    input.className = "zen-code-input";
    input.spellcheck = false;
    stack.append(highlight, input);
    shell.append(gutter, stack);

    const status = ztfEl("div", "zen-code-status");
    const actions = ztfEl("div", "zen-code-actions");
    const button = (l10nId, primary) => {
      const b = ztfEl("button", primary ? "zen-button" : "zen-button-ghost", l10nId);
      b.type = "button";
      actions.append(b);
      return b;
    };
    const save = button("zen-tab-focus-json-save", true);
    const format = button("zen-tab-focus-json-format");
    const revert = button("zen-tab-focus-json-revert");

    body.append(shell, status, actions);

    const TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}\[\],:])/g;
    const COLOR = /^"(#[0-9a-fA-F]{3,8}|(?:rgb|hsl)a?\([^"]*\))"$/;

    const paint = () => {
      const src = input.value;
      highlight.textContent = "";
      const push = (text, color) => {
        if (!text) {
          return;
        }
        const span = document.createElement("span");
        span.textContent = text;
        if (color) {
          span.style.color = color;
        }
        highlight.append(span);
      };

      let last = 0;
      let m;
      TOKEN.lastIndex = 0;
      while ((m = TOKEN.exec(src))) {
        push(src.slice(last, m.index));
        const [all, str, colon, lit, num, punc] = m;
        if (str && colon) {
          push(str, "var(--zen-code-key)");
          push(colon, "var(--zen-code-punct)");
        } else if (str) {
          // A colour literal is drawn in the colour it names.
          const c = COLOR.exec(str);
          push(str, c ? c[1] : "var(--zen-code-string)");
        } else if (lit || num) {
          push(lit || num, "var(--zen-code-number)");
        } else {
          push(punc, "var(--zen-code-punct)");
        }
        last = m.index + all.length;
      }
      push(src.slice(last));

      const count = src.split("\n").length;
      let nums = "";
      for (let i = 1; i <= count; i++) {
        nums += i + "\n";
      }
      gutter.textContent = nums;

      try {
        JSON.parse(src || "{}");
        document.l10n.setAttributes(status, "zen-tab-focus-json-valid");
        status.removeAttribute("data-state");
        save.disabled = false;
        format.disabled = false;
      } catch (e) {
        const at = /position (\d+)/.exec(e.message);
        const line = at ? src.slice(0, Number(at[1])).split("\n").length : 0;
        document.l10n.setAttributes(status, "zen-tab-focus-json-invalid", {
          message: (line ? "Line " + line + " - " : "") + e.message,
        });
        status.setAttribute("data-state", "error");
        save.disabled = true;
        format.disabled = true;
      }
    };

    const load = () => {
      let raw = "{}";
      try {
        raw = Services.prefs.getStringPref(ZTF_PREF + "site-colors", "{}");
      } catch (e) {}
      try {
        raw = JSON.stringify(JSON.parse(raw), null, 2);
      } catch (e) {}
      input.value = raw;
      paint();
    };

    input.addEventListener("input", paint);
    input.addEventListener("scroll", () => {
      highlight.scrollTop = input.scrollTop;
      highlight.scrollLeft = input.scrollLeft;
      gutter.scrollTop = input.scrollTop;
    });
    // Tab indents instead of leaving the field.
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Tab") {
        return;
      }
      e.preventDefault();
      const { selectionStart: a, selectionEnd: b, value } = input;
      input.value = value.slice(0, a) + "  " + value.slice(b);
      input.selectionStart = input.selectionEnd = a + 2;
      paint();
    });

    format.addEventListener("click", () => {
      try {
        input.value = JSON.stringify(JSON.parse(input.value || "{}"), null, 2);
        paint();
      } catch (e) {}
    });
    revert.addEventListener("click", load);
    save.addEventListener("click", () => {
      try {
        const parsed = JSON.parse(input.value || "{}");
        Services.prefs.setStringPref(ZTF_PREF + "site-colors", JSON.stringify(parsed));
      } catch (e) {}
    });

    load();
  }

  /* The Look & Feel pane is injected lazily: at DOMContentLoaded this script
     ran with the container not yet in the document, so it built into nothing.
     Wait for the element itself rather than for a document event. */
  function ztfEnsure() {
    if (!document.getElementById("zenTabFocusSettings")) {
      return false;
    }
    ztfBuild();
    return true;
  }

  if (!ztfEnsure()) {
    const ztfWatcher = new MutationObserver(() => {
      if (ztfEnsure()) {
        ztfWatcher.disconnect();
      }
    });
    ztfWatcher.observe(document.documentElement, { childList: true, subtree: true });
  }
}

/* Per-site settings editor.
 *
 * Everything Zen remembers per site lives in JSON prefs keyed by host. Editing
 * them meant about:config and hand-written JSON, so this renders one row per
 * site: the width the sidebar takes there, and the colour the tab effect uses.
 * Writing a row writes the pref, which is the same thing the browser reads. */
{
  const WIDTH_PREF = "zen.sidebar.site-widths";
  const COLOR_PREF = "zen.tabs.focus.site-colors";
  const ICON_PREF = "zen.sidebar.site-icons";
  const MIN_WIDTH = 140;
  const MAX_WIDTH = 700;

  /* Icon overrides go through the browser window's own gZenSiteIcons, so the
     pref only ever sees a source that module already accepted - this page does
     not get its own second opinion on what a safe image is. */
  const siteIcons = () => nsZenMultiWindowFeature.currentBrowser?.gZenSiteIcons;

  /* Anything but an object is no map at all - a pref holding a bare JSON
     string parses fine and then lists its own characters as sites. */
  const readMap = pref => {
    let map;
    try {
      map = JSON.parse(Services.prefs.getStringPref(pref, "{}"));
    } catch {
      map = null;
    }
    return map && typeof map === "object" && !Array.isArray(map) ? map : {};
  };
  const writeMap = (pref, map) =>
    Services.prefs.setStringPref(pref, JSON.stringify(map));

  // A host typed by hand may arrive as a full URL, or with a scheme, or with
  // the www. that the browser strips before it ever looks a site up.
  const normaliseHost = raw => {
    let value = (raw || "").trim().toLowerCase();
    if (!value) {
      return "";
    }
    try {
      if (value.includes("/") || value.includes(":")) {
        value = new URL(value.includes("://") ? value : `https://${value}`).host;
      }
    } catch {
      return "";
    }
    value = value.replace(/^www\./, "");
    return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(value) ? value : "";
  };

  const colourOf = entry =>
    typeof entry === "string" ? entry : entry?.a || entry?.["color-a"] || "";

  function zsBuild() {
    const list = document.getElementById("zenSitesList");
    if (!list) {
      return;
    }
    const widths = readMap(WIDTH_PREF);
    const colors = readMap(COLOR_PREF);
    const icons = readMap(ICON_PREF);
    const hosts = [
      ...new Set([...Object.keys(widths), ...Object.keys(colors), ...Object.keys(icons)]),
    ].sort();

    list.textContent = "";
    const empty = document.getElementById("zenSitesEmpty");
    if (empty) {
      empty.hidden = hosts.length > 0;
    }
    // The header only earns its row once there is something under it.
    const head = list.parentElement?.querySelector(".zen-table-head");
    if (head) {
      head.hidden = !hosts.length;
    }

    for (const host of hosts) {
      const row = document.createElement("div");
      row.className = "zen-sites-row";

      const name = document.createElement("span");
      name.className = "zen-sites-host";
      name.textContent = host;
      name.title = host;

      const width = document.createElement("input");
      width.type = "number";
      width.className = "zen-sites-width";
      width.min = MIN_WIDTH;
      width.max = MAX_WIDTH;
      width.step = 10;
      width.value = widths[host] ?? "";
      document.l10n.setAttributes(width, "zen-sites-width-input", { host });
      width.addEventListener("change", () => {
        const map = readMap(WIDTH_PREF);
        const px = parseInt(width.value, 10);
        if (Number.isFinite(px) && px >= MIN_WIDTH && px <= MAX_WIDTH) {
          map[host] = px;
        } else {
          delete map[host];
          width.value = "";
        }
        writeMap(WIDTH_PREF, map);
      });

      const colour = document.createElement("input");
      colour.type = "color";
      colour.className = "zen-sites-color";
      const set = colourOf(colors[host]);
      // An unset colour must not look like a chosen one: same control, dimmed,
      // and it stops being dimmed the moment it is actually set.
      colour.toggleAttribute("unset", !set);
      colour.value = set || "#3b6bff";
      document.l10n.setAttributes(colour, "zen-sites-colour-input", { host });
      colour.addEventListener("change", () => {
        colour.removeAttribute("unset");
        const map = readMap(COLOR_PREF);
        // Kept in whatever shape the entry already had, so a per-site pair of
        // colours is not flattened to one by touching the swatch.
        const current = map[host];
        map[host] =
          current && typeof current === "object"
            ? { ...current, a: colour.value }
            : colour.value;
        writeMap(COLOR_PREF, map);
      });

      row.append(name, width, colour, zsIconCell(host, icons[host] || ""));

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "zen-button-ghost zen-sites-remove";
      // An HTML button renders the entry's value and takes .title; .label is
      // XUL-only and would leave this button empty.
      document.l10n.setAttributes(remove, "zen-sites-remove");
      remove.addEventListener("click", () => {
        const w = readMap(WIDTH_PREF);
        const c = readMap(COLOR_PREF);
        delete w[host];
        delete c[host];
        writeMap(WIDTH_PREF, w);
        writeMap(COLOR_PREF, c);
        siteIcons()?.setOverride(host, "");
        zsBuild();
      });

      row.append(remove);
      list.append(row);
    }
  }

  /* One cell: what the mark looks like now, the source behind it, a picker
     and a clear. The source is the pref's own text, so what is typed here is
     what about:config shows. */
  function zsIconCell(host, source) {
    const cell = document.createElement("div");
    cell.className = "zen-sites-icon";

    const preview = document.createElement("img");
    preview.className = "zen-sites-icon-preview";
    // A file that is gone reads as no override, never as a broken image.
    preview.addEventListener("error", () => {
      preview.removeAttribute("src");
      preview.toggleAttribute("unset", true);
    });

    const input = document.createElement("input");
    input.type = "text";
    input.className = "zen-input zen-sites-icon-input";
    document.l10n.setAttributes(input, "zen-sites-icon-input");
    input.value = source;

    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "zen-icon-button zen-sites-icon-pick";
    document.l10n.setAttributes(pick, "zen-sites-icon-pick");

    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "zen-icon-button zen-sites-icon-clear";
    document.l10n.setAttributes(clear, "zen-sites-icon-clear");

    /* about:preferences serves its own CSP, and file: is not in its img-src -
       so a local icon is shown from a blob of the same bytes instead. The
       browser window has no such restriction and draws the file directly. */
    let blob = "";
    const refresh = async () => {
      const source = siteIcons()?.sourceToURL(input.value) || "";
      const url = source.startsWith("file://") ? await zsBlobURL(source) : source;
      if (blob && blob !== url) {
        URL.revokeObjectURL(blob);
      }
      blob = url === source ? "" : url;
      preview.toggleAttribute("unset", !url);
      if (url) {
        preview.src = url;
      } else {
        preview.removeAttribute("src");
      }
      clear.hidden = !input.value.trim();
    };

    // setOverride is the only writer, and it answers false when it will not
    // take a source - which has to show, or a rejected paste looks accepted.
    const commit = () => {
      const api = siteIcons();
      const accepted = !!api && api.setOverride(host, input.value);
      input.toggleAttribute("invalid", !accepted);
      zsShowIconError(!accepted);
      if (accepted) {
        refresh();
      }
    };

    input.addEventListener("change", commit);
    clear.addEventListener("click", () => {
      input.value = "";
      commit();
    });
    pick.addEventListener("click", async () => {
      const title = await document.l10n.formatValue("zen-sites-icon-picker-title");
      const fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
      fp.init(window.browsingContext, title, Ci.nsIFilePicker.modeOpen);
      // Animated GIF and animated SVG both render, so neither is filtered out.
      fp.appendFilter(title, "*.svg; *.png; *.gif; *.jpg; *.jpeg; *.webp; *.avif");
      fp.appendFilters(Ci.nsIFilePicker.filterAll);
      fp.open(result => {
        if (result === Ci.nsIFilePicker.returnOK && fp.file) {
          input.value = fp.file.path;
          commit();
        }
      });
    });

    refresh();
    cell.append(preview, input, pick, clear);
    return cell;
  }

  const PREVIEW_MIME = {
    svg: "image/svg+xml", png: "image/png", gif: "image/gif", jpg: "image/jpeg",
    jpeg: "image/jpeg", webp: "image/webp", avif: "image/avif",
  };

  async function zsBlobURL(fileURL) {
    try {
      const path = Services.io.newURI(fileURL).QueryInterface(Ci.nsIFileURL).file.path;
      const type = PREVIEW_MIME[path.split(".").pop().toLowerCase()] || "";
      // Typed on the way in: an untyped blob of an SVG is not sniffed as one.
      const bytes = await IOUtils.read(path, { maxBytes: 512 * 1024 });
      return URL.createObjectURL(new Blob([bytes], { type }));
    } catch {
      return "";
    }
  }

  function zsShowIconError(show) {
    const error = document.getElementById("zenSitesIconError");
    if (error) {
      error.hidden = !show;
    }
  }

  function zsWireAdd() {
    const add = document.getElementById("zenSitesAdd");
    const input = document.getElementById("zenSitesNewHost");
    if (!add || !input || add._zenWired) {
      return;
    }
    add._zenWired = true;
    const submit = () => {
      const host = normaliseHost(input.value);
      if (!host) {
        input.setAttribute("invalid", "true");
        return;
      }
      input.removeAttribute("invalid");
      const map = readMap(WIDTH_PREF);
      if (!(host in map)) {
        map[host] = 300;
        writeMap(WIDTH_PREF, map);
      }
      input.value = "";
      zsBuild();
    };
    add.addEventListener("command", submit);
    add.addEventListener("click", submit);
    input.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        submit();
      }
    });
  }

  /* Same lazy pane as the tab focus editor: the container is not in the
     document at DOMContentLoaded, so wait for the element itself. */
  function zsEnsure() {
    if (!document.getElementById("zenSitesList")) {
      return false;
    }
    zsBuild();
    zsWireAdd();
    for (const pref of [WIDTH_PREF, COLOR_PREF, ICON_PREF]) {
      Services.prefs.addObserver(pref, zsBuild);
    }
    window.addEventListener("unload", () => {
      for (const pref of [WIDTH_PREF, COLOR_PREF, ICON_PREF]) {
        Services.prefs.removeObserver(pref, zsBuild);
      }
    });
    return true;
  }

  if (!zsEnsure()) {
    const zsWatcher = new MutationObserver(() => {
      if (zsEnsure()) {
        zsWatcher.disconnect();
      }
    });
    zsWatcher.observe(document.documentElement, { childList: true, subtree: true });
  }
}

/* Category rail icons.
 *
 * moz-page-nav-button paints its icon from `iconsrc` into its shadow root,
 * where no stylesheet of ours can reach it - and when the rail collapses to
 * icons that same icon is what makes the widget hide its label slot. Dropping
 * `iconsrc` and slotting our own element instead solves both: the icon becomes
 * ordinary light DOM we can style, and one element then serves the wide rail
 * and the icon-only rail. The two glyphs and the cross-fade live in
 * zen-preferences.css. */
{
  // Which rail entries get a Zen glyph; the glyphs themselves are in
  // zen-preferences.css, keyed off these same ids.
  const ZEN_NAV_ICONS = new Set([
    "category-general",
    "category-zen-looks",
    "category-zen-tabs-management",
    "category-zen-CKS",
    "category-zen-marketplace",
    "category-zen-privacy",
    "category-sync",
    "category-home",
    "category-search",
    "category-privacy",
    "category-passwords-autofill",
    "category-appearance",
    "category-downloads",
    "category-tabs-browsing",
    "category-accessibility",
    "category-languages",
    "category-permissions-data",
    "category-experimental",
    "category-about-firefox",
    "addonsButton",
    "helpButton",
  ]);

  function zenNavDecorate(button) {
    if (!ZEN_NAV_ICONS.has(button.id)) {
      return;
    }
    // Setting the property to null is what drops the attribute; removing the
    // attribute alone lets Lit reflect the old value straight back.
    if (button.iconSrc) {
      button.iconSrc = null;
    }
    if (button.querySelector(":scope > .zen-nav-icon")) {
      return;
    }
    const icon = document.createElement("span");
    icon.className = "zen-nav-icon";
    button.prepend(icon);
  }

  // `selected` lives as a property on the host, never as an attribute, so the
  // filled state has to be mirrored onto a class for CSS to see it.
  function zenNavSync() {
    for (const button of document.querySelectorAll("moz-page-nav-button")) {
      zenNavDecorate(button);
      button.classList.toggle("zen-nav-selected", !!button.selected);
    }
  }

  function zenNavInit() {
    const nav = document.querySelector("moz-page-nav");
    if (!nav) {
      return false;
    }
    zenNavSync();
    // Fluent writes a button's label as textContent, which drops our icon with
    // it; re-adding is idempotent, so an observer is enough to survive it.
    new MutationObserver(() => zenNavSync()).observe(nav, {
      childList: true,
      subtree: true,
    });
    document.addEventListener("change-view", () =>
      requestAnimationFrame(zenNavSync)
    );
    window.addEventListener("hashchange", () => requestAnimationFrame(zenNavSync));
    return true;
  }

  if (!zenNavInit()) {
    const navWatcher = new MutationObserver(() => {
      if (zenNavInit()) {
        navWatcher.disconnect();
      }
    });
    navWatcher.observe(document.documentElement, { childList: true, subtree: true });
  }
}

/* Tor spaces.
 *
 * The proxy host/port are plain prefs, wired by hand so they need no entry in
 * the Preferences registry. The routed-container list is the important part:
 * a space marked for Tor refuses to load when the proxy is unreachable, and
 * until now the only way out was editing the JSON pref by hand. */
{
  const TOR_HOST = "zen.tor.proxy.host";
  const TOR_PORT = "zen.tor.proxy.port";
  const TOR_SPACES = "zen.tor.space-containers";
  const TOR_BRIDGES_LINES = "zen.tor.bridges.lines";

  const torLazy = {};
  ChromeUtils.defineESModuleGetters(torLazy, {
    ContextualIdentityService:
      "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs",
    ZenTorDaemon: "resource:///modules/zen/tor/ZenTorDaemon.sys.mjs",
  });

  // A value that no longer parses means no Tor spaces, never "route
  // everything" - same rule the proxy filter itself follows.
  const torReadSpaces = () => {
    try {
      const parsed = JSON.parse(Services.prefs.getStringPref(TOR_SPACES, "[]"));
      return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isInteger) : [];
    } catch {
      return [];
    }
  };

  const torSpaceLabel = id => {
    try {
      return torLazy.ContextualIdentityService.getUserContextLabel(id) || "";
    } catch {
      return "";
    }
  };

  function torBuildSpaces() {
    const list = document.getElementById("zenTorSpacesList");
    if (!list) {
      return;
    }
    const ids = torReadSpaces();
    const empty = document.getElementById("zenTorSpacesEmpty");
    if (empty) {
      empty.hidden = ids.length > 0;
    }

    list.textContent = "";
    for (const id of ids) {
      const row = document.createElement("div");
      row.className = "zen-row zen-tor-space-row";

      const name = document.createElement("span");
      name.className = "zen-sites-host";
      const label = torSpaceLabel(id);
      if (label) {
        name.textContent = label;
      } else {
        document.l10n.setAttributes(name, "zen-tor-space-unnamed", { id });
      }

      const drop = document.createElement("button");
      drop.type = "button";
      drop.className = "zen-button-ghost";
      document.l10n.setAttributes(drop, "zen-tor-space-unroute");
      drop.addEventListener("click", () => {
        Services.prefs.setStringPref(
          TOR_SPACES,
          JSON.stringify(torReadSpaces().filter(other => other !== id))
        );
        torBuildSpaces();
      });

      row.append(name, drop);
      list.append(row);
    }
  }

  function torWireProxy() {
    const host = document.getElementById("zenTorHost");
    const port = document.getElementById("zenTorPort");
    if (!host || !port || host._zenWired) {
      return;
    }
    host._zenWired = true;

    host.value = Services.prefs.getStringPref(TOR_HOST, "127.0.0.1");
    host.addEventListener("change", () => {
      const value = host.value.trim();
      if (value) {
        Services.prefs.setStringPref(TOR_HOST, value);
      } else {
        host.value = Services.prefs.getStringPref(TOR_HOST, "127.0.0.1");
      }
    });

    port.value = Services.prefs.getIntPref(TOR_PORT, 9050);
    port.addEventListener("change", () => {
      const value = parseInt(port.value, 10);
      if (Number.isInteger(value) && value > 0 && value < 65536) {
        Services.prefs.setIntPref(TOR_PORT, value);
      } else {
        port.value = Services.prefs.getIntPref(TOR_PORT, 9050);
      }
    });
  }

  /* Bridge lines: pasted text validated with the exact parser the daemon
     itself uses at start time, so what the settings page approves is what
     actually gets written into the torrc - never a separate, looser check
     that could pass something the daemon then refuses. */
  function torRenderTransports(container, needed) {
    if (!container) {
      return;
    }
    torLazy.ZenTorDaemon.checkTransports().then(detected => {
      container.textContent = "";
      const names = needed.size ? [...needed] : Object.keys(detected);
      for (const name of names) {
        const span = document.createElement("span");
        const found = !!detected[name];
        span.className = found
          ? "zen-tor-transport"
          : "zen-tor-transport zen-tor-transport-missing";
        document.l10n.setAttributes(
          span,
          found ? "zen-tor-bridges-transport-found" : "zen-tor-bridges-transport-missing",
          { name }
        );
        container.append(span);
      }
    });
  }

  function torValidateBridges(lines, status) {
    const text = lines.value;
    const parsed = torLazy.ZenTorDaemon.validateBridges(text);
    const empty = !text.trim();
    lines.toggleAttribute("invalid", !empty && !parsed.ok);
    if (empty) {
      document.l10n.setAttributes(status, "zen-tor-bridges-status-empty");
    } else if (parsed.ok) {
      document.l10n.setAttributes(status, "zen-tor-bridges-status-ok", {
        count: parsed.lines.length,
      });
    } else {
      document.l10n.setAttributes(status, "zen-tor-bridges-status-invalid", {
        reason: parsed.reason,
        line: parsed.line || 0,
      });
    }
    torRenderTransports(
      document.getElementById("zenTorBridgesTransports"),
      parsed.ok ? parsed.transports : new Set()
    );
  }

  function torWireBridges() {
    const lines = document.getElementById("zenTorBridgesLines");
    const status = document.getElementById("zenTorBridgesStatus");
    if (!lines || !status || lines._zenWired) {
      return;
    }
    lines._zenWired = true;

    lines.value = Services.prefs.getStringPref(TOR_BRIDGES_LINES, "");
    lines.addEventListener("input", () => torValidateBridges(lines, status));
    lines.addEventListener("change", () => {
      Services.prefs.setStringPref(TOR_BRIDGES_LINES, lines.value);
    });
    torValidateBridges(lines, status);
  }

  function torEnsure() {
    if (!document.getElementById("zenTorSpacesList")) {
      return false;
    }
    torWireProxy();
    torWireBridges();
    torBuildSpaces();
    Services.prefs.addObserver(TOR_SPACES, torBuildSpaces);
    window.addEventListener("unload", () => {
      Services.prefs.removeObserver(TOR_SPACES, torBuildSpaces);
    });
    return true;
  }

  if (!torEnsure()) {
    const torWatcher = new MutationObserver(() => {
      if (torEnsure()) {
        torWatcher.disconnect();
      }
    });
    torWatcher.observe(document.documentElement, { childList: true, subtree: true });
  }
}

/* Privacy pane. The lifetimes, the rules and the clearing all come from
   ZenSiteDataLifetime - this file only draws them, so the settings page and
   the browser can never disagree about what is in force. */
var gZenPrivacySettings = {
  _lifetimes: ["keep", "session", "tab"],

  init() {
    if (this.__hasInitialized || !document.getElementById("zenPrivacySitesList")) {
      return;
    }
    this.__hasInitialized = true;

    ({ ZenSiteDataLifetime: this.model } = ChromeUtils.importESModule(
      "resource:///modules/zen/ZenSiteDataLifetime.sys.mjs"
    ));

    this.buildDefault();
    this.buildHttps();
    this.buildSites();
    this.syncNotes();

    const watched = [
      "zen.privacy.site-data.default",
      "privacy.sanitize.sanitizeOnShutdown",
      "privacy.clearOnShutdown_v2.cookiesAndStorage",
      "dom.security.https_only_mode",
      "dom.security.https_first",
    ];
    for (const pref of watched) {
      Services.prefs.addObserver(pref, this);
    }
    window.addEventListener("unload", () => {
      for (const pref of watched) {
        Services.prefs.removeObserver(pref, this);
      }
    });
  },

  observe() {
    this.syncDefault();
    this.syncHttps();
    this.syncNotes();
  },

  el(tag, className, l10nId, args) {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (l10nId) {
      document.l10n.setAttributes(node, l10nId, args);
    }
    return node;
  },

  // Default lifetime
  // ----------------

  buildDefault() {
    const group = document.getElementById("zenPrivacyDefault");
    this._defaultSegments = new Map();
    for (const lifetime of this._lifetimes) {
      const segment = this.el("button", "zen-segment", `zen-privacy-lifetime-${lifetime}`);
      segment.type = "button";
      segment.addEventListener("click", () => {
        this.model.defaultLifetime = lifetime;
      });
      this._defaultSegments.set(lifetime, segment);
      group.append(segment);
    }
    this.syncDefault();
  },

  syncDefault() {
    if (!this._defaultSegments) {
      return;
    }
    const current = this.model.defaultLifetime;
    for (const [lifetime, segment] of this._defaultSegments) {
      segment.setAttribute("aria-pressed", String(lifetime === current));
    }
    document.l10n.setAttributes(
      document.getElementById("zenPrivacyDefaultNote"),
      `zen-privacy-default-note-${current}`
    );
  },

  // HTTPS posture
  // -------------

  // Two prefs, one choice: HTTPS-Only wins when it is on, so turning it off is
  // what "fall back quietly" means. https_first is left on either way - it is
  // what does the upgrading in both postures.
  buildHttps() {
    const group = document.getElementById("zenPrivacyHttps");
    this._httpsSegments = new Map();
    for (const mode of ["first", "only"]) {
      const segment = this.el("button", "zen-segment", `zen-privacy-https-${mode}`);
      segment.type = "button";
      segment.addEventListener("click", () => {
        Services.prefs.setBoolPref("dom.security.https_only_mode", mode === "only");
        Services.prefs.setBoolPref("dom.security.https_first", true);
      });
      this._httpsSegments.set(mode, segment);
      group.append(segment);
    }
    this.syncHttps();
  },

  syncHttps() {
    if (!this._httpsSegments) {
      return;
    }
    const only = Services.prefs.getBoolPref("dom.security.https_only_mode", false);
    for (const [mode, segment] of this._httpsSegments) {
      segment.setAttribute("aria-pressed", String((mode === "only") === only));
    }
    document.l10n.setAttributes(
      document.getElementById("zenPrivacyHttpsNote"),
      only ? "zen-privacy-https-note-only" : "zen-privacy-https-note-first"
    );
  },

  // The three shutdown rows do nothing while Firefox's master switch is off,
  // and that switch is what the default lifetime above drives. Showing them
  // ticked and live in that state is the exact kind of thing this pane is
  // meant not to do, so they are disabled and the reason is written out.
  syncNotes() {
    const on = Services.prefs.getBoolPref(
      "privacy.sanitize.sanitizeOnShutdown",
      false
    );
    for (const id of [
      "zenPrivacyShutdownCookies",
      "zenPrivacyShutdownCache",
      "zenPrivacyShutdownSiteSettings",
    ]) {
      document.getElementById(id)?.toggleAttribute("disabled", !on);
    }
    const state = document.getElementById("zenPrivacyShutdownState");
    if (state) {
      document.l10n.setAttributes(
        state,
        on ? "zen-privacy-shutdown-on" : "zen-privacy-shutdown-off"
      );
    }
  },

  // Per-site rules
  // --------------

  buildSites() {
    const add = document.getElementById("zenPrivacySiteAdd");
    const input = document.getElementById("zenPrivacyNewSite");
    const submit = () => this.addSite(input);
    add.addEventListener("command", submit);
    add.addEventListener("click", submit);
    input.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        submit();
      }
    });
    this.renderSites();
  },

  // Typed input is put through the same normaliser the browser uses, so what
  // the list shows is the key a rule is actually stored under.
  normalise(value) {
    const trimmed = value.trim().replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "");
    if (!trimmed || /[\s/?#@]/.test(trimmed)) {
      return null;
    }
    try {
      const uri = Services.io.newURI("https://" + trimmed);
      return this.model.siteOf(uri);
    } catch (ex) {
      return null;
    }
  },

  addSite(input) {
    const error = document.getElementById("zenPrivacySitesError");
    const site = this.normalise(input.value);
    error.hidden = !!site;
    if (!site) {
      return;
    }
    // A site added by hand starts on whatever is not the default, so adding it
    // is never a no-op.
    this.model.setRuleForSite(
      site,
      this.model.defaultLifetime === "keep" ? "session" : "keep"
    );
    input.value = "";
    this.renderSites();
  },

  renderSites() {
    const list = document.getElementById("zenPrivacySitesList");
    const rules = this.model.listRules();
    list.textContent = "";
    document.getElementById("zenPrivacySitesEmpty").hidden = rules.length > 0;
    const head = list.parentElement?.querySelector(".zen-table-head");
    if (head) {
      head.hidden = !rules.length;
    }

    for (const { site, lifetime } of rules) {
      const row = this.el("div", "zen-privacy-row");

      const name = this.el("span", "zen-sites-host");
      name.textContent = site;
      name.title = site;

      const select = document.createElement("select");
      select.className = "zen-privacy-lifetime";
      document.l10n.setAttributes(select, "zen-privacy-site-lifetime", { site });
      for (const option of this._lifetimes) {
        const item = this.el("option", null, `zen-privacy-lifetime-${option}`);
        item.value = option;
        item.selected = option === lifetime;
        select.append(item);
      }
      select.addEventListener("change", () => {
        this.model.setRuleForSite(site, select.value);
      });

      const clear = this.el("button", "zen-button-ghost", "zen-privacy-site-clear", { site });
      clear.type = "button";
      clear.addEventListener("click", async () => {
        clear.disabled = true;
        await this.model.forgetSite(site);
        document.l10n.setAttributes(clear, "zen-privacy-site-cleared", { site });
      });

      const remove = this.el("button", "zen-button-ghost zen-sites-remove", "zen-privacy-site-remove", { site });
      remove.type = "button";
      remove.addEventListener("click", () => {
        this.model.setRuleForSite(site, null);
        this.renderSites();
      });

      row.append(name, select, clear, remove);
      list.append(row);
    }
  },
};

/* about:preferences opens on whichever pane was last used, so the privacy pane
   may not exist when this file runs. Same wait the Tor group uses. */
{
  if (!document.getElementById("zenPrivacySitesList")) {
    const watcher = new MutationObserver(() => {
      if (document.getElementById("zenPrivacySitesList")) {
        watcher.disconnect();
        gZenPrivacySettings.init();
      }
    });
    watcher.observe(document.documentElement, { childList: true, subtree: true });
  }
}


/* Spaces: the window's list, with the desktop each one follows. Built from
   the most recent browser window, which owns the live list. */
{
  const ZDS_DESKTOPS = 10;

  const zdsModule = () =>
    ChromeUtils.importESModule("resource:///modules/zen/ZenDesktopSpaces.sys.mjs");

  function zdsBuild() {
    const list = document.getElementById("zenSpacesList");
    if (!list) {
      return false;
    }
    const { ZenDesktopSpaces } = zdsModule();
    const win = Services.wm.getMostRecentWindow("navigator:browser");
    const spaces = win?.gZenWorkspaces?.getWorkspaces() || [];
    const map = ZenDesktopSpaces.map;
    const follow = Services.prefs.getBoolPref("zen.spaces.desktop.enabled", false);
    list.textContent = "";
    spaces.forEach((space, index) => {
      const row = document.createElement("div");
      row.className = "zen-spaces-row";
      const icon = document.createElement("span");
      icon.className = "zen-spaces-icon";
      if (space.icon?.includes("/")) {
        const img = document.createElement("img");
        img.src = space.icon;
        icon.append(img);
      } else {
        icon.textContent = space.icon || String(index + 1);
      }
      const name = document.createElement("span");
      name.className = "zen-spaces-name";
      name.textContent = space.name;
      const pick = document.createElement("select");
      pick.className = "zen-spaces-desktop";
      pick.disabled = !follow;
      document.l10n.setAttributes(pick, "zen-spaces-desktop-select", { name: space.name });
      const option = (value, l10nId, args) => {
        const o = document.createElement("option");
        o.value = value;
        document.l10n.setAttributes(o, l10nId, args);
        pick.append(o);
      };
      option("auto", "zen-spaces-desktop-auto");
      option("0", "zen-spaces-desktop-never");
      for (let n = 1; n <= ZDS_DESKTOPS; n++) {
        option(String(n), "zen-spaces-desktop-number", { number: n });
      }
      pick.value = space.uuid in map ? String(map[space.uuid]) : "auto";
      pick.addEventListener("change", () => {
        ZenDesktopSpaces.setPin(space.uuid, pick.value === "auto" ? null : Number(pick.value));
        zdsBuild();
      });
      // What "auto" resolves to right now, so the default is never a guess.
      const now = document.createElement("span");
      now.className = "zen-spaces-now";
      const desktop = [...Array(ZDS_DESKTOPS).keys()]
        .map(i => i + 1)
        .find(n => ZenDesktopSpaces.spaceFor(spaces, n, map)?.uuid === space.uuid);
      if (follow && desktop) {
        document.l10n.setAttributes(now, "zen-spaces-desktop-now", { number: desktop });
      }
      row.append(icon, name, now, pick);
      list.append(row);
    });
    zdsStatus();
    return true;
  }

  async function zdsStatus() {
    const line = document.getElementById("zenSpacesDesktopStatus");
    if (!line) {
      return;
    }
    const { ZenDesktopSpaces } = zdsModule();
    const r = await ZenDesktopSpaces.current();
    if (r.desktop) {
      document.l10n.setAttributes(line, "zen-spaces-desktop-status-ok", {
        desktop: r.reader, number: r.desktop,
      });
    } else if (r.error === "missing-tool") {
      document.l10n.setAttributes(line, "zen-spaces-desktop-status-tool", { tool: r.tool });
    } else {
      document.l10n.setAttributes(line, "zen-spaces-desktop-status-unsupported");
    }
  }

  function zdsInit() {
    if (!zdsBuild()) {
      return false;
    }
    document.getElementById("zenSpacesNew")?.addEventListener("command", () => {
      const win = Services.wm.getMostRecentWindow("navigator:browser");
      win?.document.getElementById("cmd_zenOpenWorkspaceCreation")?.doCommand();
      win?.focus();
    });
    for (const pref of ["zen.spaces.desktop.enabled", "zen.spaces.desktop.map"]) {
      Services.prefs.addObserver(pref, zdsBuild);
      window.addEventListener("unload", () => Services.prefs.removeObserver(pref, zdsBuild));
    }
    // Spaces are created and renamed in the window; refresh on return here.
    window.addEventListener("focus", zdsBuild);
    return true;
  }

  if (!zdsInit()) {
    const zdsWatcher = new MutationObserver(() => {
      if (zdsInit()) {
        zdsWatcher.disconnect();
      }
    });
    zdsWatcher.observe(document.documentElement, { childList: true, subtree: true });
  }
}


/* Theme colours: the accent picker, and the rows that only apply when the
   palette is a custom one. */
{
  function ztInit() {
    const input = document.getElementById("zenThemeAccent");
    if (!input) {
      return false;
    }
    input.value = Services.prefs.getStringPref("zen.theme.accent", "#478fff");
    input.addEventListener("input", () => Services.prefs.setStringPref("zen.theme.accent", input.value));
    const sync = () => {
      const custom = Services.prefs.getStringPref("zen.theme.palette", "desktop") === "custom";
      for (const id of ["zenThemeAccentRow", "zenThemeSchemeRow"]) {
        document.getElementById(id).hidden = !custom;
      }
    };
    Services.prefs.addObserver("zen.theme.palette", sync);
    window.addEventListener("unload", () => Services.prefs.removeObserver("zen.theme.palette", sync), { once: true });
    sync();
    return true;
  }

  if (!ztInit()) {
    const ztWatcher = new MutationObserver(() => {
      if (ztInit()) {
        ztWatcher.disconnect();
      }
    });
    ztWatcher.observe(document.documentElement, { childList: true, subtree: true });
  }
}

/* The dotfile: where it is, what it applied, what it could not read. */
{
  const zcModule = () =>
    ChromeUtils.importESModule("resource:///modules/zen/TelaConfig.sys.mjs").TelaConfig;

  function zcPaint() {
    const status = document.getElementById("zenConfigStatus");
    if (!status) {
      return false;
    }
    const config = zcModule();
    const s = config.status;
    document.getElementById("zenConfigPath").textContent = config.path;
    if (!s.exists) {
      document.l10n.setAttributes(status, "zen-config-status-missing");
    } else if (s.errors.length) {
      document.l10n.setAttributes(status, "zen-config-status-errors", {
        applied: s.applied.length, errors: s.errors.length,
      });
    } else {
      document.l10n.setAttributes(status, "zen-config-status-ok", { applied: s.applied.length });
    }
    const list = document.getElementById("zenConfigErrors");
    list.textContent = "";
    for (const e of s.errors) {
      const li = document.createElement("li");
      li.textContent = `${e.line ? `line ${e.line}: ` : ""}${e.message}`;
      list.append(li);
    }
    list.hidden = !s.errors.length;
    document.getElementById("zenConfigCreate").hidden = s.exists;
    document.getElementById("zenConfigOpen").hidden = !s.exists;
    return true;
  }

  function zcInit() {
    if (!zcPaint()) {
      return false;
    }
    const config = zcModule();
    document.getElementById("zenConfigCreate").addEventListener("command", async () => {
      await config.create();
      zcPaint();
    });
    const file = path => {
      const f = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      f.initWithPath(path);
      return f;
    };
    // The system's own handler for .toml - the user's editor.
    document.getElementById("zenConfigOpen").addEventListener("command", () => {
      try {
        file(config.path).launch();
      } catch (e) {
        file(config.path).reveal();
      }
    });
    document.getElementById("zenConfigFolder").addEventListener("command", () => {
      const dir = file(PathUtils.parent(config.path));
      if (dir.exists()) {
        dir.launch();
      } else {
        file(config.path).reveal();
      }
    });
    const observer = () => zcPaint();
    Services.obs.addObserver(observer, "tela-config-changed");
    window.addEventListener("unload", () => Services.obs.removeObserver(observer, "tela-config-changed"));
    return true;
  }

  if (!zcInit()) {
    const zcWatcher = new MutationObserver(() => {
      if (zcInit()) {
        zcWatcher.disconnect();
      }
    });
    zcWatcher.observe(document.documentElement, { childList: true, subtree: true });
  }
}


/* Translated sites: what was translated, into what, and whether it repeats. */
{
  const ZTS_PREF = "zen.translations.sites";

  const ztsSites = () => {
    try {
      return JSON.parse(Services.prefs.getStringPref(ZTS_PREF, "{}")) || {};
    } catch {
      return {};
    }
  };
  const ztsSave = map => Services.prefs.setStringPref(ZTS_PREF, JSON.stringify(map));

  function ztsBuild() {
    const list = document.getElementById("zenTranslatedSitesList");
    if (!list) {
      return false;
    }
    const sites = Object.entries(ztsSites()).sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
    let names;
    try {
      names = new Intl.DisplayNames([Services.locale.appLocaleAsBCP47], { type: "language" });
    } catch {
      names = { of: code => code };
    }
    const dates = new Intl.DateTimeFormat(Services.locale.appLocaleAsBCP47, { dateStyle: "medium" });
    list.textContent = "";
    for (const [host, site] of sites) {
      const row = document.createElement("div");
      row.className = "zen-translated-row";
      const name = document.createElement("span");
      name.className = "zen-translated-host";
      name.textContent = host;
      name.title = site.title || host;
      const langs = document.createElement("span");
      langs.className = "zen-translated-langs";
      langs.textContent = `${names.of(site.from)} → ${names.of(site.to)}`;
      const when = document.createElement("span");
      when.className = "zen-translated-when";
      when.textContent = site.at ? dates.format(new Date(site.at)) : "";
      const auto = document.createElement("input");
      auto.type = "checkbox";
      auto.checked = site.auto !== false;
      document.l10n.setAttributes(auto, "zen-translated-sites-row-auto", { host });
      auto.addEventListener("change", () => {
        const map = ztsSites();
        if (map[host]) {
          map[host].auto = auto.checked;
          ztsSave(map);
        }
      });
      const remove = document.createElement("button");
      remove.className = "zen-button-ghost";
      document.l10n.setAttributes(remove, "zen-translated-sites-remove", { host });
      remove.addEventListener("click", () => {
        const map = ztsSites();
        delete map[host];
        ztsSave(map);
      });
      row.append(name, langs, when, auto, remove);
      list.append(row);
    }
    document.getElementById("zenTranslatedSitesEmpty").hidden = sites.length > 0;
    document.getElementById("zenTranslatedSitesClear").disabled = !sites.length;
    return true;
  }

  function ztsInit() {
    if (!ztsBuild()) {
      return false;
    }
    document.getElementById("zenTranslatedSitesClear").addEventListener("command", () => ztsSave({}));
    Services.prefs.addObserver(ZTS_PREF, ztsBuild);
    window.addEventListener("unload", () => Services.prefs.removeObserver(ZTS_PREF, ztsBuild));
    return true;
  }

  if (!ztsInit()) {
    const ztsWatcher = new MutationObserver(() => {
      if (ztsInit()) {
        ztsWatcher.disconnect();
      }
    });
    ztsWatcher.observe(document.documentElement, { childList: true, subtree: true });
  }
}

/* Reel sites: which sites open their videos in reel, and what the tab does after. */
{
  const { TelaExternalPlayer } = ChromeUtils.importESModule(
    "resource:///modules/zen/TelaMediaBridge.sys.mjs",
    { global: "current" }
  );
  const REEL_PREF = "zen.media.external.sites";
  const REEL_AFTER = { pause: "zen-reel-after-pause", close: "zen-reel-after-close", keep: "zen-reel-after-keep" };

  const reelBuild = () => {
    const list = document.getElementById("zenReelSitesList");
    if (!list) {
      return false;
    }
    const sites = Object.entries(TelaExternalPlayer.sites).sort(([a], [b]) => a.localeCompare(b));
    list.textContent = "";
    for (const [host, rule] of sites) {
      const row = document.createElement("div");
      row.className = "zen-translated-row";
      const name = document.createElement("span");
      name.className = "zen-translated-host";
      name.textContent = host;
      const after = document.createElement("span");
      after.className = "zen-translated-langs";
      document.l10n.setAttributes(after, REEL_AFTER[rule.after] || REEL_AFTER.pause);
      const always = document.createElement("span");
      always.className = "zen-translated-when";
      if (rule.always) {
        document.l10n.setAttributes(always, "zen-reel-prefs-always");
      }
      const remove = document.createElement("button");
      remove.className = "zen-button-ghost";
      document.l10n.setAttributes(remove, "zen-reel-prefs-remove", { host });
      remove.addEventListener("click", () => TelaExternalPlayer.setRule(host, null));
      row.append(name, always, after, remove);
      list.append(row);
    }
    document.getElementById("zenReelSitesEmpty").hidden = sites.length > 0;
    return true;
  }

  function reelInit() {
    if (!reelBuild()) {
      return false;
    }
    Services.prefs.addObserver(REEL_PREF, reelBuild);
    window.addEventListener("unload", () => Services.prefs.removeObserver(REEL_PREF, reelBuild));
    return true;
  }

  if (!reelInit()) {
    const reelWatcher = new MutationObserver(() => {
      if (reelInit()) {
        reelWatcher.disconnect();
      }
    });
    reelWatcher.observe(document.documentElement, { childList: true, subtree: true });
  }
}
