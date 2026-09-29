/* Test harness: builds a jsdom document from the REAL index.html and loads the
   REAL scripts in their real order, so the tests exercise the shipped markup
   and wiring rather than a hand-written stub that can drift.

   The only thing faked is the playback library, which is exactly the boundary
   `js/media.js` exists to isolate. Faking it lets the app's own logic be tested
   deterministically: no codecs, no timing, no async media events. */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/* ---------- a stand-in for <media-player> and its children ---------- */

class FakeMediaElement extends HTMLElement {
  static observedAttributes = [];

  #src = [];
  #paused = true;
  #currentTime = 0;
  #duration = NaN;
  #volume = 1;
  #muted = false;
  #loop = false;
  #autoPlay = false;
  load = 'visible';
  viewType = 'unknown';
  keyShortcuts = null;
  /* failures the test can inject */
  failOnLoad = false;
  failOnPlay = false;

  get src() { return this.#src; }
  set src(v) {
    this.#src = Array.isArray(v) ? v : (v ? [v] : []);
    // a fresh source resets the timeline, exactly as a real element does
    this.#duration = NaN;
    this.#currentTime = 0;
    if (!this.#src.length) {
      this.#paused = true;
      this.#autoPlay = false;
      return;
    }
    queueMicrotask(() => {
      if (!this.#src.length) return;
      if (this.failOnLoad) return this.#emit('error', { detail: { error: new Error('unsupported') } });
      this.#duration = 8;
      this.#emit('loaded-metadata', { detail: { duration: 8 } });
      this.#emit('can-play', { detail: {} });
      if (this.#autoPlay) this.play();
    });
  }

  get paused() { return this.#paused; }
  set paused(v) { if (!v) this.play(); }
  get currentTime() { return this.#currentTime; }
  set currentTime(v) {
    this.#currentTime = v;
    this.#emit('time-update', { detail: { currentTime: v } });
  }
  get duration() { return this.#duration; }
  set duration(v) { this.#duration = v; }
  get volume() { return this.#volume; }
  set volume(v) {
    this.#volume = v;
    this.#emit('volume-change', { detail: { volume: v } });
  }
  get muted() { return this.#muted; }
  set muted(v) {
    this.#muted = v;
    this.#emit('volume-change', { detail: { volume: this.#volume } });
  }
  get loop() { return this.#loop; }
  set loop(v) { this.#loop = v; }
  get autoPlay() { return this.#autoPlay; }
  set autoPlay(v) { this.#autoPlay = v; }

  play() {
    if (this.failOnPlay) return Promise.reject(new Error('NotAllowedError'));
    this.#paused = false;
    this.#emit('play', { detail: {} });
    return Promise.resolve();
  }
  pause() {
    this.#paused = true;
    this.#emit('pause', { detail: {} });
  }

  /* helpers a real <video> would provide, so the app's probing path works */
  canPlayType() { return 'probably'; }

  #emit(type, init) {
    this.dispatchEvent(new Event(type, { bubbles: true, composed: true, ...init }));
  }

  /* test-only: drive the timeline like playback would */
  tick(seconds) {
    if (this.#paused) return;
    this.currentTime = Math.min(this.#currentTime + seconds, Number.isFinite(this.#duration) ? this.#duration : Infinity);
  }
  reachEnd() {
    this.currentTime = Number.isFinite(this.#duration) ? this.#duration : 0;
    this.#emit('ended', { detail: {} });
  }
}

/* A detached element used for probing durations/thumbnails. */
class FakeProbeElement extends HTMLElement {
  #src = '';
  #duration = NaN;
  get src() { return this.#src; }
  set src(v) {
    this.#src = v;
    if (!v) { this.#duration = NaN; return; }
    queueMicrotask(() => {
      if (!this.#src) return;
      this.#duration = 11;
      this.dispatchEvent(new Event('loadedmetadata', { bubbles: false }));
    });
  }
  get duration() { return this.#duration; }
  preloadedMetadata = { get: () => this.#duration };
  load() {}
}

/* ---------- DataTransfer, which jsdom does not implement ---------- */

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

/* ---------- canvas, only used for playlist thumbnails ---------- */

function stubCanvas(win) {
  win.HTMLCanvasElement.prototype.getContext = () => ({
    drawImage() {}, clearRect() {}, fillRect() {}, save() {}, restore() {},
  });
  win.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,stub';
}

/* ---------- build ---------- */

export async function createApp(options = {}) {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

  const dom = new JSDOM(html, {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;

  /* the fake library must be registered before the app's scripts run */
  window.customElements.define('media-player', FakeMediaElement);
  for (const tag of ['media-play-button', 'media-mute-button', 'media-seek-button', 'media-time-slider', 'media-volume-slider']) {
    window.customElements.define(tag, class extends HTMLElement {});
  }
  window.customElements.define('media-time', class extends HTMLElement {});
  window.customElements.define('media-gesture', class extends HTMLElement {});
  for (const tag of ['video', 'audio']) window.HTMLElement.prototype; // no-op, for clarity

  stubCanvas(window);
  window.DataTransfer = FakeDataTransfer;
  window.HTMLVideoElement = window.HTMLVideoElement || class extends HTMLElement {};
  window.ResizeObserver = window.ResizeObserver || class {
    observe() {} unobserve() {} disconnect() {}
  };
  window.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
  window.cancelAnimationFrame = (id) => clearTimeout(id);
  /* jsdom has no layout: give the elements a size so geometry code can run */
  window.Element.prototype.getBoundingClientRect = function rect() {
    return { x: 0, y: 0, top: 0, left: 0, right: 300, bottom: 40, width: 300, height: 40, toJSON() {} };
  };
  Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', { get() { return 40; }, configurable: true });

  /* fresh globals per test */
  const store = new Map();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
      clear: () => store.clear(),
      get length() { return store.size; },
    },
  });

  if (options.state) store.set('mediatools.prefs', JSON.stringify(options.state));

  const errors = [];
  window.addEventListener('error', (e) => errors.push(e.error || e.message));
  const warn = [];
  const realWarn = window.console.warn;
  window.console.warn = (...args) => { warn.push(args.join(' ')); realWarn(...args); };

  /* Blob URLs, tracked so a test can assert the lifetime pairing */
  const urls = { created: [], revoked: [] };
  window.URL.createObjectURL = (blob) => {
    const url = 'blob:test/' + (urls.created.length + 1);
    urls.created.push({ url, blob, revoked: false });
    return url;
  };
  window.URL.revokeObjectURL = (url) => {
    const rec = urls.created.find((r) => r.url === url);
    if (rec) rec.revoked = true;
    urls.revoked.push(url);
  };

  /* load the app's scripts, in the order index.html declares them */
  for (const file of ['js/source-web.js', 'js/source.js', 'js/media.js', 'js/i18n.js', 'js/settings.js', 'app.js']) {
    const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
    // eslint-disable-next-line no-new-func
    window.eval(code);
  }

  const $ = (id) => window.document.getElementById(id);
  const player = $('media');
  const stage = $('stage');
  const list = $('list');

  /* the playlist's <li> rows are the unit of interest */
  const rows = () => [...list.children];
  const names = () => rows().map((r) => r.querySelector('.nm').textContent);
  const counter = () => $('counter').textContent;
  const key = (k, extra = {}) => {
    const e = new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra });
    (window.document.activeElement || window.document).dispatchEvent(e);
    return e;
  };
  const file = (name, type, bytes = 8) =>
    new window.File([new Uint8Array(bytes)], name, { type });

  const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));

  /* the probing path is async by design; this waits for it to finish */
  const probeAll = async (times = 4) => {
    for (let i = 0; i < times; i++) await settle(1);
  };

  return {
    dom, window, document: window.document, $, player, stage, list,
    rows, names, counter, key, file, settle, probeAll,
    urls, errors, warn, store,
    close: () => window.close(),
  };
}

export { FakeDataTransfer, FakeMediaElement };
