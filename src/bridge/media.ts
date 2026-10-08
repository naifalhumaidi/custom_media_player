import type { BridgeEvents } from '../types.js';

/* Vidstack boundary — the only file that knows a media library exists.

   The real boundary is narrower than "nothing outside this file mentions the
   library": the markup in index.html is built from <media-*> custom elements,
   and that is unavoidable given the design. What is hidden here is all
   *runtime* knowledge — the property names, the event names, the load
   lifecycle, and the quirks below. Swapping the library means rewriting this
   file and the markup, not app.js.

   State changes go through the element's own props and methods rather than
   hand-dispatched `media-*-request` events, which the library ignores unless it
   dispatches them itself through its remote. */

(() => {
  let player: any = null;
  let still: HTMLImageElement | null = null;
  let inited = false;

  /* ---- load sequencing -------------------------------------------------
     Every load takes a ticket. Media events arrive asynchronously, so a
     `loaded-metadata` from a provider that has already been replaced would
     otherwise apply its seek and its autoplay to whatever is on screen now -
     which is how a resume position ends up on the wrong file. Handlers compare
     the ticket they were registered with against the current one and bail. */
  let loadSeq = 0;
  let pendingSeek = 0;
  let wantPlay = false;
  let currentLoad = 0;
  /* False from the moment a source is replaced until the NEW provider reports
     its metadata. A real pause during teardown is followed by a time-update
     carrying the OUTGOING track's time, and the app - which has already moved
     its index to the new item - would record it as the new track's resume
     position. Only this file knows when the old provider is really gone. */
  let sourceReady = true;

  /* How long repeated seeks are collapsed, in ms. Long enough to absorb a key
     repeat, short enough that a deliberate second press still feels separate. */
  const SEEK_COALESCE_MS = 40;

  /* The retry that checks a play actually started, and its bounds. */
  const RESCUE_MS = 120;
  const RESCUE_MAX_PASSES = 25;
  let rescueHandle: ReturnType<typeof setInterval> | null = null;
  let rescuePasses = 0;
  /* The URL of the item the bridge asked to play, and the load that asked for
     it. Together they answer "is this element the one under test?" */
  let wantedUrl = '';
  let wantedLoad = 0;
  const stopRescue = () => {
    if (!rescueHandle) return;
    clearInterval(rescueHandle);
    rescueHandle = null;
    rescuePasses = 0;
  };

  /* One seek in flight, at most: the target waiting to be applied, and the
     handle that will apply it. */
  let pendingSeekTo: number | null = null;
  let seekTimer: ReturnType<typeof setTimeout> | undefined;
  let lastSeekAt = 0;

  /* resolved lazily so the bridge is safe to touch before init() */
  /* The two elements the whole bridge is built on. Both are in index.html, and
     init() runs before anything here is reached, so they are resolved once and
     asserted rather than re-queried and null-checked at forty call sites. */
  const el = (): any => {
    if (!player) {
      player = document.getElementById('media');
      if (!player) throw new Error('media: #media is not in the page');
    }
    return player;
  };
  const img = (): HTMLImageElement => {
    if (!still) {
      still = document.getElementById('still') as HTMLImageElement;
      if (!still) throw new Error('media: #still is not in the page');
    }
    return still;
  };

  type Listener<K extends keyof BridgeEvents> = (payload: BridgeEvents[K]) => void;
  const listeners: { [K in keyof BridgeEvents]: Listener<K>[] } = {
    time: [], play: [], pause: [], ended: [], error: [], blocked: [], volume: [],
  };
  const emit = (key, payload) => listeners[key].slice().forEach((fn) => fn(payload));
  const on = (key, fn) => {
    const list = listeners[key] || (listeners[key] = []);
    list.push(fn);
    return () => (listeners[key] = list.filter((f) => f !== fn));
  };

  /* An AbortError just means the load was superseded, which the next load()
     already handles. Anything else is a real failure - most often autoplay
     being refused because there is no user gesture yet - and the user has to
     hear about it, or the interface sits there claiming to be playing. */
  /* Ask the element to play, and say whether it took.

     Only ever a fallback. Two things make the element the wrong first choice:
     the player keeps a copy of the play state that drifts out of step with the
     media, and while a track is changing there are briefly two elements and only
     the player knows which is current. Asking the wrong one plays the clip being
     left behind. */
  const askElement = (): boolean => {
    const live = liveEl();
    if (!live) return false;
    /* Only ever the element the bridge itself asked to play.

       `sourceReady` was the guard for this and it was wrong. It says the library
       has reported metadata for the current source, which is not the same
       question as "is this element the one being played". For an audio source
       the two came apart, the rescue stood down, and a five second tone sat at
       0:00 with the app convinced it had started. The URL is the direct answer:
       it is the thing the bridge assigned, so if the element is carrying it, it
       is the element in question. */
    if (!wantedUrl || live.currentSrc !== wantedUrl) return false;
    if (live.readyState < 2) return false;
    try {
      live.play();
      return true;
    } catch {
      return false;
    }
  };

  /* Play, then keep checking that it happened.

     The player's transport goes stale after a few track changes in one window:
     `play()` returns a promise that RESOLVES and the video does not move. Not a
     rejection - a success that did nothing - so no catch block anywhere can see
     it, and every play/pause in the app reaches a dead call that looks like it
     worked. Measured in a real window: `player.play()` resolved, `video.play()`
     on the element started it, every time.

     A promise that resolves is therefore not trusted. The element's own play
     state is the check.

     It retries rather than checking once. A single check is a coin toss on WHEN
     it lands: the element is briefly below HAVE_CURRENT_DATA straight after a
     seek, and a check that arrives in that window concludes nothing is wrong and
     never looks again - which is how an audio clip sat at 0:00, paused, with the
     app quite convinced it had started it. Each pass is a no-op once the element
     is playing, so the loop only does anything when the player's call really did
     nothing.

     `pause()` cancels it. Without that, pressing Space to pause while a rescue is
     outstanding would be undone by the next pass - a fix for "the play button does
     nothing" that introduced "the pause button does nothing".

     `duringLoad` keeps this out of the load's own autoplay, which is the
     library's to drive: it owns the provider and the ready lifecycle. A second
     play() arriving from underneath leaves the clip and the player disagreeing
     about whether it is running. Not hypothetical - with the rescue left on, the
     desktop walkthrough's Previous and Next stopped moving, because the rescue
     landed mid-load and started the outgoing element. */
  const play = (duringLoad = false) => {
    stopRescue();
    if (duringLoad) {
      try {
        const p = el().play();
        if (p && p.catch) {
          p.catch((err) => {
            if (err && err.name === 'AbortError') return;
            emit('blocked', { error: err });
          });
        }
      } catch (err) {
        emit('blocked', { error: err });
      }
      return;
    }

    /* Nothing to rescue once the element says it is already running. */
    const started = () => {
      const live = liveEl();
      return !!(live && !live.paused);
    };
    const pass = () => {
      if (!rescueHandle) return;
      if (started() || ++rescuePasses >= RESCUE_MAX_PASSES) {
        stopRescue();
        return;
      }
      /* A new load supersedes this attempt; there is nothing left to rescue. */
      if (wantedLoad !== currentLoad) {
        stopRescue();
        return;
      }
      askElement();
    };
    const rescue = () => {
      if (started()) return;
      if (rescueHandle) return;
      rescueHandle = setInterval(pass, RESCUE_MS);
    };
    try {
      const p = el().play();
      if (p && p.then) {
        p.then(rescue, (err) => {
          if (err && err.name === 'AbortError') return;
          rescue();
          emit('blocked', { error: err });
        });
      } else {
        rescue();
      }
    } catch (err) {
      rescue();
      emit('blocked', { error: err });
    }
  };

  const pause = () => {
    stopRescue();
    el().pause();
  };

  const startIfWanted = () => {
    if (!wantPlay) return;
    wantPlay = false;
    play(true);
  };

  /* A superseded load must not apply its seek or its autoplay to whatever is
     on screen by the time its events arrive. The handlers are installed per
     load and close over their own ticket; a listener registered once in
     init() could not tell which load an event belonged to, because the events
     carry no identity of their own. */
  let live: Array<[string, EventListener]> = [];

  /* A load that is replaced never gets to run its handler, so the handler
     cannot be the thing that cleans up. Every installed pair is tracked here
     and removed at the next load: skipping through a long playlist otherwise
     leaves thousands of closures on the player, all of which every later
     event is dispatched through. */
  function dropLive() {
    for (const [name, fn] of live) el().removeEventListener(name, fn);
    live = [];
  }

  function onSuperseded(events, handler) {
    const seq = currentLoad;
    const wrapped = (e) => {
      if (seq !== currentLoad) return;
      dropLive();
      handler(e);
    };
    for (const name of events) {
      el().addEventListener(name, wrapped);
      live.push([name, wrapped]);
    }
  }

  /* ---------- volume and mute, held here rather than delegated ----------

     Neither of these is a property of a file. Both are how the listener wants
     to hear whatever comes next, so they belong to the app and are handed to
     each media as it loads.

     They cannot simply be written to the player, which is what they used to do.
     The player proxies `volume` and `muted` onto the media it currently holds,
     and with the playlist emptied it holds none - so writing them was accepted,
     stored nowhere the app could read back, and thrown away. The controls were
     on screen, took the click, and changed nothing: reported as "I can't adjust
     the volume or mute it" from the moment the clear button was pressed.

     The app is now the only writer - the library's own controls are gone and its
     keyboard shortcuts are cleared - so holding the value here cannot go stale
     behind the app's back. */
  let heldVolume: number | null = null;
  let heldMuted: boolean | null = null;

  /* The real media element, when there is one. It is created once by the player
     and outlives a cleared playlist, so this returns the same element every
     time rather than a fresh one per load. */
  /* The media element belonging to *this* player.

     Scoped to the player on purpose. A document-wide `querySelector('video,
     audio')` answers with the first match anywhere on the page, and after a track
     change the page can hold more than one: the reader builds a new media element
     per source and the old one is not always gone before the new one is asked
     about. The result was a playhead reading zero while the clip was playing, a
     seek that appeared to do nothing, and a volume that looked set on an element
     nobody could hear.

     Scoped first, document-wide only as a fallback, for a moment when the player
     has not built its element yet. */
  const liveEl = (): any => {
    const player = el() as unknown as ParentNode | null;
    /* Scoped to the player, and among the elements in there, the one that is
       actually playing something.

       A reader builds a media element per source, and the previous one can still
       be in the tree for a while. Asking for the first match - or for any single
       match - can therefore hand back an element that was abandoned mid-playback,
       still reporting that it is playing. The symptom was exact and very strange:
       Space always paused and never started, because every toggle believed the
       clip was already running.

       An element with a source is a loaded one, and the most recently built of
       those is the current one. */
    const candidates: any[] = player && typeof (player as Element).querySelectorAll === 'function'
      ? Array.from((player as Element).querySelectorAll('video, audio'))
      : Array.from(document.querySelectorAll('video, audio'));
    const withSource = candidates.filter((c) => c && (c.currentSrc || c.src || c.querySelector?.('source')));
    const pool = withSource.length ? withSource : candidates;
    if (pool.length) return pool[pool.length - 1];
    /* The plain query as a last resort, for a page where the media element is not
       a descendant of the player at all. */
    return document.querySelector('video, audio');
  };

  /* Where the playhead really is.

     The player element's own `currentTime` is not it. Measured, with the video
     genuinely at 4.0s after a seek:

         player.currentTime   8      <- stale, does not track the media
         video.currentTime    4      <- the truth

     The library keeps that value for its own controls and does not follow a seek
     the app performed directly. Reading it here is what made a second press of
     the arrow key land in the wrong place - the app computed its step from a
     position the video had already left - and it is why the reported position and
     the visible frame could disagree.

     The live element is the truth; the player is the fallback for a moment when
     there is no media element yet, which is the empty playlist and a still
     image. */
  function playhead(): number {
    const live = liveEl();
    const fromLive = live ? Number(live.currentTime) : NaN;
    if (Number.isFinite(fromLive)) return fromLive;
    const fromPlayer = Number(el().currentTime);
    return Number.isFinite(fromPlayer) ? fromPlayer : 0;
  }

  /* Push both settings at whatever is loaded. Called after every source change,
     because a new media element - or the same one with a new source - starts at
     the browser's defaults and would otherwise start at full volume, unmuted,
     however the listener left it. */
  function applyHeld() {
    for (const target of [el(), liveEl()]) {
      if (!target) continue;
      if (heldVolume !== null) target.volume = heldVolume;
      if (heldMuted !== null) target.muted = heldMuted;
    }
  }

  /* The volume control is a native range input, so its fill is a gradient
     stopped at --mt-fill rather than a child element's width. The time slider
     is still the library's, and still has a fill element. */
  const paintBar = (which, ratio) => {
    const pct = (ratio * 100).toFixed(2) + '%';
    if (which === 'volume') {
      const input = document.getElementById('volume') as HTMLInputElement | null;
      if (input) input.style.setProperty('--mt-fill', pct);
      return;
    }
    const node = document.querySelector('media-time-slider');
    if (node) (node as HTMLElement).style.setProperty('--mt-fill', pct);
  };

  function init() {
    /* A second init() would double every listener, and every emission with it,
       so a double save and a double icon sync per event. */
    if (inited) return;
    inited = true;

    el();
    img();

    /* The library ships its own keyboard layer with these defaults:
         seekForward: "l L ArrowRight"   seekBackward: "j J ArrowLeft"
         toggleMuted: "m"  toggleFullscreen: "f"  toggleCaptions: "c"
         togglePaused: "k Space"
       It reads e.key off the same event the app handles, so every letter the
       app owns fired TWICE: `l` toggled loop and also seeked forward, `c` also
       toggled captions, `f`'s second toggle cancelled the app's fullscreen.
       preventDefault() cannot help - the library is not cancelling anything.
       The app owns the keyboard and documents every shortcut, so the map is
       cleared. The sliders keep their own arrow-key handling, which is a
       separate code path and is unaffected. */
    el().keyShortcuts = {};

    /* the real event names of the library, verified against its type defs */
    el().addEventListener('time-update', (e: Event & { detail?: { currentTime?: number } }) => {
      if (!sourceReady) return;
      emit('time', { currentTime: e.detail?.currentTime ?? el().currentTime });
    });
    el().addEventListener('play', () => emit('play', undefined));
    el().addEventListener('pause', () => emit('pause', undefined));
    el().addEventListener('volume-change', (e: Event & { detail?: { volume?: number } }) =>
      emit('volume', { volume: e.detail?.volume ?? el().volume }),
    );
    el().addEventListener('ended', () => emit('ended', undefined));
    el().addEventListener('error', () => emit('error', undefined));

    /* A still image that cannot be decoded has no error handler at all
       otherwise: it shows the browser's broken-image glyph forever and the
       playlist never moves on, because the app only advances on `error`. */
    img().addEventListener('error', () => {
      /* only meaningful when a picture is actually on screen */
      if (img().hidden) return;
      emit('error', { kind: 'image' });
    });
    /* The resume-seek and the autoplay replay are NOT wired here. They have to
       be installed per load, so that an event belonging to a replaced provider
       can be recognised and ignored - see onSuperseded(). Setting autoPlay
       before the first source works, but on a track change the library is
       still tearing down the previous provider and swallows it, which is why
       the request is remembered and replayed. */
  }

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
      wantedLoad = currentLoad;
      wantedUrl = kind === 'image' ? '' : (item.url || '');
      sourceReady = false;
      pendingSeek = item.position || 0;
      wantPlay = !!autoplay && kind !== 'image';
      pause();

      /* Drop the previous source *first*. Releasing the item's object URL while
         the element still points at it is a use-after-free of the resource by
         construction; it only appears to work because the next assignment
         happens to abort the in-flight fetch. */
      el().src = [];
      img().hidden = true;
      /* cleared only while hidden: emptying the src of a VISIBLE image raises
         an error event, and the app reads that as "this item will not play",
         so it would skip the track it had just loaded */
      img().removeAttribute('src');

      /* a still image has no timeline, so the player is released and the
         <img> takes over; clicking it advances (see app.js) */
      if (kind === 'image') {
        el().autoPlay = false;
        img().hidden = false;
        img().src = item.url;
        return;
      }

      /* installed BEFORE the source is attached, so the very first metadata
         event is caught rather than the next one */
      onSuperseded(['loaded-metadata', 'can-play'], () => {
        sourceReady = true;
        if (pendingSeek > 0) {
          el().currentTime = pendingSeek;
          pendingSeek = 0;
        }
        /* Here, and not before the src was set.

           It used to run above, one line before `el().src = [...]`. The
           library resets volume when a new source is attached, so every setting
           written beforehand was undone a line later: a new video started at
           full volume, unmuted, whatever the volume bar said. Reported as
           "when I add a new video it starts with full volume even if the volume
           bar is small or even if it is muted".

           Re-applied on `can-play` too rather than only `loaded-metadata`.
           Some sources report metadata and then finish setting up, and a setting
           written between those two moments is lost the same way. */
        applyHeld();
        startIfWanted();
      });

      el().load = 'eager';
      el().src = [{ src: item.url, type: item.mime || 'video/mp4' }];
      el().viewType = kind;

      /* And once more immediately, because the element may already have been
         given a source by the assignment above and this costs nothing. */
      applyHeld();

      /* autoPlay (not play()) because the library owns the load lifecycle:
         calling play() right after swapping src is ignored until the new
         source reports its metadata, so nothing would start. */
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
      wantedLoad = currentLoad;
      wantedUrl = '';
      sourceReady = false;
      pause();
      wantPlay = false;
      pendingSeek = 0;
      el().src = [];
      el().autoPlay = false;
      img().hidden = false;
      img().removeAttribute('src');
      paintBar('time', 0);
      /* The settings are deliberately NOT forgotten: they describe the listener,
         not the playlist. Re-painting them here is what stops the controls
         resetting to full volume and unmuted every time the list is emptied. */
      applyHeld();
      paintBar('volume', this.muted ? 0 : this.volume);
    },

    /* The library's own sliders keep correct state and ARIA values, but their
       fill property stays at 0% in v1.15.6, so the app paints them. Locating
       them belongs here: they are <media-*> elements, and app.js is not supposed
       to know that. Dragging, keyboard control and accessibility stay with
       the library. */
    paintTime(ratio) { paintBar('time', ratio); },
    paintVolume(ratio) { paintBar('volume', ratio); },

    /* True when the key belongs to one of the library's sliders, which handle
       their own arrow keys. */
    ownsArrowKey(target) {
      return !!(target as Element | null)?.closest?.('media-time-slider, media-volume-slider');
    },

    /* Fullscreen state, without the app touching document.fullscreenElement.

       Read from the shell when a shell offers it. WebKitGTK has no HTML
       Fullscreen API, so there `document.fullscreenElement` is permanently
       null and the button can never show what it did. The browser build has no
       problem and keeps the HTML path. */
    get fullscreen() {
      const shell = window.MediaFullscreen;
      if (shell && typeof shell === 'object') return !!shell.active;
      return !!document.fullscreenElement;
    },
    onFullscreenChange(fn) {
      const shell = window.MediaFullscreen;
      if (shell && typeof shell.onChange === 'function') {
        shell.onChange(() => fn());
        return;
      }
      document.addEventListener('fullscreenchange', fn);
    },

    /* Identifies the current load. A pause during teardown is followed by a
       time-update carrying the OUTGOING track's time, and the app's handler
       would otherwise write it into the incoming item's resume position. */
    ticket() { return currentLoad; },

    /* Whether it is playing, asked of the media element rather than the player.

       The same staleness as `currentTime`, one level over: the player's own
       `paused` does not follow what the app did to the media, so this reported
       "playing" for a clip that had ended and was sitting paused at zero. The
       pause glyph, the auto-start decision and every check that asks whether
       something is playing were all reading that. */
    get playing() {
      const live = liveEl();
      return live ? !live.paused : !el().paused;
    },
    get currentTime() { return playhead(); },
    /* The length, from the media element for the same reason: the player's copy
       is its own, and the two disagree once the app has seeked. */
    get duration() {
      const live = liveEl();
      const fromLive = live ? Number(live.duration) : NaN;
      return Number.isFinite(fromLive) ? fromLive : el().duration;
    },
    get volume() { return heldVolume !== null ? heldVolume : el().volume; },
    get muted() { return heldMuted !== null ? heldMuted : el().muted; },
    get loop() { return el().loop; },

    play,
    pause,

    /* Which way round, asked of the media element.

       `el().paused` is the player's copy, and it does not follow what the app did
       to the media - the same staleness as `playing` and `currentTime`. So Space
       asked the player, was told the clip was paused, called play() on a clip that
       was already playing, and did nothing at all. The transport's most-used key
       was inert whenever the player's state had drifted, and it drifted every time
       a track ended or the app seeked behind the library's back. */
    toggle() {
      const live = liveEl();
      const paused = live ? live.paused : el().paused;
      if (paused) play();
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
      /* The media element, not the player. `fastSeek` lives on the media element;
         the player has no such method, so the call was quietly skipped and every
         seek fell through to assigning `currentTime` on the player - which moves
         the video and leaves the player reporting where it was, which is the same
         staleness as above, reached by a different route.

         Falling back to the player is kept for the case where no media element
         exists at all. */
      const media = (liveEl() || el()) as HTMLVideoElement & { fastSeek?: (time: number) => void };
      const d = Number(media.duration);
      if (!Number.isFinite(d)) return;

      const now = Date.now();
      const repeating = seekTimer !== undefined && (now - lastSeekAt) < SEEK_COALESCE_MS;
      /* Repeats build on the target already queued, so holding the key travels
         the full distance instead of collapsing to a single step. */
      /* From the playhead, not from the player's copy of it - see playhead(). */
      const base = repeating && pendingSeekTo !== null ? pendingSeekTo : playhead();
      const target = Math.min(Math.max(base + delta, 0), d);

      const apply = (to: number) => {
        try {
          if (typeof media.fastSeek === 'function') media.fastSeek(to);
          else media.currentTime = to;
        } catch {
          /* Some engines refuse fastSeek on a stream; keep the button working. */
          try { media.currentTime = to; } catch { /* nothing useful left to do */ }
        }
      };

      lastSeekAt = now;

      if (!repeating) {
        if (seekTimer !== undefined) clearTimeout(seekTimer);
        seekTimer = undefined;
        pendingSeekTo = null;
        apply(target);
        return;
      }

      pendingSeekTo = target;
      if (seekTimer !== undefined) clearTimeout(seekTimer);
      seekTimer = setTimeout(() => {
        const to = pendingSeekTo;
        seekTimer = undefined;
        pendingSeekTo = null;
        if (to !== null) apply(to);
      }, SEEK_COALESCE_MS);
    },

    setVolume(v) {
      const next = Math.min(1, Math.max(0, v));
      heldVolume = next;
      /* Raising the volume is how a listener unmutes, which is what every
         player does and what the arrow keys have always done here. */
      if (next > 0) heldMuted = false;
      applyHeld();
      emit('volume', { volume: next });
    },

    toggleMute() {
      heldMuted = !this.muted;
      applyHeld();
      emit('volume', { volume: this.volume });
    },

    setLoop(on) {
      el().loop = !!on;
    },

    /* Fullscreen the whole stage, not the player element: the player is a
       sibling of the playlist panel, so fullscreening only the player would
       hide the panel and the control bar.

       Through the shell where one offers it, because the HTML API does not
       exist on WebKitGTK - see js/source-tauri.js. The browser build is
       unaffected and still uses the page. */
    async toggleFullscreen() {
      const shell = window.MediaFullscreen;
      if (shell && typeof shell.toggle === 'function') {
        try {
          await shell.toggle();
        } catch (err) {
          /* Reported rather than swallowed: a fullscreen button that does
             nothing is diagnosable, one that fails silently is not. */
          console.warn('[media] the window refused fullscreen:', err instanceof Error ? err.message : err);
        }
        return;
      }

      const target = document.getElementById('stage');
      try {
        const p = document.fullscreenElement
          ? document.exitFullscreen()
          : target?.requestFullscreen?.();
        /* The request is user-gesture bound and the browser refuses it in
           several situations (no activation yet, a transition already in
           flight). The failure is logged rather than swallowed so a dead
           button is diagnosable instead of silent. */
        if (p && p.catch) {
          p.catch((err) => {
            console.warn('[media] fullscreen request failed:', err && err.name, err && err.message);
          });
        }
      } catch (err) {
        console.warn('[media] fullscreen threw:', err instanceof Error ? err.message : err);
      }
    },
  };
})();
