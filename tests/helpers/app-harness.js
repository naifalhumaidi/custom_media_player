/* Test harness.

   Builds a jsdom document from the REAL index.html and evaluates the REAL
   scripts, in the order the markup declares them. The tests therefore exercise
   the shipped markup and wiring rather than a hand-written stub that can drift
   away from it.

   The only thing faked is the playback library - which is exactly the boundary
   js/media.js exists to isolate. Faking it makes the app's own logic
   deterministic: no codecs, no real timing, no async media events, and blob
   URL lifetimes that can be asserted instead of guessed at. */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '../..');

export const SCRIPTS = [
  'js/mime.js',
  'js/source-web.js',
  'js/source.js',
  'js/media.js',
  'js/i18n.js',
  'js/menubar.js',
  'js/settings.js',
  'js/app.js',
];

/* ------------------------------------------------------------------ */
/* a stand-in for <media-player> and the parts the app talks to        */
/* ------------------------------------------------------------------ */

export function defineFakeLibrary(window) {
    const HTMLElementBase = window.HTMLElement;

    class FakeMediaElement extends HTMLElementBase {
    static observedAttributes = [];

    #src = [];
    #paused = true;
    #currentTime = 0;
    #duration = NaN;
    #volume = 1;
    #muted = false;
    #loop = false;
    #autoPlay = false;
    #ready = false;

    /* knobs a test can turn */
    failOnLoad = false;
    failOnPlay = false;
    /** delay before loaded-metadata, in fake ms (0 = immediate) */
    loadDelay = 0;
    /** what a loaded clip reports, so seek tests are not clipped to 8s */
    reportedDuration = 8;

    load = 'visible';
    viewType = 'unknown';
    keyShortcuts = null;

    /* The <video> inside the player, which is a different object with its own
       position.

       In a real page these are two elements: `<media-player>` for the library's
       controls, `<video>` for the picture. The library keeps its own copy of the
       playhead and does not follow a seek the app performs directly - the video
       moves and the player's report stays where it was. Here they were one
       object, so a bridge that read a stale copy looked exactly like one that
       read the playhead, and the bug survived every unit test. Found by the final
       pass, driving a real window.

       They move together until `goStale()`, which is the ordinary case and keeps
       the other 200-odd tests meaningful. */
    /* Only the position is independent. Everything else the bridge reads off the
       media element - how long it is, how loud, whether it is muted - is the same
       value the player holds, read live, because that is how a real <video> and
       the <media-player> around it behave. */
    mediaEl = (() => {
      const self = this;
      return {
        currentTime: 0,
        get duration() { return self.duration; },
        /* The element's own play state, which is the truth.

           A separate value from the player's on purpose. The player keeps its own
           copy, and that copy is what goes stale; the element is what actually
           plays. Reading the player's copy is how "playing" came back true for a
           clip sitting paused at zero. */
        paused: true,
        /* The URL the element is actually carrying.

           The bridge decides whether it is safe to start this element by asking
           whether its currentSrc is the URL it asked for. Without this the fake
           reports no source at all, the bridge stands down every time, and a test
           for "play reaches the media when the player transport goes stale"
           passes against code that never asked the media. */
        get currentSrc() { return self.src && self.src.length ? self.src[self.src.length - 1].src : ''; },
        get ended() { return false; },
        get readyState() { return 4; },
        get networkState() { return 1; },
        /* Volume and mute pass straight through in both directions: the bridge
           writes them to the media element when a clip loads, so they have to be
           settable here or the write throws. */
        get volume() { return self.volume; },
        set volume(v) { self.volume = v; },
        get muted() { return self.muted; },
        set muted(v) { self.muted = v; },
        /* The element's transport, which always works.

           The bridge acts on the element rather than on the player, because the
           player's transport went stale in a real window: it returned a promise
           that resolved and the video did not move. This is the element, so this
           works - which is the whole point, and what makes the difference
           observable when the player's is switched off.

           A refusal is still passed on rather than swallowed: a resolved
           promise here would make a blocked autoplay look like a successful play,
           and the tests that check the user is told when the browser refuses
           would pass against a bridge that never reported anything. */
        play() {
          self.playCalls++;
          self.mediaElPlays++;
          if (self.failOnPlay) return Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }));
          /* Recorded directly, never through `paused =`: that setter means "start
             playing", so writing to it from here re-entered the player's own
             transport - and then a test that meant to prove the bridge avoided
             the player was measuring the bridge using it. */
          self.syncMediaPaused(false);
          this.paused = false;
          /* A real element announces itself: `play` and `pause` are events the
             element fires and the library listens for. Without them the controls
             keep showing the old state - which is exactly the "the button says
             Play while it is playing" that made this so hard to read. */
          self.emitMedia('play');
          return Promise.resolve();
        },
        pause() {
          self.pauseCalls++;
          self.syncMediaPaused(true);
          this.paused = true;
          self.emitMedia('pause');
        },
      };
    })();

    staleCurrentTime = null;
    #reportedTime = NaN;

    /* When set, the PLAYER's own transport stops working while still reporting
       success - which is what the real one did, and the worst kind of failure to
       have: not loud, not silent, but lying. `play()` resolved and the video did
       not move, so every play/pause in the app went through a dead call that
       looked like it worked.

       Nothing could see it here before, because the fake player's transport
       always worked, so every unit test passed whatever the bridge read. With
       this on, the bridge has to reach the media element for playback to move -
       which is the behaviour under test. */
    transportGoesStale = false;
    playerPlayCalls = 0;
    playerPauseCalls = 0;
    /* How many times the ELEMENT was asked to play, which is not the same as
       how many times the player was: the bridge asks the player first. */
    mediaElPlays = 0;

    /* What the player reports, which is what it holds until it goes stale. */
    get currentTime() { return this.staleCurrentTime ? this.#reportedTime : this.#currentTime; }
    set currentTime(v) {
      /* A stale player stops following: the value lands on the video, which is
         where a seek actually goes, and the report stays where it was. */
      if (this.staleCurrentTime) {
        this.mediaEl.currentTime = v;
        return;
      }
      this.#currentTime = v;
      this.mediaEl.currentTime = v;
      this.#emit('time-update', { detail: { currentTime: v } });
    }

    /* Freeze the report at the current position, the way the real library's does
       once the app has seeked behind its back. */
    goStale() {
      this.#reportedTime = this.#currentTime;
      this.staleCurrentTime = true;
    }

    get src() { return this.#src; }
    set src(value) {
      this.#src = Array.isArray(value) ? value : (value ? [value] : []);
      /* A real element reports the OUTGOING time as it is torn down: a pause
         during a source change is followed by a time-update carrying the old
         track's position. Reproduced here, or a test for that defect is
         testing nothing at all - the fake would simply never emit the event. */
      if (this.#currentTime) {
        this.#emit('time-update', { detail: { currentTime: this.#currentTime } });
      }
      /* a fresh source resets the timeline, exactly as a real element does */
      this.#duration = NaN;
      this.#currentTime = 0;
      this.#ready = false;
      this.#paused = true;
      this.#autoPlay = false;
      /* And it resets the volume and the mute, which is the whole reason the
         volume bug was fixable at all.

         Vidstack re-applies its own defaults when a source is attached, so
         anything the app wrote beforehand is undone a line later. The fake
         never did that, which is why "a new video starts at full volume even
         when muted" was not reproducible here and had to be found by hand - the
         test double and the bug were wrong in opposite directions, so neither
         could show the other.

         Setting a src of nothing does NOT reset them: clearing the playlist
         leaves a media element with no source, and its volume is still the
         listener's. */
      if (this.#src.length) {
        this.#volume = 1;
        this.#muted = false;
        this.#emit('volume-change', { detail: { volume: 1 } });
      }
      if (!this.#src.length) return;
      const announce = () => {
        if (!this.#src.length) return;
        if (this.failOnLoad) {
          this.#ready = false;
          this.#emit('error', { detail: { error: new Error('unsupported codec') } });
          return;
        }
        this.#duration = this.reportedDuration;
        this.#ready = true;
        this.#emit('loaded-metadata', { detail: { duration: this.#duration } });
        this.#emit('can-play', { detail: {} });
        if (this.#autoPlay) this.play();
      };
      if (this.loadDelay) setTimeout(announce, this.loadDelay);
      else queueMicrotask(announce);
    }

    get ready() { return this.#ready; }
    get paused() { return this.#paused; }
    set paused(value) { if (value) this.#paused = true; else this.play(); }

    /* The media element's play state, recorded on the player without going
       through `play()`/`pause()`.

       The player keeps a copy of the element's state so the two agree while
       everything is working, which is what a real player does - and it is the
       copy that goes stale in a real window, which is why the bridge reads the
       element instead. Written as a separate method because the `paused` setter
       means "start playing" and using it here would call the transport. */
    syncMediaPaused(value) { this.#paused = value; }

    /* The element's own event, heard by the library and by the app. */
    emitMedia(type) { this.#emit(type, { detail: {} }); }
    get duration() { return this.#duration; }
    set duration(value) { this.#duration = value; }
    get volume() { return this.#volume; }
    set volume(value) {
      this.#volume = value;
      this.#emit('volume-change', { detail: { volume: value } });
    }
    get muted() { return this.#muted; }
    set muted(value) {
      this.#muted = value;
      this.#emit('volume-change', { detail: { volume: this.#volume } });
    }
    get loop() { return this.#loop; }
    set loop(value) { this.#loop = value; }
    get autoPlay() { return this.#autoPlay; }
    set autoPlay(value) { this.#autoPlay = value; }

    /* The player's transport.

       Counts its own calls, so a test can tell the two apart, and does nothing
       at all when `transportGoesStale` is set - while still returning a resolved
       promise, which is the part that mattered. A transport that fails loudly is
       easy to notice; this one reported success and changed nothing. */
    play() {
      this.playerPlayCalls++;
      if (this.transportGoesStale) return Promise.resolve();
      if (this.failOnPlay) return Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }));
      this.#paused = false;
      this.mediaEl.paused = false;
      this.#emit('play', { detail: {} });
      return Promise.resolve();
    }
    pause() {
      this.playerPauseCalls++;
      if (this.transportGoesStale) return;
      this.#paused = true;
      this.mediaEl.paused = true;
      this.#emit('pause', { detail: {} });
    }
    canPlayType() { return 'probably'; }

    #emit(type, init) {
      this.dispatchEvent(new this.ownerDocument.defaultView.Event(type, {
        bubbles: true,
        composed: true,
        ...init,
      }));
    }

    /* test-only drives, standing in for real playback */
    tick(seconds) {
      if (this.#paused) return;
      const end = Number.isFinite(this.#duration) ? this.#duration : Infinity;
      this.currentTime = Math.min(this.#currentTime + seconds, end);
    }
    reachEnd() {
      this.currentTime = Number.isFinite(this.#duration) ? this.#duration : 0;
      /* The clip stops when it ends, and the element is where that shows. The
         two carry separate play state now, so both have to be told - otherwise
         the bridge reads a player that has stopped and an element still going. */
      this.#paused = true;
      this.mediaEl.paused = true;
      this.#emit('ended', { detail: {} });
    }
  }

  /* The detached element the app probes for durations and thumbnails. */
    class FakeProbeElement extends HTMLElementBase {
    #src = '';
    #duration = NaN;
    videoWidth = 640;
    videoHeight = 360;
    muted = false;
    playsInline = false;
    preload = '';
    load() {}
    get src() { return this.#src; }
    set src(value) {
      this.#src = value;
      if (!value) { this.#duration = NaN; return; }
      queueMicrotask(() => {
        if (!this.#src) return;
        this.#duration = 11;
        this.dispatchEvent(new this.ownerDocument.defaultView.Event('loadedmetadata'));
      });
    }
    get duration() { return this.#duration; }
    set currentTime(value) {
      queueMicrotask(() => {
        if (this.#src) this.dispatchEvent(new this.ownerDocument.defaultView.Event('seeked'));
      });
    }
  }

  /* Register in the window's own registry. Getting the realm right matters: a
     class extending a different window's HTMLElement is rejected outright, and
     an element that is merely never upgraded leaves the app talking to a bare
     element whose `src` is undefined. */
  window.customElements.define('media-player', FakeMediaElement);

  /* The bridge reaches the real media element with `querySelector('video,
     audio')`, not through the player, because that is how it applies the
     listener's volume and mute to whatever is actually loaded. jsdom's <video>
     cannot decode and does not implement volume the same way, so the fake
     answers that query too - otherwise the settings are written to an element
     that ignores them and every test passes whatever the source does.

     Only when nothing else matches, so a test that puts its own <video> in the
     page still gets it. */
  const realQuery = window.document.querySelector.bind(window.document);
  window.document.querySelector = (selector) => {
    if (selector === 'video, audio' || selector === 'video,audio') {
      const found = realQuery(selector);
      if (found) return found;
      /* The video inside the player, not the player. A real page has both and
         this answers for the one that decodes. */
      const player = window.document.getElementById('media');
      return (player && player.mediaEl) || player;
    }
    return realQuery(selector);
  };
  for (const tag of [
    'media-time', 'media-gesture', 'media-audio-track',
    'media-play-button', 'media-mute-button', 'media-seek-button',
    'media-time-slider', 'media-volume-slider',
  ]) {
    window.customElements.define(tag, class extends HTMLElementBase {});
  }

  /* Custom elements only upgrade an element already in a document, so anything
     parsed later is upgraded by hand. */
  const upgradeAll = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.constructor === HTMLElementBase) window.customElements.upgrade(el);
    }
  };
  window.__upgradeAll = upgradeAll;
  upgradeAll(window.document);

  /* The probe element cannot be `new`-ed directly: a class extending HTMLElement
     is only constructible once it is in a registry. Registering it under a
     private tag and creating that tag is the way to get an instance. */
  window.customElements.define('media-probe', FakeProbeElement);
  window.FakeProbeElement = FakeProbeElement;
  window.FakeImage = FakeImage;

  return { FakeMediaElement, FakeProbeElement, FakeImage, upgradeAll };
}

/* jsdom implements neither of these and the app needs both. */
class FakeDataTransfer {
  #items = [];
  get types() { return this.#items.length ? ['Files'] : []; }
  get files() { return this.#items; }
  setDragImage() {}
  clearData() { this.#items = []; }
  setData() {}
  getData() { return ''; }
  add(file) { this.#items.push(file); }
  get items() {
    return this.#items.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file }));
  }
}

class FakeImage {
  constructor() {
    this.naturalWidth = 1280;
    this.naturalHeight = 720;
    this._src = '';
  }
  set src(v) { this._src = v; }
  get src() { return this._src; }
  decode() { return Promise.resolve(); }
}

/* ------------------------------------------------------------------ */
/* build                                                              */
/* ------------------------------------------------------------------ */

/**
 * @param {object} options
 * @param {object} [options.state]  seed for the persisted preferences
 * @param {string} [options.files]  extra <script src> paths, loaded last
 * @param {boolean} [options.html]  set false to boot without the markup
 */
export async function createApp(options = {}) {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const dom = new JSDOM(html, {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;

  /* the fake library must exist before the app's scripts run */
  defineFakeLibrary(window);

  window.Image = window.FakeImage;
  window.DataTransfer = FakeDataTransfer;

  /* A stand-in for the application menu, so the commands a shell sends can be
     driven from a test.

     The menu is the app's own shell feature - the browser build has no menu bar,
     so there is nothing real to press. But the code path matters: a menu item
     that calls a different function from the button beside it is exactly the bug
     a menu invites, and a test that cannot send a command cannot catch it. So
     the harness offers the same two methods the preload does, and the tests
     drive the menu through them rather than through the buttons. */
  const menuHandlers = [];
  window.MediaShell = {
    shell: 'electron',
    /* Enough of the contract for the browser source to load and for the menu to
       be reachable. The file-picking methods are never called by these tests. */
    pickFiles: async () => [],
    pickFolder: async () => null,
    listFolder: async () => [],
    fileExists: async () => true,
    loadState: async () => null,
    saveState: async () => {},
    mediaUrl: async (file) => `blob:${file}`,
    setFullscreen: async () => {},
    isFullscreen: async () => false,
    pathForFile: () => '',
    onMenuCommand(handler) {
      menuHandlers.push(handler);
      return () => {
        const at = menuHandlers.indexOf(handler);
        if (at >= 0) menuHandlers.splice(at, 1);
      };
    },
    menuState() {},
  };
  /* The app publishes window.MediaMenu itself, so a test fires the menu through
     that - the same table the shell reaches - rather than through a helper here
     that could answer differently. */
  /* The app probes with document.createElement('video' | 'audio') and reads a
     duration off the result. jsdom never fires loadedmetadata, so those two
     tags resolve to the fake probe instead - which is the same boundary
     js/media.js exists to isolate, applied to the probing path. */
  window.document.createElement = ((original) => (name, opts) =>
    (name === 'video' || name === 'audio'
      ? window.document.createElementNS('http://www.w3.org/1999/xhtml', 'media-probe', opts)
      : original(name, opts))
  )(window.document.createElement.bind(window.document));
  window.ResizeObserver = window.ResizeObserver || class {
    observe() {} unobserve() {} disconnect() {}
  };
  window.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
  window.cancelAnimationFrame = (id) => clearTimeout(id);

  /* the app's <video>/<audio> tags are real jsdom elements; give them the
     canvas the thumbnail path expects */
  window.HTMLCanvasElement.prototype.getContext = () => ({
    drawImage() {}, clearRect() {}, fillRect() {}, save() {}, restore() {},
  });
  window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/jpeg;base64,thumb';

  /* jsdom performs no layout, so the drag-and-drop midpoint maths has no
     geometry to work from. Deterministic boxes keep those tests meaningful. */
  const boxes = options.boxes || null;
  window.Element.prototype.getBoundingClientRect = function rect() {
    if (boxes && boxes[this.id || this.tagName]) return boxes[this.id || this.tagName];
    return { x: 0, y: 0, top: 0, left: 0, right: 300, bottom: 40, width: 300, height: 40, toJSON() {} };
  };
  Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', {
    get() { return 40; },
    configurable: true,
  });

  /* a fresh, inspectable localStorage per test */
  const store = new Map();
  const failing = new Set();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => {
        if (failing.has('set')) {
          throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
        }
        store.set(k, String(v));
      },
      removeItem: (k) => store.delete(k),
      clear: () => store.clear(),
      get length() { return store.size; },
    },
  });

  /* blob URLs, tracked so a test can assert create/revoke pairing */
  const urls = { created: [], revoked: [] };
  window.URL.createObjectURL = (blob) => {
    const rec = { url: 'blob:test/' + (urls.created.length + 1), blob, revoked: false };
    urls.created.push(rec);
    return rec.url;
  };
  window.URL.revokeObjectURL = (url) => {
    const rec = urls.created.find((r) => r.url === url);
    if (rec) rec.revoked = true;
    urls.revoked.push(url);
  };

  /* collect anything the app throws, so a test can assert silence */
  const errors = [];
  const warnings = [];
  const realWarn = window.console.warn.bind(window.console);
  window.console.warn = (...args) => { warnings.push(args.map(String).join(' ')); realWarn(...args); };
  window.addEventListener('error', (e) => errors.push(e.error || e.message));
  window.addEventListener('unhandledrejection', (e) => errors.push(e.reason));

  if (options.state) store.set('mediatools.prefs', JSON.stringify(options.state));

  if (options.html !== false) {
    for (const file of [...SCRIPTS, ...(options.files || [])]) {
      window.eval(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    }
  }

  const document = window.document;
  const $ = (id) => document.getElementById(id);
  const player = $('media');
  const stage = $('stage');
  const list = $('list');

  const rows = () => [...list.children];
  const names = () => rows().map((r) => r.querySelector('.nm')?.textContent);
  const durations = () => rows().map((r) => r.querySelector('.dur')?.textContent);
  const counter = () => $('counter').textContent;
  const total = () => $('total').textContent;

  const key = (k, init = {}) => {
    const event = new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
    (document.activeElement || document).dispatchEvent(event);
    return event;
  };

  const file = (name, type, bytes = 8) => new window.File([new Uint8Array(bytes)], name, { type });

  /* Clearing the playlist, the way a person does it: the request, then the
     answer. Exposed as one call so a test about the *consequence* of clearing
     does not have to know a dialog is in the way, and a test about the dialog
     can drive it directly. `answer` is 'ok' or 'cancel'. */
  const requestClear = () => { $('clear-list').click(); };
  const answerClear = (answer = 'ok') => {
    const dialog = $('clear-modal');
    if (dialog.hidden) return false;
    $('clear-' + answer).click();
    return true;
  };
  const clearDialogOpen = () => !$('clear-modal').hidden;
  const settingsOpen = () => !$('settings-modal').hidden;

  /** Let the app's async work (probing, debounced saves) run. */
  const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));
  /** Enough for the three probe workers and the 400ms save debounce. */
  const settleAll = async () => {
    for (let i = 0; i < 6; i++) await settle(1);
    await settle(450);
  };

  const drop = (target, files) => {
    const dt = new FakeDataTransfer();
    for (const f of files) dt.add(f);
    const event = new window.Event('drop', { bubbles: true, cancelable: true });
    event.dataTransfer = dt;
    target.dispatchEvent(event);
    return event;
  };

  const prefs = () => {
    const raw = store.get('mediatools.prefs');
    return raw ? JSON.parse(raw) : null;
  };

  return {
    dom, window, document, $, player, stage, list,
    rows, names, durations, counter, total, key, file, settle, settleAll, drop, prefs,
    requestClear, answerClear, clearDialogOpen, settingsOpen,
    urls, errors, warnings, store, failing,
    setSaveToFail: (on) => (on ? failing.add('set') : failing.delete('set')),
    close: () => window.close(),
  };
}

export { FakeDataTransfer, SCRIPTS as SCRIPT_ORDER };

/* Loads a classic script against the current jsdom window, for the modules
   that register nothing on their own (they are selected by a shell that only
   exists in the desktop build). Used by the desktop-adapter tests. */
export function evalSource(source) {
  // eslint-disable-next-line no-new-func
  new Function(source)();
  return globalThis.window;
}
