// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at http://mozilla.org/MPL/2.0/.

/* Content side of the media card's ⋯ panel: the page's own volume and speed.
 *
 * YouTube Music is driven through its own slider: the player's volume sits
 * on a loudness curve under it (slider 40 = player 13), and setting the player
 * left the slider where it was. YouTube's player API does move its controls.
 * Everywhere else the page's media elements are set directly. Idle until the
 * panel asks. */

/* eslint-env mozilla/frame-script */

(function () {
  const YT = /(^|\.)youtube\.com$/;
  const host = () => (content?.location?.hostname || "").replace(/^www\./, "");

  // YouTube Music's player-bar slider, the value its user actually sees.
  function musicSlider() {
    if (host() !== "music.youtube.com") {
      return null;
    }
    return content.document.querySelector("ytmusic-player-bar #volume-slider")?.wrappedJSObject ||
      content.document.querySelector("#volume-slider")?.wrappedJSObject || null;
  }

  // The site's player, when it has one we know how to drive.
  function player() {
    if (!YT.test(content?.location?.hostname || "")) {
      return null;
    }
    const p = content.document.getElementById("movie_player")?.wrappedJSObject;
    return p && typeof p.getVolume === "function" && typeof p.setVolume === "function"
      ? p
      : null;
  }

  // Playing elements first: a page can hold several, and only one is heard.
  function elements() {
    const all = [...(content?.document?.querySelectorAll("video, audio") || [])];
    const playing = all.filter((el) => !el.paused);
    return playing.length ? playing : all;
  }

  function state() {
    const p = player();
    const slider = musicSlider();
    const els = elements();
    let volume = null;
    let muted = false;
    let rate = 1;
    if (slider) {
      volume = Number(slider.value);
      muted = !!p?.isMuted?.();
      rate = Number(p?.getPlaybackRate?.() ?? els[0]?.playbackRate ?? 1);
    } else if (p) {
      volume = Number(p.getVolume());
      muted = !!p.isMuted?.();
      rate = Number(p.getPlaybackRate?.() ?? 1);
    } else if (els.length) {
      volume = Math.round(els[0].volume * 100);
      muted = els[0].muted;
      rate = els[0].playbackRate;
    }
    let url = content.location.href;
    // A YouTube link at the current second; Music has no such link.
    if (p && host() === "youtube.com") {
      const at = Math.floor(Number(p.getCurrentTime?.() || 0));
      const id = p.getVideoData?.()?.video_id;
      if (id) {
        url = `https://youtu.be/${id}${at ? `?t=${at}` : ""}`;
      }
    }
    // The live playhead: Gecko's position state is only what the page last set.
    let position = null;
    let duration = null;
    if (p?.getCurrentTime) {
      position = Number(p.getCurrentTime());
      duration = Number(p.getDuration?.());
    } else if (els.length) {
      position = els[0].currentTime;
      duration = els[0].duration;
    }
    return {
      source: slider || p ? "site" : els.length ? "page" : "none",
      position: Number.isFinite(position) ? position : null,
      duration: Number.isFinite(duration) && duration > 0 ? duration : null,
      volume: Number.isFinite(volume) ? Math.round(volume) : null,
      muted,
      rate: Number.isFinite(rate) ? rate : 1,
      url,
    };
  }

  const send = () => {
    try {
      sendAsyncMessage("ZenMedia:State", state());
    } catch (ex) {
      void ex;
    }
  };

  function setVolume(value) {
    const v = Math.min(100, Math.max(0, Math.round(Number(value))));
    if (!Number.isFinite(v)) {
      return;
    }
    const p = player();
    const slider = musicSlider();
    if (slider) {
      // What a drag on the slider does: the site maps it onto the player.
      slider.value = v;
      slider.dispatchEvent(new content.CustomEvent("change", { bubbles: true }));
      if (v > 0 && p?.isMuted?.()) {
        p.unMute?.();
      }
      return;
    }
    if (p) {
      p.setVolume(v);
      if (v > 0 && p.isMuted?.()) {
        p.unMute?.();
      }
      return;
    }
    for (const el of elements()) {
      el.volume = v / 100;
      if (v > 0) {
        el.muted = false;
      }
    }
  }

  function setRate(value) {
    const r = Number(value);
    if (!(r >= 0.25 && r <= 4)) {
      return;
    }
    const p = player();
    if (p?.setPlaybackRate) {
      p.setPlaybackRate(r);
      return;
    }
    for (const el of elements()) {
      el.playbackRate = r;
    }
  }

  /* While the panel is open, the site's own slider moving shows in ours.
     volumechange does not bubble, so it is caught on the way down. */
  let watching = false;
  let pending = null;
  const onChange = () => {
    if (pending) {
      return;
    }
    pending = content.setTimeout(() => {
      pending = null;
      send();
    }, 60);
  };
  function watch(on) {
    if (on === watching) {
      return;
    }
    watching = on;
    for (const type of ["volumechange", "ratechange"]) {
      if (on) {
        addEventListener(type, onChange, true);
      } else {
        removeEventListener(type, onChange, true);
      }
    }
  }

  /* Plasma Browser Integration replaces the page's mediaSession.metadata and
     playbackState with accessors that never reach Firefox, so the media card
     and Firefox's own MPRIS player saw only the page title (no artist for a
     scrobbler). The page's value is copied into the real session: an Xray
     sees the native object, not the page's replacement. Runs only while
     something plays, and only on a page that has that replacement. */
  const MIRROR_MS = 1500;
  let mirrorTimer = null;
  let mirrored = "";
  function mirrorSession() {
    const page = content?.wrappedJSObject?.navigator?.mediaSession;
    if (!page || !Object.getOwnPropertyDescriptor(page, "metadata")) {
      return false;
    }
    const md = page.metadata;
    const art = md?.artwork ? [...md.artwork].map(a => ({
      src: String(a?.src || ""), sizes: String(a?.sizes || ""), type: String(a?.type || ""),
    })).filter(a => a.src) : [];
    const data = md ? {
      title: String(md.title || ""), artist: String(md.artist || ""),
      album: String(md.album || ""), artwork: art,
    } : null;
    const state = String(page.playbackState || "none");
    const sig = JSON.stringify([data, state]);
    if (sig !== mirrored) {
      mirrored = sig;
      const native = content.navigator.mediaSession;
      native.metadata = data
        ? new content.MediaMetadata(Cu.cloneInto(data, content))
        : null;
      if (["none", "paused", "playing"].includes(state)) {
        native.playbackState = state;
      }
    }
    return true;
  }
  function mirrorTick() {
    try {
      const hooked = mirrorSession();
      const playing = [...(content?.document?.querySelectorAll("video, audio") || [])]
        .some(el => !el.paused);
      if (!hooked || !playing) {
        mirrorTimer?.cancel();
        mirrorTimer = null;
      }
    } catch (e) {
      void e;
    }
  }
  addEventListener("playing", () => {
    if (!Services.prefs.getBoolPref("zen.mediacontrols.mirror-session", true) || mirrorTimer) {
      return;
    }
    mirrorTick();
    mirrorTimer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    mirrorTimer.initWithCallback(() => mirrorTick(), MIRROR_MS, Ci.nsITimer.TYPE_REPEATING_SLACK);
  }, true);

  addMessageListener("ZenMedia:Query", () => send());
  // "Open in another app": the playing video's own address, when it has a real one
  // (a blob: is a MediaSource stream, useless outside this page), and where it is.
  addMessageListener("ZenMedia:Source", () => {
    const v = elements().find((el) => el.localName === "video") || elements()[0];
    const src = v?.currentSrc || "";
    const s = state();
    sendAsyncMessage("ZenMedia:SourceReply", {
      src: /^https?:/.test(src) ? src : "",
      page: s.url || content.location.href,
      position: s.position ?? v?.currentTime ?? null,
    });
  });
  addMessageListener("ZenMedia:Watch", (msg) => {
    watch(!!msg.data?.on);
    if (msg.data?.on) {
      send();
    }
  });
  addMessageListener("ZenMedia:SetVolume", (msg) => {
    try {
      setVolume(msg.data?.volume);
    } catch (ex) {
      void ex;
    }
    send();
  });
  addMessageListener("ZenMedia:SetRate", (msg) => {
    try {
      setRate(msg.data?.rate);
    } catch (ex) {
      void ex;
    }
    send();
  });
})();
