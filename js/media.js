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
  let player = null;
  let still = null;
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

  /* resolved lazily so the bridge is safe to touch before init() */
  const el = () => player || (player = document.getElementById('media'));
  const img = () => still || (still = document.getElementById('still'));

  const listeners = { time: [], play: [], pause: [], ended: [], error: [], blocked: [], volume: [] };
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
  const play = () => {
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
  };
  const pause = () => el().pause();

  const startIfWanted = () => {
    if (!wantPlay) return;
    wantPlay = false;
    play();
  };

  /* A superseded load must not apply its seek or its autoplay to whatever is
     on screen by the time its events arrive. The handlers are installed per
     load and close over their own ticket; a listener registered once in
     init() could not tell which load an event belonged to, because the events
     carry no identity of their own. */
  let live = [];

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

  const paintBar = (which, ratio) => {
    const node = document.querySelector(
      which === 'time' ? 'media-time-slider' : 'media-volume-slider',
    );
    if (node) node.style.setProperty('--mt-fill', (ratio * 100).toFixed(2) + '%');
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
    el().addEventListener('time-update', (e) => {
      if (!sourceReady) return;
      emit('time', { currentTime: e.detail?.currentTime ?? el().currentTime });
    });
    el().addEventListener('play', () => emit('play'));
    el().addEventListener('pause', () => emit('pause'));
    el().addEventListener('volume-change', (e) =>
      emit('volume', { volume: e.detail?.volume ?? el().volume }),
    );
    el().addEventListener('ended', () => emit('ended'));
    el().addEventListener('error', () => emit('error'));

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
        startIfWanted();
      });

      el().load = 'eager';
      el().src = [{ src: item.url, type: item.mime || 'video/mp4' }];
      el().viewType = kind;

      /* autoPlay (not play()) because the library owns the load lifecycle:
         calling play() right after swapping src is ignored until the new
         source reports its metadata, so nothing would start. */
      el().autoPlay = !!autoplay;
      if (autoplay) el().paused = false;
    },

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
      img().removeAttribute('src');
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
      return !!target.closest?.('media-time-slider, media-volume-slider');
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

    get playing() { return !el().paused; },
    get currentTime() { return el().currentTime || 0; },
    get duration() { return el().duration; },
    get volume() { return el().volume; },
    get muted() { return el().muted; },
    get loop() { return el().loop; },

    play,
    pause,

    toggle() {
      if (el().paused) play();
      else pause();
    },

    seekBy(delta) {
      const d = el().duration;
      if (!Number.isFinite(d)) return;
      el().currentTime = Math.min(Math.max(el().currentTime + delta, 0), d);
    },

    setVolume(v) {
      const next = Math.min(1, Math.max(0, v));
      el().volume = next;
      if (next > 0) el().muted = false;
    },

    toggleMute() {
      el().muted = !el().muted;
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
          console.warn('[media] the window refused fullscreen:', err && (err.message || err));
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
        console.warn('[media] fullscreen threw:', err && err.message);
      }
    },
  };
})();
