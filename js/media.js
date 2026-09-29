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

  /* resolved lazily so the bridge is safe to touch before init() */
  const el = () => player || (player = document.getElementById('media'));
  const img = () => still || (still = document.getElementById('still'));

  const listeners = { time: [], play: [], pause: [], ended: [], error: [], blocked: [] };
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

  const startIfWanted = (seq) => {
    if (seq !== undefined && seq !== currentLoad) return;
    if (!wantPlay) return;
    wantPlay = false;
    play();
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
    el().addEventListener('time-update', (e) =>
      emit('time', { currentTime: e.detail?.currentTime ?? el().currentTime }),
    );
    el().addEventListener('play', () => emit('play'));
    el().addEventListener('pause', () => emit('pause'));
    el().addEventListener('ended', () => emit('ended'));
    el().addEventListener('error', () => emit('error'));

    /* A still image that cannot be decoded has no error handler at all
       otherwise: it shows the browser's broken-image glyph forever and the
       playlist never moves on, because the app only advances on `error`. */
    img().addEventListener('error', () => emit('error', { kind: 'image' }));

    /* resume where we left off once the media reports its metadata */
    el().addEventListener('loaded-metadata', () => {
      const seq = currentLoad;
      if (pendingSeek > 0) {
        el().currentTime = pendingSeek;
        pendingSeek = 0;
      }
      startIfWanted(seq);
    });

    /* Setting autoPlay before the first source works, but on a track change the
       library is still tearing down the previous provider and swallows it, so
       the new track loads paused. The request is remembered and replayed the
       moment the new source is actually playable. */
    el().addEventListener('can-play', () => startIfWanted(currentLoad));
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
      currentLoad = ++loadSeq;
      pendingSeek = item.position || 0;
      wantPlay = !!autoplay && kind !== 'image';
      pause();

      /* Drop the previous source *first*. Releasing the item's object URL while
         the element still points at it is a use-after-free of the resource by
         construction; it only appears to work because the next assignment
         happens to abort the in-flight fetch. */
      el().src = [];
      img().src = '';

      /* a still image has no timeline, so the player is released and the
         <img> takes over; clicking it advances (see app.js) */
      if (kind === 'image') {
        el().autoPlay = false;
        img().hidden = false;
        img().src = item.url;
        return;
      }
      img().hidden = true;

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
      currentLoad = ++loadSeq;
      pause();
      wantPlay = false;
      pendingSeek = 0;
      el().src = [];
      el().autoPlay = false;
      img().src = '';
      img().hidden = false;
    },

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
       hide the panel and the control bar. */
    toggleFullscreen() {
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
