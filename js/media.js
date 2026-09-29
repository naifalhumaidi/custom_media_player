/* Vidstack boundary — the only file that knows a media library exists.
   app.js talks only to this interface, so the library can be swapped or
   removed without touching playlist / sidebar / drop-zone code.

   State changes go through the library's request events (its documented
   request/response model) rather than assigning properties, so the
   library stays the single source of truth and its own UI components
   stay in sync with the keyboard shortcuts. */

(() => {
  let player = null;
  let still = null;
  let pendingSeek = 0;

  /* resolved lazily so the bridge is safe to touch before init() */
  const el = () => player || (player = document.getElementById('media'));
  const img = () => still || (still = document.getElementById('still'));

  /* The element's own props/methods are the supported control surface
     (play, pause, currentTime, volume, muted, loop). Hand-rolled
     `media-*-request` events are ignored unless the library itself
     dispatches them through its remote, so we do not use them. */
  const play = () => el().play().catch(() => {});
  const pause = () => el().pause();

  const listeners = { time: [], play: [], pause: [], ended: [], error: [] };
  const emit = (key, payload) => listeners[key].forEach((fn) => fn(payload));
  const on = (key, fn) => {
    const list = listeners[key] || (listeners[key] = []);
    list.push(fn);
    return () => (listeners[key] = list.filter((f) => f !== fn));
  };

  function init() {
    el();
    img();

    /* the real event names of the library, verified against its type defs */
    el().addEventListener('time-update', (e) =>
      emit('time', { currentTime: e.detail?.currentTime ?? el().currentTime }),
    );
    el().addEventListener('play', () => emit('play'));
    el().addEventListener('pause', () => emit('pause'));
    el().addEventListener('ended', () => emit('ended'));
    el().addEventListener('error', () => emit('error'));

    /* resume where we left off once the media reports its metadata */
    el().addEventListener('loaded-metadata', () => {
      if (pendingSeek > 0) {
        el().currentTime = pendingSeek;
        pendingSeek = 0;
      }
    });
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
      pendingSeek = item.position || 0;
      pause();

      /* a still image has no timeline, so the player is released and the
         <img> takes over; clicking it advances (see app.js) */
      if (kind === 'image') {
        el().src = [];
        el().autoPlay = false;
        img().hidden = false;
        img().src = item.url;
        return;
      }
      img().src = '';
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
      pause();
      el().src = [];
      el().autoPlay = false;
      img().src = '';
      img().hidden = false;
      pendingSeek = 0;
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
        if (p && p.catch) p.catch(() => {});
      } catch {}
    },
  };
})();
