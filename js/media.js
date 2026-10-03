"use strict";
var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
(() => {
  let player = null;
  let still = null;
  let inited = false;
  let loadSeq = 0;
  let pendingSeek = 0;
  let wantPlay = false;
  let currentLoad = 0;
  let sourceReady = true;
  const SEEK_COALESCE_MS = 40;
  let pendingSeekTo = null;
  let seekTimer;
  let lastSeekAt = 0;
  const el = /* @__PURE__ */ __name(() => {
    if (!player) {
      player = document.getElementById("media");
      if (!player) throw new Error("media: #media is not in the page");
    }
    return player;
  }, "el");
  const img = /* @__PURE__ */ __name(() => {
    if (!still) {
      still = document.getElementById("still");
      if (!still) throw new Error("media: #still is not in the page");
    }
    return still;
  }, "img");
  const listeners = {
    time: [],
    play: [],
    pause: [],
    ended: [],
    error: [],
    blocked: [],
    volume: []
  };
  const emit = /* @__PURE__ */ __name((key, payload) => listeners[key].slice().forEach((fn) => fn(payload)), "emit");
  const on = /* @__PURE__ */ __name((key, fn) => {
    const list = listeners[key] || (listeners[key] = []);
    list.push(fn);
    return () => listeners[key] = list.filter((f) => f !== fn);
  }, "on");
  const play = /* @__PURE__ */ __name(() => {
    try {
      const p = el().play();
      if (p && p.catch) {
        p.catch((err) => {
          if (err && err.name === "AbortError") return;
          emit("blocked", { error: err });
        });
      }
    } catch (err) {
      emit("blocked", { error: err });
    }
  }, "play");
  const pause = /* @__PURE__ */ __name(() => el().pause(), "pause");
  const startIfWanted = /* @__PURE__ */ __name(() => {
    if (!wantPlay) return;
    wantPlay = false;
    play();
  }, "startIfWanted");
  let live = [];
  function dropLive() {
    for (const [name, fn] of live) el().removeEventListener(name, fn);
    live = [];
  }
  __name(dropLive, "dropLive");
  function onSuperseded(events, handler) {
    const seq = currentLoad;
    const wrapped = /* @__PURE__ */ __name((e) => {
      if (seq !== currentLoad) return;
      dropLive();
      handler(e);
    }, "wrapped");
    for (const name of events) {
      el().addEventListener(name, wrapped);
      live.push([name, wrapped]);
    }
  }
  __name(onSuperseded, "onSuperseded");
  let heldVolume = null;
  let heldMuted = null;
  const liveEl = /* @__PURE__ */ __name(() => document.querySelector("video, audio"), "liveEl");
  function applyHeld() {
    for (const target of [el(), liveEl()]) {
      if (!target) continue;
      if (heldVolume !== null) target.volume = heldVolume;
      if (heldMuted !== null) target.muted = heldMuted;
    }
  }
  __name(applyHeld, "applyHeld");
  const paintBar = /* @__PURE__ */ __name((which, ratio) => {
    const pct = (ratio * 100).toFixed(2) + "%";
    if (which === "volume") {
      const input = document.getElementById("volume");
      if (input) input.style.setProperty("--mt-fill", pct);
      return;
    }
    const node = document.querySelector("media-time-slider");
    if (node) node.style.setProperty("--mt-fill", pct);
  }, "paintBar");
  function init() {
    if (inited) return;
    inited = true;
    el();
    img();
    el().keyShortcuts = {};
    el().addEventListener("time-update", (e) => {
      if (!sourceReady) return;
      emit("time", { currentTime: e.detail?.currentTime ?? el().currentTime });
    });
    el().addEventListener("play", () => emit("play", void 0));
    el().addEventListener("pause", () => emit("pause", void 0));
    el().addEventListener(
      "volume-change",
      (e) => emit("volume", { volume: e.detail?.volume ?? el().volume })
    );
    el().addEventListener("ended", () => emit("ended", void 0));
    el().addEventListener("error", () => emit("error", void 0));
    img().addEventListener("error", () => {
      if (img().hidden) return;
      emit("error", { kind: "image" });
    });
  }
  __name(init, "init");
  window.MediaBridge = {
    init,
    on,
    /* The prop is `src` and it accepts an array of {src, type}. Two things
       matter here, both learned the hard way:
         - the MIME type is required: a blob: URL has no extension for the
           library to infer a provider from;
         - the load strategy must be `eager`, otherwise the default `visible`
           waits for an IntersectionObserver on a provider that does not exist
           yet, and nothing is ever created. */
    load(item, kind, autoplay) {
      dropLive();
      currentLoad = ++loadSeq;
      sourceReady = false;
      pendingSeek = item.position || 0;
      wantPlay = !!autoplay && kind !== "image";
      pause();
      el().src = [];
      img().hidden = true;
      img().removeAttribute("src");
      if (kind === "image") {
        el().autoPlay = false;
        img().hidden = false;
        img().src = item.url;
        return;
      }
      onSuperseded(["loaded-metadata", "can-play"], () => {
        sourceReady = true;
        if (pendingSeek > 0) {
          el().currentTime = pendingSeek;
          pendingSeek = 0;
        }
        applyHeld();
        startIfWanted();
      });
      el().load = "eager";
      el().src = [{ src: item.url, type: item.mime || "video/mp4" }];
      el().viewType = kind;
      applyHeld();
      el().autoPlay = !!autoplay;
      if (autoplay) el().paused = false;
    },
    /* Clearing the playlist.
    
           The per-load listeners are dropped, as they are between loads, but the
           ones that describe the *element* rather than a load are put straight back.
           Dropping them permanently is what made the volume and mute controls die
           after the clear button was pressed: they still rendered, still took
           clicks, and no longer changed anything, because nothing was listening to
           the media element any more.
    
           The timeline is repainted at zero for the same reason. It is the only
           piece of state on screen that does not belong to any file, and left alone
           it sits at the last position played, which reads as a real position on a
           timeline that no longer has one. */
    clear() {
      dropLive();
      currentLoad = ++loadSeq;
      sourceReady = false;
      pause();
      wantPlay = false;
      pendingSeek = 0;
      el().src = [];
      el().autoPlay = false;
      img().hidden = false;
      img().removeAttribute("src");
      paintBar("time", 0);
      applyHeld();
      paintBar("volume", this.muted ? 0 : this.volume);
    },
    /* The library's own sliders keep correct state and ARIA values, but their
       fill property stays at 0% in v1.15.6, so the app paints them. Locating
       them belongs here: they are <media-*> elements, and app.js is not supposed
       to know that. Dragging, keyboard control and accessibility stay with
       the library. */
    paintTime(ratio) {
      paintBar("time", ratio);
    },
    paintVolume(ratio) {
      paintBar("volume", ratio);
    },
    /* True when the key belongs to one of the library's sliders, which handle
       their own arrow keys. */
    ownsArrowKey(target) {
      return !!target?.closest?.("media-time-slider, media-volume-slider");
    },
    /* Fullscreen state, without the app touching document.fullscreenElement.
    
           Read from the shell when a shell offers it. WebKitGTK has no HTML
           Fullscreen API, so there `document.fullscreenElement` is permanently
           null and the button can never show what it did. The browser build has no
           problem and keeps the HTML path. */
    get fullscreen() {
      const shell = window.MediaFullscreen;
      if (shell && typeof shell === "object") return !!shell.active;
      return !!document.fullscreenElement;
    },
    onFullscreenChange(fn) {
      const shell = window.MediaFullscreen;
      if (shell && typeof shell.onChange === "function") {
        shell.onChange(() => fn());
        return;
      }
      document.addEventListener("fullscreenchange", fn);
    },
    /* Identifies the current load. A pause during teardown is followed by a
       time-update carrying the OUTGOING track's time, and the app's handler
       would otherwise write it into the incoming item's resume position. */
    ticket() {
      return currentLoad;
    },
    get playing() {
      return !el().paused;
    },
    get currentTime() {
      return el().currentTime || 0;
    },
    get duration() {
      return el().duration;
    },
    get volume() {
      return heldVolume !== null ? heldVolume : el().volume;
    },
    get muted() {
      return heldMuted !== null ? heldMuted : el().muted;
    },
    get loop() {
      return el().loop;
    },
    play,
    pause,
    toggle() {
      if (el().paused) play();
      else pause();
    },
    /* Seeking is by keyframe, and a burst of seeks becomes one.
    
           Assigning `currentTime` asks the decoder for that exact frame, which means
           decoding from the previous keyframe to reach it. On a long file that is
           work enough to show as a black frame and a stalled picture - the flash
           that was reported here.
    
           `fastSeek` asks for the nearest keyframe instead: instant, no flash, and
           accurate to within about a second. For a ten-second skip that is the right
           trade.
    
           A burst is coalesced rather than queued. Holding an arrow key fires a seek
           on every repeat; each one cancelled the last, so the picture churned and
           arrived somewhere between the presses rather than where the user was
           heading. Repeats accumulate onto the pending target instead, so holding
           the key still travels - it just does it in one jump.
    
           The first press of a gesture is applied immediately. Coalescing everything
           would make a single deliberate press feel broken, which is worse than the
           problem being solved. */
    seekBy(delta) {
      const media = el();
      const d = media.duration;
      if (!Number.isFinite(d)) return;
      const now = Date.now();
      const repeating = seekTimer !== void 0 && now - lastSeekAt < SEEK_COALESCE_MS;
      const base = repeating && pendingSeekTo !== null ? pendingSeekTo : media.currentTime;
      const target = Math.min(Math.max(base + delta, 0), d);
      const apply = /* @__PURE__ */ __name((to) => {
        try {
          if (typeof media.fastSeek === "function") media.fastSeek(to);
          else media.currentTime = to;
        } catch {
          try {
            media.currentTime = to;
          } catch {
          }
        }
      }, "apply");
      lastSeekAt = now;
      if (!repeating) {
        if (seekTimer !== void 0) clearTimeout(seekTimer);
        seekTimer = void 0;
        pendingSeekTo = null;
        apply(target);
        return;
      }
      pendingSeekTo = target;
      if (seekTimer !== void 0) clearTimeout(seekTimer);
      seekTimer = setTimeout(() => {
        const to = pendingSeekTo;
        seekTimer = void 0;
        pendingSeekTo = null;
        if (to !== null) apply(to);
      }, SEEK_COALESCE_MS);
    },
    setVolume(v) {
      const next = Math.min(1, Math.max(0, v));
      heldVolume = next;
      if (next > 0) heldMuted = false;
      applyHeld();
      emit("volume", { volume: next });
    },
    toggleMute() {
      heldMuted = !this.muted;
      applyHeld();
      emit("volume", { volume: this.volume });
    },
    setLoop(on2) {
      el().loop = !!on2;
    },
    /* Fullscreen the whole stage, not the player element: the player is a
           sibling of the playlist panel, so fullscreening only the player would
           hide the panel and the control bar.
    
           Through the shell where one offers it, because the HTML API does not
           exist on WebKitGTK - see js/source-tauri.js. The browser build is
           unaffected and still uses the page. */
    async toggleFullscreen() {
      const shell = window.MediaFullscreen;
      if (shell && typeof shell.toggle === "function") {
        try {
          await shell.toggle();
        } catch (err) {
          console.warn("[media] the window refused fullscreen:", err instanceof Error ? err.message : err);
        }
        return;
      }
      const target = document.getElementById("stage");
      try {
        const p = document.fullscreenElement ? document.exitFullscreen() : target?.requestFullscreen?.();
        if (p && p.catch) {
          p.catch((err) => {
            console.warn("[media] fullscreen request failed:", err && err.name, err && err.message);
          });
        }
      } catch (err) {
        console.warn("[media] fullscreen threw:", err instanceof Error ? err.message : err);
      }
    }
  };
})();
//# sourceMappingURL=media.js.map
