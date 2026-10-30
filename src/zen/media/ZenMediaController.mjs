// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

const lazy = {};
XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "RESPECT_PIP_DISABLED",
  "media.videocontrols.picture-in-picture.respect-disablePictureInPicture",
  true,
);
ChromeUtils.defineESModuleGetters(lazy, {
  TelaExternalPlayer: "resource:///modules/zen/TelaMediaBridge.sys.mjs",
  PageActions: "resource:///modules/PageActions.sys.mjs",
});

/**
 * A single card in the sidebar media stack: the full control UI for one
 * media controller, or for a WebRTC sharing session when `controller` is
 * null.
 */
class ZenMediaCard {
  #updateInterval = null;
  #tabTimeout = null;
  #fullscreenWatch = null;
  #controllerListeners = null;

  static supportedKeys = ["playpause", "previoustrack", "nexttrack"];

  constructor(manager, element, browser, controller = null) {
    this.manager = manager;
    this.element = element;
    this.browser = browser;
    this.controller = controller;

    this.titleEl = element.querySelector(".zen-media-title");
    this.artistEl = element.querySelector(".zen-media-artist");
    this.progressBar = element.querySelector(".zen-media-progress-bar");
    this.currentTimeEl = element.querySelector(".zen-media-current-time");
    this.durationEl = element.querySelector(".zen-media-duration");
    this.focusButton = element.querySelector(".zen-media-focus-button");

    this.#initListeners();

    if (controller) {
      // Queried before anything is wired up: it throws if the controller
      // went away in the meantime, and the caller drops the card.
      const positionState = controller.getPositionState();

      this.#controllerListeners = {
        positionstatechange: this.#onPositionstateChange.bind(this),
        playbackstatechange: this.#onPlaybackstateChange.bind(this),
        supportedkeyschange: this.#onSupportedKeysChange.bind(this),
        metadatachange: this.#onMetadataChange.bind(this),
        deactivated: this.#onDeactivated.bind(this),
        pictureinpicturemodechange: this.#onPipModeChange.bind(this),
      };
      for (const [event, listener] of Object.entries(
        this.#controllerListeners,
      )) {
        controller.addEventListener(event, listener);
      }

      this.element.classList.toggle("playing", controller.isPlaying);
      this.updateMetadata();
      this.updatePositionState(positionState);
      this.updateSupportedKeys();
    } else {
      this.element.setAttribute("media-sharing", "");
      this.element.setAttribute("media-position-hidden", "true");
      this.titleEl.textContent =
        window.gBrowser.getTabForBrowser(browser)?.label || "";
      this.artistEl.textContent = "";
      this.updateIcon();
    }

    this.updatePipButton();
    this.updateMuteState();
  }

  get isSharing() {
    return !this.controller;
  }

  get shouldBeVisible() {
    if (this.isSharing) {
      return true;
    }
    if (this.controller.isBeingUsedInPIPModeOrFullscreen) {
      return false;
    }
    // Zen hides the card on its own tab; the pref keeps it, ⋯ panel and all.
    return (
      Services.prefs.getBoolPref("zen.mediacontrols.show-on-own-tab", false) ||
      gBrowser.selectedBrowser.browserId !== this.browser.browserId
    );
  }

  #initListeners() {
    this.element.addEventListener("mousedown", (event) => {
      if (event.target.closest(":is(toolbarbutton,.zen-media-progress-hbox)")) {
        return;
      }
      this.onFocus();
    });

    this.element.addEventListener("command", (event) => {
      const button = event.target.closest("toolbarbutton");
      if (!button) {
        return;
      }
      if (button.matches(".zen-media-pip-button")) {
        this.onPip();
      } else if (button.matches(".zen-media-external-button")) {
        this.onExternal();
      } else if (button.matches(".zen-media-more-button")) {
        this.manager.openMorePanel(this, button);
      } else if (button.matches(".zen-media-close-button")) {
        this.onClose();
      } else if (button.matches(".zen-media-focus-button")) {
        this.onFocus();
      } else if (button.matches(".zen-media-mute-button")) {
        this.onMute();
      } else if (button.matches(".zen-media-previoustrack-button")) {
        this.onPlayPrev();
      } else if (button.matches(".zen-media-nexttrack-button")) {
        this.onPlayNext();
      } else if (button.matches(".zen-media-playpause-button")) {
        this.onToggle();
      } else if (button.matches(".zen-media-mute-mic-button")) {
        this.onMicrophoneMuteToggle();
      } else if (button.matches(".zen-media-mute-camera-button")) {
        this.onCameraMuteToggle();
      }
    });

    this.progressBar.addEventListener("input", this.onSeekDrag.bind(this));
    this.progressBar.addEventListener("change", this.onSeekComplete.bind(this));
  }

  #onPositionstateChange(event) {
    this.updatePositionState(event);
  }

  #onPlaybackstateChange() {
    this.element.classList.toggle("playing", this.controller.isPlaying);
    this.updatePosition();
    this.manager.trace(`${this.controller.isPlaying ? "play" : "pause"} ${this.#label}`);
    // Play and pause change which card belongs in front.
    this.manager.onCardVisibilityChanged();
  }

  #onSupportedKeysChange() {
    this.updateSupportedKeys();
  }

  #onMetadataChange() {
    this.updateMetadata();
    this.updatePipButton();
  }

  #onDeactivated() {
    this.destroy();
  }

  #onPipModeChange() {
    this.element.toggleAttribute(
      "pip",
      this.controller.isBeingUsedInPIPModeOrFullscreen,
    );
    this.refreshVisibility();
  }

  refreshVisibility() {
    this.setHidden(!this.shouldBeVisible);
    this.#watchFullscreen();
  }

  /* Hidden for fullscreen, the card has to look again: Gecko sends no event
     when a video leaves fullscreen (only PiP has one), and leaving lands just
     after the tab switch that caused it - the card then stayed hidden. */
  #watchFullscreen() {
    if (this.#fullscreenWatch || !this.controller?.isBeingUsedInPIPModeOrFullscreen) {
      return;
    }
    this.#fullscreenWatch = setInterval(() => {
      if (this.controller?.isBeingUsedInPIPModeOrFullscreen) {
        return;
      }
      clearInterval(this.#fullscreenWatch);
      this.#fullscreenWatch = null;
      this.manager.trace(`fullscreen left ${this.#label}`);
      this.refreshVisibility();
    }, 400);
  }

  setHidden(hidden) {
    this.manager.trace(`${hidden ? "hide" : "show"} ${this.#label}`);
    if (!hidden) {
      // Showing cancels a hide that may still be animating.
      this.element.removeAttribute("zen-hiding");
      if (this.element.hidden) {
        this.element.hidden = false;
        this.manager.onCardVisibilityChanged();
      }
      return;
    }

    if (this.element.hidden || this.element.hasAttribute("zen-hiding")) {
      return;
    }
    this.element.setAttribute("zen-hiding", "true");
    Promise.allSettled(
      this.element.getAnimations().map((animation) => animation.finished),
    ).then(() => {
      if (!this.element.hasAttribute("zen-hiding")) {
        return;
      }
      this.element.removeAttribute("zen-hiding");
      if (this.shouldBeVisible) {
        this.manager.trace(`hide-cancelled ${this.#label}`);
        return;
      }
      this.element.hidden = true;
      this.manager.trace(`hidden ${this.#label}`);
      this.manager.onCardVisibilityChanged();
    });
  }

  // Mirrors the original bar behavior: hide instantly when the card's own
  // tab is selected, reappear on a small delay when switching away.
  get #label() {
    return (this.browser?.contentTitle || "?").slice(0, 24);
  }

  onTabSelect() {
    this.manager.trace(`select visible=${this.shouldBeVisible} ${this.#label}`);
    if (this.#tabTimeout) {
      clearTimeout(this.#tabTimeout);
      this.#tabTimeout = null;
    }
    clearInterval(this.#fullscreenWatch);
    this.#fullscreenWatch = null;

    if (!this.shouldBeVisible) {
      this.setHidden(true);
      this.#watchFullscreen();
    } else if (this.element.hidden) {
      // Long enough to skip flicker while flipping through tabs; 500ms left
      // a visibly empty slot where the card was about to come back.
      this.#tabTimeout = setTimeout(() => {
        this.#tabTimeout = null;
        this.refreshVisibility();
      }, 120);
    }
  }

  updateMetadata() {
    const metadata = this.controller.getMetadata();
    this.titleEl.textContent = metadata.title || "";
    this.artistEl.textContent = metadata.artist || "";
    this.updateIcon();
    this.updateLabelOverflows();
  }

  updateIcon() {
    const iconURL =
      this.browser.mIconURL || `page-icon:${this.browser.currentURI.spec}`;
    this.focusButton.style.listStyleImage = `url(${iconURL})`;
  }

  updateLabelOverflows() {
    for (const label of [this.titleEl, this.artistEl]) {
      label.removeAttribute("overflow"); // So we can properly recalculate the overflow
      if (label.scrollWidth > label.parentElement.clientWidth) {
        label.setAttribute("overflow", "");
      }
    }
  }

  updateSupportedKeys() {
    for (const key of ZenMediaCard.supportedKeys) {
      const button = this.element.querySelector(`.zen-media-${key}-button`);
      button.disabled = !this.controller.supportedKeys.includes(key);
    }
  }

  updatePositionState(positionState) {
    this.position = positionState.position;
    this.duration = positionState.duration;
    this.playbackRate = positionState.playbackRate;
    this.updatePosition();
  }

  updatePosition() {
    if (this.#updateInterval) {
      clearInterval(this.#updateInterval);
      this.#updateInterval = null;
    }

    if (this.duration >= 900_000) {
      this.element.setAttribute("media-position-hidden", "true");
      return;
    }
    this.element.removeAttribute("media-position-hidden");

    if (!this.duration) {
      return;
    }

    this.currentTimeEl.textContent = this.formatSecondsToTime(this.position);
    this.durationEl.textContent = this.formatSecondsToTime(this.duration);
    this.progressBar.value = (this.position / this.duration) * 100;

    this.#updateInterval = setInterval(() => {
      if (this.controller?.isPlaying) {
        this.position += 1 * this.playbackRate;
        if (this.position > this.duration) {
          this.position = this.duration;
        }
        this.currentTimeEl.textContent = this.formatSecondsToTime(
          this.position,
        );
        this.progressBar.value = (this.position / this.duration) * 100;
      } else {
        clearInterval(this.#updateInterval);
        this.#updateInterval = null;
      }
    }, 1000);
  }

  formatSecondsToTime(seconds) {
    if (!seconds || isNaN(seconds)) {
      return "0:00";
    }

    const totalSeconds = Math.max(0, Math.ceil(seconds));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60).toString();
    const secs = (totalSeconds % 60).toString();

    if (hours > 0) {
      return `${hours}:${minutes.padStart(2, "0")}:${secs.padStart(2, "0")}`;
    }

    return `${minutes}:${secs.padStart(2, "0")}`;
  }

  updateMuteState() {
    this.element.toggleAttribute("muted", this.browser.audioMuted);
  }

  updatePipButton() {
    if (this.isSharing) {
      this.element.removeAttribute("can-pip");
      return;
    }

    const { totalPipCount, totalPipDisabled } =
      PictureInPicture.getEligiblePipVideoCount(this.browser);
    const canPip =
      totalPipCount === 1 ||
      (totalPipDisabled > 0 && lazy.RESPECT_PIP_DISABLED);

    this.element.toggleAttribute("can-pip", canPip);
  }

  /* Straight to the tab, across spaces: MediaController.focus() left an
     essential (YouTube Music pinned there) unselected. */
  async onFocus() {
    const tab = window.gBrowser.getTabForBrowser(this.browser);
    if (tab) {
      await window.gZenWorkspaces.switchTabIfNeeded(tab);
      if (window.gBrowser.selectedTab !== tab) {
        window.gBrowser.selectedTab = tab;
      }
      return;
    }
    this.controller?.focus();
  }

  onMute() {
    const tab = window.gBrowser.getTabForBrowser(this.browser);
    if (tab) {
      tab.toggleMuteAudio();
      this.updateMuteState();
    }
  }

  onToggle() {
    if (this.controller?.isPlaying) {
      this.controller.pause("user");
    } else {
      this.controller?.play();
    }
  }

  onPlayPrev() {
    if (this.controller?.supportedKeys.includes("previoustrack")) {
      this.controller.prevTrack();
    }
  }

  onPlayNext() {
    if (this.controller?.supportedKeys.includes("nexttrack")) {
      this.controller.nextTrack();
    }
  }

  onSeekDrag(event) {
    this.controller?.pause("user");
    const newTime = (event.target.value / 100) * this.duration;
    this.currentTimeEl.textContent = this.formatSecondsToTime(newTime);
  }

  onSeekComplete(event) {
    const newPosition = (event.target.value / 100) * this.duration;
    if (this.controller?.supportedKeys.includes("seekto")) {
      this.controller.seekTo(newPosition);
      this.controller.play();
    }
  }

  onPip() {
    this.browser.browsingContext.currentWindowGlobal
      .getActor("PictureInPictureLauncher")
      .sendAsyncMessage("PictureInPicture:KeyToggle");
  }

  async onExternal() {
    const position = this.controller?.getPositionState?.()?.position;
    await lazy.TelaExternalPlayer.handoff(this.browser, { position });
  }

  onMicrophoneMuteToggle() {
    const shouldMute = this.element.hasAttribute("mic-muted")
      ? "webrtc:UnmuteMicrophone"
      : "webrtc:MuteMicrophone";

    this.browser.browsingContext.currentWindowGlobal
      .getActor("WebRTC")
      .sendAsyncMessage(shouldMute);
    this.element.toggleAttribute("mic-muted");
  }

  onCameraMuteToggle() {
    const shouldMute = this.element.hasAttribute("camera-muted")
      ? "webrtc:UnmuteCamera"
      : "webrtc:MuteCamera";

    this.browser.browsingContext.currentWindowGlobal
      .getActor("WebRTC")
      .sendAsyncMessage(shouldMute);
    this.element.toggleAttribute("camera-muted");
  }

  onClose() {
    if (this.controller) {
      this.controller.pause("user");
    } else {
      const webRTC =
        this.browser.browsingContext.currentWindowGlobal.getActor("WebRTC");
      webRTC.sendAsyncMessage("webrtc:UnmuteMicrophone");
      webRTC.sendAsyncMessage("webrtc:UnmuteCamera");
    }

    this.destroy();
  }

  destroy() {
    this.manager.trace(`destroy ${this.#label}`);
    if (this.controller && this.#controllerListeners) {
      for (const [event, listener] of Object.entries(
        this.#controllerListeners,
      )) {
        this.controller.removeEventListener(event, listener);
      }
      this.#controllerListeners = null;
    }

    if (this.#updateInterval) {
      clearInterval(this.#updateInterval);
      this.#updateInterval = null;
    }
    if (this.#tabTimeout) {
      clearTimeout(this.#tabTimeout);
      this.#tabTimeout = null;
    }
    clearInterval(this.#fullscreenWatch);
    this.#fullscreenWatch = null;

    const { element } = this;
    if (element.hidden) {
      element.remove();
    } else {
      // Animate the card out instead of popping it away. It leaves the
      // flex flow immediately (so the remaining cards re-slot right away)
      // but stays anchored where it currently is while it sinks and fades.
      const barBottom =
        this.manager.mediaControlBar.getBoundingClientRect().bottom;
      element.style.bottom =
        barBottom - element.getBoundingClientRect().bottom + "px";
      element.setAttribute("zen-removing", "true");
      // Resolves once the exit transitions finish or get cancelled, and
      // immediately if they never start (e.g. reduced motion).
      Promise.allSettled(
        element.getAnimations().map((animation) => animation.finished),
      ).then(() => element.remove());
    }

    this.manager.onCardDestroyed(this);
  }
}

/**
 * Zen Media Controller, handles the stack of media control cards located at
 * the bottom of the sidebar. Each active media controller (and WebRTC
 * sharing session) gets its own card; cards stack behind each other and
 * expand upwards when hovering the container.
 */
class nsZenMediaController {
  #cards = new Map();
  // The ⋯ panel: { panel, browser, card } while one is built.
  #more = null;
  #cardTemplate = null;

  mediaControlBar = null;

  // "Open in reel / mpv" on a video's context menu, below Picture-in-Picture.
  #initExternalMenu() {
    lazy.TelaExternalPlayer.watch();
    const menu = document.getElementById("contentAreaContextMenu");
    if (!menu) {
      return;
    }
    const item = document.createXULElement("menuitem");
    item.id = "context-video-open-external";
    item.setAttribute("data-l10n-id", "zen-media-open-external");
    const anchor = document.getElementById("context-video-pictureinpicture");
    anchor ? anchor.after(item) : menu.append(item);
    menu.addEventListener("popupshowing", (event) => {
      if (event.target !== menu) {
        return;
      }
      const ctx = window.gContextMenu;
      item.hidden = !ctx?.onVideo || !Services.prefs.getBoolPref("zen.media.external.context-menu", true);
      document.l10n.setArgs(item, { player: lazy.TelaExternalPlayer.player });
    });
    // The same on the pop-out button's own right-click menu, which Firefox opens from
    // inside embedded players too. It names no frame: the tab's video is found as the
    // card's button finds it (TelaExternalPlayer.source).
    const pipMenu = document.getElementById("pictureInPictureToggleContextMenu");
    if (pipMenu) {
      const pipItem = item.cloneNode();
      pipItem.id = "context-pip-toggle-open-external";
      const sep = document.createXULElement("menuseparator");
      pipMenu.prepend(pipItem, sep);
      pipMenu.addEventListener("popupshowing", (event) => {
        if (event.target !== pipMenu) {
          return;
        }
        const off = !Services.prefs.getBoolPref("zen.media.external.context-menu", true);
        pipItem.hidden = sep.hidden = off;
        document.l10n.setArgs(pipItem, { player: lazy.TelaExternalPlayer.player });
      });
      pipItem.addEventListener("command", () => lazy.TelaExternalPlayer.handoff(window.gBrowser.selectedBrowser));
    }
    item.addEventListener("command", async () => {
      const ctx = window.gContextMenu;
      if (!ctx) {
        return;
      }
      const hint = { src: ctx.mediaURL, frame: ctx.contentData?.docLocation };
      await lazy.TelaExternalPlayer.handoff(ctx.browser, hint);
    });
  }

  // ---- reel: the urlbar icon, the menu of a site's rule, and the keyboard command
  #reelAction = null;
  #reelMenu = null;
  #reelBrowser = null;

  async #initReel() {
    lazy.TelaExternalPlayer.onVideo = (browser) => {
      if (browser === window.gBrowser?.selectedBrowser) {
        this.#reelSync();
      }
    };
    lazy.TelaExternalPlayer.onMenu = (browser, x, y) => this.#openReelMenu(browser, null, x, y);
    const icon = "data:image/svg+xml," + encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><path d='M4 3l9 5-9 5z' fill='#888'/></svg>",
    );
    const title = await document.l10n.formatValue("zen-reel-button-title");
    this.#reelAction = new lazy.PageActions.Action({
      id: "tela-reel",
      title,
      iconURL: icon,
      pinnedToUrlbar: true,
      disabled: true,
      onCommand: () => this.handoffSelectedVideo(),
      onLocationChange: (win) => {
        const browser = win.gBrowser?.selectedBrowser;
        if (browser) {
          lazy.TelaExternalPlayer.forgetVideos(browser);
        }
        this.#reelSync(win);
      },
    });
    lazy.PageActions.addAction(this.#reelAction);
    window.gBrowser?.tabContainer.addEventListener("TabSelect", () => this.#reelSync());
    // right-click on the urlbar icon opens the same menu as the video's own reel button
    document.addEventListener("contextmenu", (event) => {
      const id = window.BrowserPageActions?.urlbarButtonNodeIDForActionID("tela-reel");
      const button = event.target.closest?.("#" + id);
      if (button) {
        event.preventDefault();
        this.#openReelMenu(window.gBrowser.selectedBrowser, button, 0, 0);
      }
    }, true);
  }

  // The urlbar icon shows only while the selected tab holds a video.
  #reelSync(win = window) {
    const browser = win.gBrowser?.selectedBrowser;
    this.#reelAction?.setDisabled(!lazy.TelaExternalPlayer.hasVideo(browser), win);
  }

  // Alt+Shift+R and the urlbar icon: the selected tab's video goes to reel.
  handoffSelectedVideo() {
    const browser = window.gBrowser?.selectedBrowser;
    if (browser && lazy.TelaExternalPlayer.hasVideo(browser)) {
      lazy.TelaExternalPlayer.handoff(browser);
    }
  }

  #reelHost() {
    try {
      return new URL(this.#reelBrowser?.currentURI?.spec || "").hostname;
    } catch {
      return "";
    }
  }

  #buildReelMenu() {
    const menu = document.createXULElement("menupopup");
    menu.id = "telaReelMenu";
    const always = document.createXULElement("menuitem");
    always.setAttribute("type", "checkbox");
    always.addEventListener("command", () => {
      const host = this.#reelHost();
      if (host) {
        lazy.TelaExternalPlayer.setRule(host, { always: always.checked });
      }
    });
    const header = document.createXULElement("menuitem");
    header.setAttribute("disabled", "true");
    header.setAttribute("data-l10n-id", "zen-reel-after-header");
    menu.append(always, document.createXULElement("menuseparator"), header);
    for (const after of ["pause", "close", "keep"]) {
      const radio = document.createXULElement("menuitem");
      radio.setAttribute("type", "radio");
      radio.setAttribute("name", "telaReelAfter");
      radio.setAttribute("value", after);
      document.l10n.setAttributes(radio, "zen-reel-after-" + after);
      radio.addEventListener("command", () => {
        const host = this.#reelHost();
        if (host) {
          lazy.TelaExternalPlayer.setRule(host, { after });
        }
      });
      menu.append(radio);
    }
    menu.addEventListener("popupshowing", () => {
      const host = this.#reelHost();
      const rule = host ? lazy.TelaExternalPlayer.sites[host] : null;
      always.hidden = !host;
      always.checked = !!rule?.always;
      if (host) {
        document.l10n.setAttributes(always, "zen-reel-always", { host });
      }
      const after = rule?.after || (lazy.TelaExternalPlayer.pauseInBrowser ? "pause" : "keep");
      for (const radio of menu.querySelectorAll('menuitem[name="telaReelAfter"]')) {
        radio.setAttribute("checked", radio.getAttribute("value") === after ? "true" : "false");
      }
    });
    document.getElementById("mainPopupSet").append(menu);
    return menu;
  }

  #openReelMenu(browser, anchor, x, y) {
    this.#reelMenu ??= this.#buildReelMenu();
    this.#reelBrowser = browser;
    if (anchor) {
      this.#reelMenu.openPopup(anchor, "after_start", 0, 0, true, false);
    } else {
      this.#reelMenu.openPopupAtScreen(x, y, true);
    }
  }

  init() {
    if (!Services.prefs.getBoolPref("zen.mediacontrols.enabled", true)) {
      return;
    }

    this.mediaControlBar = document.querySelector(
      "#zen-media-controls-toolbar",
    );
    window.messageManager.loadFrameScript(
      "chrome://browser/content/zen-components/zen-media-frame.js",
      true,
    );
    this.#initExternalMenu();
    this.#initReel();
    Services.prefs.addObserver("zen.mediacontrols.show-on-own-tab", () => {
      for (const card of this.#cards.values()) {
        card.onTabSelect();
      }
    });
    window.messageManager.addMessageListener("ZenMedia:State", (msg) => {
      if (this.#more && msg.target === this.#more.browser) {
        this.#paintMore(msg.data);
      }
    });
    this.#cardTemplate = document.querySelector("#zen-media-card-template");
    // Front first; gZenCardStack slots these together with everyone else's.
    gZenCardStack.register(() =>
      this.#orderedCards.map((card) => card.element),
    );

    setInterval(() => {
      if (this.#cards.size) {
        this.#watchdog();
      }
    }, 4000);

    window.addEventListener("TabSelect", () => {
      for (const card of this.#cards.values()) {
        card.onTabSelect();
      }
      this.#restoreLostCards();
    });

    const onTabDiscardedOrClosed = this.onTabDiscardedOrClosed.bind(this);

    window.addEventListener("TabClose", onTabDiscardedOrClosed);
    window.addEventListener("TabBrowserDiscarded", onTabDiscardedOrClosed);

    window.addEventListener("TabAttrModified", (event) => {
      if (!event.detail.changed.includes("soundplaying")) {
        return;
      }
      const tab = event.target;
      if (!tab.hasAttribute("soundplaying")) {
        this.onAudioPlaybackStopped();
        return;
      }
      this.onAudioPlaybackStarted(tab.linkedBrowser);
    });
  }

  onAudioPlaybackStarted(browser) {
    // The card is created right away (while the controller is fresh) but
    // only shown if the media is still playing a moment later, so short
    // sounds (e.g. notification pings) never reveal it.
    setTimeout(() => {
      const card = this.#cardForBrowser(browser);
      if (!card || card.isSharing) {
        return;
      }
      if (card.controller.isPlaying) {
        card.refreshVisibility();
      } else if (card.element.hidden) {
        // The sound was over before ever being shown (e.g. a notification
        // ping): drop the card instead of keeping a ghost around.
        card.destroy();
      }
    }, 1000);

    this.activateMediaControls(
      browser.browsingContext?.mediaController,
      browser,
    );
  }

  onAudioPlaybackStopped() {
    for (const card of this.#cards.values()) {
      card.updateMuteState();
    }
  }

  get frontCard() {
    return this.#orderedCards.find((card) => !card.element.hidden) ?? null;
  }

  get #orderedCards() {
    /* Playing media in front, then newest. Newest alone let a paused card
       from another tab bury the video actually playing (watchdog, 10-09). */
    const newest = Array.from(this.#cards.values()).reverse();
    const live = (c) => c.isSharing || c.controller?.isPlaying;
    return [...newest.filter(live), ...newest.filter((c) => !live(c))];
  }

  get #sharingCard() {
    return (
      Array.from(this.#cards.values()).find((card) => card.isSharing) ?? null
    );
  }

  #cardForBrowser(browser) {
    return (
      Array.from(this.#cards.values()).find(
        (card) => card.browser.browserId === browser.browserId,
      ) ?? null
    );
  }

  activateMediaControls(mediaController, browser) {
    if (
      !mediaController?.isActive ||
      this.#cards.has(mediaController.id) ||
      // Never stack more than one card for the same browser: sites that
      // activate a fresh controller for every sound they play (e.g.
      // notification pings) keep their one card.
      this.#cardForBrowser(browser)
    ) {
      return;
    }

    this.#addCard(mediaController.id, browser, mediaController);
  }

  activateMediaDeviceControls(browser) {
    if (
      !browser?.browsingContext.currentWindowGlobal.hasActivePeerConnections()
    ) {
      return;
    }

    this.#sharingCard?.destroy();
    this.#addCard(`sharing-${browser.browserId}`, browser);
  }

  updateMediaSharing(data) {
    if (!this.mediaControlBar) {
      return;
    }

    const { windowId, showCameraIndicator, showMicrophoneIndicator } = data;
    const shouldShow = showCameraIndicator || showMicrophoneIndicator;

    for (const browser of window.gBrowser.browsers) {
      if (browser.innerWindowID !== windowId) {
        continue;
      }

      const sharingCard = this.#sharingCard;
      const isSharingBrowser =
        sharingCard?.browser.browserId === browser.browserId;

      if (shouldShow && !isSharingBrowser) {
        const webRTC =
          browser.browsingContext.currentWindowGlobal.getActor("WebRTC");
        webRTC.sendAsyncMessage("webrtc:UnmuteMicrophone");
        webRTC.sendAsyncMessage("webrtc:UnmuteCamera");

        this.activateMediaDeviceControls(browser);
      } else if (!shouldShow && isSharingBrowser) {
        sharingCard.destroy();
      }

      break;
    }
  }

  onTabDiscardedOrClosed(event) {
    const { linkedBrowser } = event.target;
    if (!linkedBrowser) {
      return;
    }

    for (const card of Array.from(this.#cards.values())) {
      if (card.browser.browserId === linkedBrowser.browserId) {
        card.destroy();
      }
    }
  }

  closeAllCards() {
    for (const card of Array.from(this.#cards.values())) {
      card.destroy();
    }
  }

  onCardVisibilityChanged() {
    this.#updateStack();
    this.#refreshToolbarVisibility();
  }

  #trace = [];
  recentTrace(n = 12) {
    return this.#trace.slice(-n);
  }
  trace(what) {
    this.#trace.push(`${Math.round(performance.now())} ${what}`);
    if (this.#trace.length > 200) {
      this.#trace.shift();
    }
  }

  /* A playing card that should show but cannot be seen is written to
     zen-media-watchdog.jsonl in the profile, then repaired. It vanished for
     the user and could not be reproduced, so the browser records it itself. */
  #suspect = null;
  #watchdog() {
    const want = this.#unseen();
    if (!want) {
      this.#suspect = null;
      return;
    }
    // Twice in a row, so a hide or show still animating is never counted.
    if (!this.#suspect) {
      this.#suspect = true;
      return;
    }
    this.#suspect = null;
    const entry = this.#snapshot(want);
    this.#repair(want);
    setTimeout(() => {
      entry.repaired = !this.#unseen();
      this.#record(entry);
    }, 800);
  }

  #unseen() {
    const tb = document.getElementById("navigator-toolbox");
    if (
      document.documentElement.hasAttribute("inDOMFullscreen") ||
      (tb && tb.getBoundingClientRect().right <= 20)
    ) {
      return null;
    }
    const want = Array.from(this.#cards.values()).filter(
      (c) => (c.isSharing || c.controller?.isPlaying) && c.shouldBeVisible,
    );
    if (!want.length) {
      return null;
    }
    const bar = this.mediaControlBar;
    const barBox = bar.getBoundingClientRect();
    const seen = (c) => {
      const el = c.element;
      if (el.hidden || el.matches("[zen-hiding], [zen-removing], [stack-overflow]")) {
        return false;
      }
      const r = el.getBoundingClientRect();
      const cs = window.getComputedStyle(el);
      return (
        r.height >= 8 &&
        Number(cs.opacity) > 0.2 &&
        cs.visibility === "visible" &&
        r.bottom > barBox.top + 4 &&
        r.top < barBox.bottom - 4
      );
    };
    return !bar.hidden && barBox.height >= 8 && want.some(seen) ? null : want;
  }

  #snapshot(want) {
    const box = (el) => {
      const r = el.getBoundingClientRect();
      const cs = window.getComputedStyle(el);
      return {
        tag: el.id || String(el.className).slice(0, 40),
        attrs: Array.from(el.attributes, (a) => a.name).join(" "),
        rect: [r.left, r.top, r.width, r.height].map(Math.round),
        clientHeight: el.clientHeight,
        display: cs.display,
        visibility: cs.visibility,
        opacity: cs.opacity,
      };
    };
    const bar = this.mediaControlBar;
    const chain = [];
    for (let el = bar.parentElement; el && el.id !== "navigator-toolbox"; el = el.parentElement) {
      chain.push(box(el));
    }
    const tb = document.getElementById("navigator-toolbox");
    return {
      at: new Date().toISOString(),
      compact: window.gZenCompactModeManager?.preference,
      toolbox: tb && box(tb),
      bar: box(bar),
      barVars: ["--zen-media-collapsed-height", "--zen-media-expanded-height", "--zen-media-reveal"]
        .map((v) => `${v}=${bar.style.getPropertyValue(v)}`),
      cards: Array.from(this.#cards.values(), (c) => ({
        ...box(c.element),
        wanted: want.includes(c),
        playing: c.controller?.isPlaying,
        shouldBeVisible: c.shouldBeVisible,
        title: (c.browser?.contentTitle || "").slice(0, 30),
      })),
      chain,
      trace: this.#trace.slice(),
    };
  }

  #repair(want) {
    for (const c of want) {
      c.element.removeAttribute("zen-hiding");
      c.element.hidden = false;
    }
    this.mediaControlBar.removeAttribute("hidden");
    this.mediaControlBar.style.removeProperty("--zen-media-collapsed-height");
    this.onCardVisibilityChanged();
  }

  async #record(entry) {
    const path = PathUtils.join(PathUtils.profileDir, "zen-media-watchdog.jsonl");
    try {
      if ((await IOUtils.stat(path)).size > 256 * 1024) {
        return;
      }
    } catch {}
    await IOUtils.writeUTF8(path, JSON.stringify(entry) + "\n", { mode: "appendOrCreate" });
  }

  onCardDestroyed(card) {
    for (const [key, existing] of this.#cards) {
      if (existing === card) {
        this.#cards.delete(key);
        break;
      }
    }
    this.onCardVisibilityChanged();
    setTimeout(() => this.#restoreLostCards(), 1500);
  }

  /* Cards are only made when a tab starts playing, so one lost while the tab
     kept playing never came back. Any tab still playing without a card gets
     it again; closing a card pauses the media, so that stays closed. */
  #restoreLostCards() {
    for (const tab of gBrowser.tabs) {
      const browser = tab.linkedBrowser;
      if (!tab.hasAttribute("soundplaying") || this.#cardForBrowser(browser)) {
        continue;
      }
      const controller = browser?.browsingContext?.mediaController;
      if (controller?.isActive && controller.isPlaying) {
        this.trace("restore lost card");
        this.activateMediaControls(controller, browser);
        this.#cardForBrowser(browser)?.refreshVisibility();
      }
    }
  }

  #addCard(key, browser, controller = null) {
    const element = this.#createCardElement();
    let card;
    try {
      card = new ZenMediaCard(this, element, browser, controller);
    } catch (e) {
      console.error("Failed to create media card", e);
      // The controller went away while the card was being set up.
      element.remove();
      return null;
    }
    this.#cards.set(key, card);
    element.setAttribute("zen-owner", browser.browserId);
    this.trace(`add ${key}`);
    if (controller) {
      // Media cards start hidden and appear via the delayed check in
      // onAudioPlaybackStarted or on tab switch, like the original bar;
      // sharing cards show right away.
      card.element.hidden = true;
    } else {
      card.refreshVisibility();
    }
    this.onCardVisibilityChanged();
    return card;
  }

  #createCardElement() {
    const fragment = this.#cardTemplate.content.cloneNode(true);
    const element = fragment.firstElementChild;
    this.mediaControlBar.appendChild(fragment);
    return element;
  }

  #updateStack() {
    gZenCardStack.layout();
  }

  #refreshToolbarVisibility() {
    if (gZenCardStack.occupied) {
      this.showMediaControls();
    } else {
      this.hideMediaControls();
    }
  }

  /* The bar fades out before it is hidden. A card returning mid-fade used to
     leave it unhidden at opacity 0: present, measured "visible", never drawn,
     and show() skipped it as already shown. Now any show takes over the fade. */
  #barFade = null;

  hideMediaControls() {
    const bar = this.mediaControlBar;
    if (bar.hasAttribute("hidden") || this.#barFade?.out) {
      return;
    }
    this.trace("bar fade out");
    const fade = { out: true };
    fade.anim = gZenUIManager.motion.animate(bar, { opacity: [1, 0], y: [0, 10] }, { duration: 0.1 });
    this.#barFade = fade;
    fade.anim.then(() => {
      if (this.#barFade !== fade) {
        return;
      }
      this.#barFade = null;
      if (gZenCardStack.occupied) {
        this.#fadeBarIn("card came back while fading out");
        return;
      }
      bar.setAttribute("hidden", "true");
      gZenUIManager.updateTabsToolbar();
    });
  }

  showMediaControls() {
    const bar = this.mediaControlBar;
    if (!bar.hasAttribute("hidden")) {
      if (this.#barFade?.out || (!this.#barFade && +window.getComputedStyle(bar).opacity < 0.99)) {
        this.#fadeBarIn("show while faded");
      }
      return;
    }

    bar.removeAttribute("hidden");
    window.requestAnimationFrame(() => {
      const front = gZenCardStack.cards()[0];
      if (!front) {
        bar.setAttribute("hidden", "true");
        return;
      }

      gZenCardStack.measure(front);
      bar.style.opacity = 0;
      gZenUIManager.updateTabsToolbar();
      this.#fadeBarIn();

      for (const card of this.#cards.values()) {
        card.updateLabelOverflows();
      }
    });
  }

  #fadeBarIn(why) {
    const bar = this.mediaControlBar;
    if (why) {
      this.trace(`bar fade in: ${why}`);
    }
    this.#barFade?.anim?.stop?.();
    const from = Math.min(1, +window.getComputedStyle(bar).opacity || 0);
    const fade = { out: false };
    fade.anim = gZenUIManager.motion.animate(bar, { opacity: [from, 1], y: [10 * (1 - from), 0] }, {});
    this.#barFade = fade;
    fade.anim.then(() => {
      if (this.#barFade === fade) {
        this.#barFade = null;
      }
    });
  }

  /* Last line of defence, from the 5s mirror: unhidden, holding cards, no
     fade running, yet transparent. Logged, then healed. */
  healBar() {
    const bar = this.mediaControlBar;
    if (!bar || bar.hasAttribute("hidden") || this.#barFade || !gZenCardStack.occupied) {
      return false;
    }
    if (+window.getComputedStyle(bar).opacity >= 0.05) {
      return false;
    }
    this.#fadeBarIn("healed a stuck transparent bar");
    return true;
  }

  /* ---- ⋯ panel: the site's own volume and speed, plus small actions.
     A panel rather than a menupopup: range inputs do not render in a menu. */

  static RATES = [0.75, 1, 1.25, 1.5, 2];

  openMorePanel(card, anchor) {
    const panel = this.#ensureMore();
    this.#more.browser = card.browser;
    this.#more.card = card;
    // Which tab this controls: several cards can be in the stack.
    const tab = gBrowser.getTabForBrowser(card.browser);
    this.#more.title.textContent = tab?.label || "";
    this.#more.icon.src = tab?.getAttribute("image") || "chrome://global/skin/icons/defaultFavicon.svg";
    this.#paintMore({ source: "none", volume: null, rate: 1 });
    // Opens toward the middle of the window: the card sits at a sidebar edge.
    const box = anchor.getBoundingClientRect();
    const left = box.left + box.width / 2 < window.innerWidth / 2;
    panel.openPopup(anchor, left ? "before_start" : "before_end", 0, -4);
  }

  #ensureMore() {
    if (this.#more?.panel) {
      return this.#more.panel;
    }
    const HTML = "http://www.w3.org/1999/xhtml";
    const el = (tag, cls, l10n) => {
      const node = document.createElementNS(HTML, tag);
      if (cls) {
        node.className = cls;
      }
      if (l10n) {
        document.l10n.setAttributes(node, l10n);
      }
      return node;
    };
    const panel = document.createXULElement("panel");
    panel.id = "zen-media-more-panel";
    panel.setAttribute("noautofocus", "true");
    panel.setAttribute("type", "arrow");
    const body = el("div", "zen-media-more-body");

    const head = el("div", "zen-media-more-head");
    const icon = el("img", "zen-media-more-icon");
    const title = el("span", "zen-media-more-title");
    head.append(icon, title);

    const volRow = el("div", "zen-media-more-row");
    volRow.append(el("span", "zen-media-more-label", "zen-media-more-volume"));
    const volume = el("input", "zen-media-more-volume");
    volume.type = "range";
    volume.min = 0;
    volume.max = 100;
    volume.step = 1;
    const volValue = el("span", "zen-media-more-value");
    volume.addEventListener("input", () => {
      volValue.textContent = `${volume.value}%`;
      this.#sendMore("ZenMedia:SetVolume", { volume: Number(volume.value) });
    });
    volRow.append(volume, volValue);
    const source = el("p", "zen-media-more-source");

    const rateRow = el("div", "zen-media-more-row");
    rateRow.append(el("span", "zen-media-more-label", "zen-media-more-speed"));
    const rates = el("div", "zen-media-more-rates");
    for (const rate of nsZenMediaController.RATES) {
      const chip = el("button", "zen-media-more-rate");
      chip.type = "button";
      chip.dataset.rate = String(rate);
      chip.textContent = `${rate}×`;
      chip.addEventListener("click", () =>
        this.#sendMore("ZenMedia:SetRate", { rate }),
      );
      rates.append(chip);
    }
    rateRow.append(rates);

    const actions = el("div", "zen-media-more-actions");
    const copy = el("button", "zen-media-more-action", "zen-media-more-copy");
    copy.type = "button";
    copy.addEventListener("click", () => {
      const url = this.#more.url || this.#more.browser?.currentURI?.spec;
      if (url) {
        Cc["@mozilla.org/widget/clipboardhelper;1"]
          .getService(Ci.nsIClipboardHelper)
          .copyString(url);
      }
      panel.hidePopup();
    });
    const go = el("button", "zen-media-more-action", "zen-media-more-go");
    go.type = "button";
    go.addEventListener("click", () => {
      panel.hidePopup();
      this.#more.card?.onFocus();
    });
    actions.append(copy, go);

    body.append(volRow, source, rateRow, actions);
    panel.append(body);
    panel.addEventListener("popupshowing", () => window.gZenCardStack?.hold(true));
    panel.addEventListener("popupshown", () =>
      this.#sendMore("ZenMedia:Watch", { on: true }),
    );
    panel.addEventListener("popuphidden", () => {
      this.#sendMore("ZenMedia:Watch", { on: false });
      window.gZenCardStack?.hold(false);
    });
    document.getElementById("mainPopupSet").append(panel);
    body.prepend(head);
    this.#more = { panel, volume, volValue, source, rates, volRow, title, icon };
    return panel;
  }

  #sendMore(name, data) {
    try {
      this.#more?.browser?.messageManager?.sendAsyncMessage(name, data);
    } catch (ex) {
      console.error("[zen-media] more panel", ex);
    }
  }

  #paintMore(state) {
    const more = this.#more;
    if (!more?.panel) {
      return;
    }
    more.url = state.url || "";
    const has = Number.isFinite(state.volume);
    more.volRow.toggleAttribute("disabled", !has);
    more.volume.disabled = !has;
    // Not while it is being dragged: the echo would fight the pointer.
    if (has && !more.volume.matches(":active")) {
      more.volume.value = state.volume;
      more.volValue.textContent = `${state.volume}%`;
    } else if (!has) {
      more.volValue.textContent = "";
    }
    document.l10n.setAttributes(
      more.source,
      `zen-media-more-source-${state.source || "none"}`,
    );
    for (const chip of more.rates.children) {
      chip.toggleAttribute(
        "selected",
        Math.abs(Number(chip.dataset.rate) - state.rate) < 0.01,
      );
    }
  }
}

window.gZenMediaController = new nsZenMediaController();
