// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

const WIDGET_ID = "zen-translations-button";
// host -> {from, to, auto, at, title}: every site translated here.
const SITES_PREF = "zen.translations.sites";
const AUTO_PREF = "zen.translations.remember-sites";
const MAX_SITES = 200;

/* Firefox's translate icon lives in the urlbar's page actions, which tela's
   urlbar has no room for. This widget opens the same panel and mirrors the
   urlbar icon's state, so it can sit in any toolbar. */
window.gZenTranslationsButton = {
  // browser -> URL already auto-translated, so it happens once per load.
  _autoDone: new WeakMap(),

  get sites() {
    try {
      return JSON.parse(Services.prefs.getStringPref(SITES_PREF, "{}")) || {};
    } catch {
      return {};
    }
  },

  saveSites(map) {
    // Oldest out first once the list is full.
    const keep = Object.entries(map)
      .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
      .slice(0, MAX_SITES);
    Services.prefs.setStringPref(SITES_PREF, JSON.stringify(Object.fromEntries(keep)));
  },

  _host(browser) {
    try {
      const uri = browser?.currentURI;
      return uri && /^https?$/.test(uri.scheme) ? uri.host.replace(/^www\./, "") : "";
    } catch {
      return "";
    }
  },

  _remember(browser, pair) {
    const host = this._host(browser);
    if (!host || !pair?.sourceLanguage || !pair?.targetLanguage) {
      return;
    }
    const map = this.sites;
    const old = map[host] || {};
    if (old.from === pair.sourceLanguage && old.to === pair.targetLanguage &&
        Date.now() - (old.at || 0) < 60000) {
      return; // Same translation still on screen: no pref write per update.
    }
    map[host] = {
      from: pair.sourceLanguage,
      to: pair.targetLanguage,
      auto: old.auto ?? true,
      at: Date.now(),
      title: browser.contentTitle || old.title || host,
    };
    this.saveSites(map);
  },

  /* A remembered site translates itself again on the way back - once per
     page load, and only while the page is untranslated. */
  _autoTranslate(browser, restricted, active) {
    if (restricted || active || !Services.prefs.getBoolPref(AUTO_PREF, true)) {
      return;
    }
    const site = this.sites[this._host(browser)];
    const url = browser.currentURI?.spec;
    if (!site?.auto || !url || this._autoDone.get(browser) === url) {
      return;
    }
    this._autoDone.set(browser, url);
    try {
      TranslationsParent.getTranslationsActor(browser).translate(
        { sourceLanguage: site.from, targetLanguage: site.to },
        false
      );
    } catch (e) {
      // The page is not ready for its actor yet; the next update retries.
      this._autoDone.delete(browser);
    }
  },

  setAuto(host, on) {
    const map = this.sites;
    if (map[host]) {
      map[host].auto = on;
      this.saveSites(map);
    }
  },

  forget(host) {
    const map = this.sites;
    if (host) {
      delete map[host];
    }
    this.saveSites(host ? map : {});
  },

  init() {
    if (!Services.prefs.getBoolPref("zen.translations.enable-migrated", false)) {
      // Older profiles stored the feature switched off; enable it once.
      Services.prefs.clearUserPref("browser.translations.enable");
      Services.prefs.setBoolPref("zen.translations.enable-migrated", true);
    }
    this._buildSitesMenu();
    this._registerWidget();
    const source = document.getElementById("translations-button");
    if (source) {
      new MutationObserver(() => this._update()).observe(source, {
        attributes: true,
        subtree: true,
        childList: true,
        characterData: true,
      });
    }
    gBrowser.tabContainer.addEventListener("TabSelect", () => this._update());
    gBrowser.addTabsProgressListener({
      onLocationChange: (browser) => {
        if (browser === gBrowser.selectedBrowser) {
          this._update();
        }
      },
    });
    this._update();
  },

  /* Recent translated sites, newest first; a click opens one in a new tab. */
  _buildSitesMenu() {
    if (document.getElementById("zen-translations-sites-menu")) {
      return;
    }
    const popup = document.createXULElement("menupopup");
    popup.id = "zen-translations-sites-menu";
    popup.addEventListener("popupshowing", event => {
      if (event.target !== popup) {
        return;
      }
      popup.textContent = "";
      const names = TranslationsParent.createLanguageDisplayNames();
      const entries = Object.entries(this.sites)
        .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
        .slice(0, 12);
      const head = document.createXULElement("menuitem");
      head.disabled = true;
      document.l10n.setAttributes(
        head,
        entries.length ? "zen-translations-sites-heading" : "zen-translations-sites-empty"
      );
      popup.append(head);
      for (const [host, site] of entries) {
        const item = document.createXULElement("menuitem");
        item.className = "menuitem-iconic";
        item.setAttribute("image", `page-icon:https://${host}/`);
        document.l10n.setAttributes(item, "zen-translations-sites-item", {
          host,
          from: names.of(site.from),
          to: names.of(site.to),
        });
        item.addEventListener("command", () => {
          gBrowser.selectedTab = gBrowser.addTab(`https://${host}/`, {
            triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
          });
        });
        popup.append(item);
      }
      popup.append(document.createXULElement("menuseparator"));
      const manage = document.createXULElement("menuitem");
      document.l10n.setAttributes(manage, "zen-translations-sites-manage");
      manage.addEventListener("command", () => openPreferences("paneZenTabManagement"));
      popup.append(manage);
    });
    document.getElementById("mainPopupSet").append(popup);
  },

  _registerWidget() {
    if (CustomizableUI.getWidget(WIDGET_ID)?.provider === CustomizableUI.PROVIDER_API) {
      return;
    }
    try {
      CustomizableUI.createWidget({
        id: WIDGET_ID,
        type: "custom",
        l10nId: WIDGET_ID,
        defaultArea: "zen-sidebar-foot-buttons",
        onBuild(doc) {
          const button = doc.createXULElement("toolbarbutton");
          button.id = WIDGET_ID;
          button.setAttribute("badged", "true");
          button.className = "toolbarbutton-1 chromeclass-toolbar-additional";
          button.setAttribute("removable", "true");
          // Right-click: the sites translated before, not the toolbar menu.
          button.setAttribute("context", "zen-translations-sites-menu");
          doc.l10n.setAttributes(button, WIDGET_ID);
          button.addEventListener("command", (event) => {
            const win = doc.defaultView;
            if (!win.TranslationsParent.isFullPageTranslationsRestrictedForPage(win.gBrowser)) {
              win.FullPageTranslationsPanel.open(event);
            }
          });
          return button;
        },
      });
    } catch (ex) {
      console.error("[zen-translations] could not register the widget", ex);
    }
  },

  _update() {
    const button = document.getElementById(WIDGET_ID);
    const source = document.getElementById("translations-button");
    if (!button || !source) {
      return;
    }
    let restricted = true;
    try {
      restricted =
        !TranslationsFeature.isEnabled ||
        TranslationsParent.isFullPageTranslationsRestrictedForPage(gBrowser);
    } catch (e) {}
    const active = source.hasAttribute("translationsactive");
    const loading =
      active && !document.getElementById("translations-button-circle-arrows")?.hidden;
    const locale = document.getElementById("translations-button-locale");
    button.disabled = restricted;
    // Dimmed, not hidden, when the page needs no translating: it can still be
    // translated by hand, and the button keeps its place.
    button.toggleAttribute("zen-idle", !restricted && source.hidden);
    button.toggleAttribute("translationsactive", active);
    button.toggleAttribute("zen-loading", loading);
    const lang = active && !loading && !locale?.hidden ? locale.textContent : "";
    if (lang) {
      button.setAttribute("badge", lang);
    } else {
      button.removeAttribute("badge");
    }
    const pair = active
      ? TranslationsParent.getTranslationsActor(gBrowser.selectedBrowser)?.languageState
          ?.requestedLanguagePair
      : null;
    if (pair && !loading) {
      this._remember(gBrowser.selectedBrowser, pair);
    }
    this._autoTranslate(gBrowser.selectedBrowser, restricted, active);
    if (loading) {
      document.l10n.setAttributes(button, "zen-translations-button-loading");
    } else if (pair) {
      const names = TranslationsParent.createLanguageDisplayNames();
      document.l10n.setAttributes(button, "zen-translations-button-translated", {
        fromLanguage: names.of(pair.sourceLanguage),
        toLanguage: names.of(pair.targetLanguage),
      });
    } else {
      document.l10n.setAttributes(button, WIDGET_ID);
    }
  },
};

window.addEventListener(
  "MozAfterPaint",
  () => {
    try {
      gZenTranslationsButton.init();
    } catch (ex) {
      console.error("[zen-translations] init failed", ex);
    }
  },
  { once: true }
);
