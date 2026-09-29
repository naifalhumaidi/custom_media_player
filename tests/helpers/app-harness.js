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
  'js/settings.js',
  'app.js',
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
    set paused(value) { if (!value) this.play(); }
    get currentTime() { return this.#currentTime; }
    set currentTime(value) {
      this.#currentTime = value;
      this.#emit('time-update', { detail: { currentTime: value } });
    }
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

    play() {
      if (this.failOnPlay) return Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }));
      this.#paused = false;
      this.#emit('play', { detail: {} });
      return Promise.resolve();
    }
    pause() {
      this.#paused = true;
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
    urls, errors, warnings, store, failing,
    setSaveToFail: (on) => (on ? failing.add('set') : failing.delete('set')),
    close: () => window.close(),
  };
}

export { FakeDataTransfer, SCRIPTS as SCRIPT_ORDER };
