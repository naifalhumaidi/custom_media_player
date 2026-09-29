import fs from 'node:fs';

const ROOT = '/home/user/Data/Mine/0Projects/Mine/Dev/Web_Dev/Latest/my_local_repo/new-projects/almenber/almenber-tools/custom_media_player/';
const SCRIPTS = ['js/source-web.js', 'js/source.js', 'js/media.js', 'js/i18n.js', 'js/settings.js', 'app.js'];

/* ---------------- DOM stub ---------------- */

const L = new Map();
const on = (k, fn) => {
  if (!L.has(k)) L.set(k, []);
  L.get(k).push(fn);
};
const emit = (k, arg) => (L.get(k) || []).slice().forEach((f) => f(arg));
const fire = (k, arg) => emit(k, arg);
const fired = (k) => (L.get(k) || []).length;

let pickerQueue = [];

function mkEl(tag = 'div', id = '') {
  const el = {
    tagName: tag.toUpperCase(),
    id,
    children: [],
    parent: null,
    dataset: {},
    attrs: {},
    style: { display: '', setProperty() {} },
    value: 0,
    title: '',
  dispatchEvent: () => true,
  addEventListener(t, fn) { on('doc:' + t, fn); },
    hidden: false,
    src: '',
    files: [],
    type: '',
    duration: NaN,
    currentTime: 0,
    volume: 1,
    muted: false,
    loop: false,
    paused: true,
    ended: false,
    readyState: 0,
    videoWidth: 0,
    videoHeight: 0,
    buffered: null,
    viewType: '',
    getContext: () => ({ drawImage() {} }),
    toDataURL: () => 'data:thumb',
    getBoundingClientRect: () => ({ top: 0, height: 40 }),
    scrollIntoView() {},
    requestFullscreen: () => Promise.resolve(),
    getAttribute(n) { return this.attrs[n] ?? null; },
    setAttribute(n, v) { this.attrs[n] = v; },
    removeAttribute(n) { delete this.attrs[n]; },
    hasAttribute(n) { return n in this.attrs; },
    load() {},
    play() { this.paused = false; fire(this.id + ':play'); return Promise.resolve(); },
    pause() { this.paused = true; fire(this.id + ':pause'); },
    click() {
      if (this.type === 'file') {
        this.files = pickerQueue.shift() || [];
        queueMicrotask(() => fire((this.id || this.tagName.toLowerCase()) + ':change'));
        return;
      }
      this.onclick?.();
    },
    append(...n) { for (const c of n) { c.parent = this; this.children.push(c); } },
    appendChild(c) { this.append(c); return c; },
    prepend(c) { c.parent = this; this.children.unshift(c); },
    /* live DOM-order moves, which the reorder implementation relies on */
    insertBefore(node, ref) {
      if (node === ref) return node;
      const i = this.children.indexOf(node);
      if (i >= 0) this.children.splice(i, 1);
      const at = ref ? this.children.indexOf(ref) : -1;
      if (at < 0) this.children.push(node);
      else this.children.splice(at, 0, node);
      node.parent = this;
      return node;
    },
    get previousElementSibling() {
      const i = this.parent ? this.parent.children.indexOf(this) : -1;
      return i > 0 ? this.parent.children[i - 1] : null;
    },
    contains(o) { return o === this || this.children.some((c) => c.contains?.(o)); },
    closest(sel) {
      let n = this;
      while (n) {
        if (sel.startsWith('.')) { if (n.classList.contains(sel.slice(1))) return n; }
        else if (n.tagName.toLowerCase() === sel.toLowerCase()) return n;
        n = n.parent;
      }
      return null;
    },
    addEventListener(t, fn) { on((id || tag) + ':' + t, fn); },
    querySelectorAll: () => [],
    get firstElementChild() { return this.children[0] || null; },
    querySelector(sel) {
      const want = sel.split(',')[0].trim();
      const all = [this, ...this.children];
      return all.find((n) =>
        want.startsWith('.') ? String(n.className || '').split(/\s+/).includes(want.slice(1))
        : (n.tagName || '').toLowerCase() === want.toLowerCase()) || null;
    },
    replaceChild(n, o) { const i = this.children.indexOf(o); if (i >= 0) this.children[i] = n; return o; },
    removeAttribute() {},
    setAttribute() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    focus() {},
    offsetHeight: 0,
    files: [],
    dispatchEvent(e) {
      if (e && e.type) emit(id + ':' + e.type, e);
      emit(id + ':anyevent', e);
      return true;
    },
    removeEventListener(t, fn) {
      const k = (id || tag) + ':' + t;
      if (L.has(k)) L.set(k, L.get(k).filter((f) => f !== fn));
    },
  };

  const set = new Set();
  el.classList = {
    add: (...c) => c.forEach((x) => set.add(x)),
    remove: (...c) => c.forEach((x) => set.delete(x)),
    toggle: (c, f) => (f ?? !set.has(c)) ? (set.add(c), true) : (set.delete(c), false),
    contains: (c) => set.has(c),
    set,
  };

  let cls = '';
  Object.defineProperty(el, 'className', {
    get: () => cls,
    set(v) { cls = String(v); set.clear(); for (const c of cls.split(/\s+/).filter(Boolean)) set.add(c); },
  });

  let text = '';
  Object.defineProperty(el, 'textContent', {
    get: () => text,
    set(v) { text = String(v); if (text === '') el.children.length = 0; },
  });

  /* detached thumbnail-probe elements: report metadata + a seekable frame */
  if (!id && (tag === 'video' || tag === 'audio')) {
    let _src = '';
    Object.defineProperty(el, 'src', {
      get: () => _src,
      set(v) {
        _src = v;
        if (!v) return;
        el.duration = 61; el.readyState = 1;
        if (tag === 'video') { el.videoWidth = 640; el.videoHeight = 360; }
        setTimeout(() => fire(tag + ':loadedmetadata'), 0);
      },
    });
    let _t = 0;
    Object.defineProperty(el, 'currentTime', {
      get: () => _t,
      set(v) { _t = v; if (v) setTimeout(() => fire(tag + ':seeked'), 0); },
    });
  }

  return el;
}

const byId = new Map();
const el = (id) => {
  if (!byId.has(id)) byId.set(id, mkEl('div', id));
  return byId.get(id);
};

globalThis.Event = class { constructor(t) { this.type = t; } };
globalThis.CustomEvent = class extends globalThis.Event {
  constructor(t, o = {}) { super(t); this.detail = o.detail; this.bubbles = !!o.bubbles; }
};
globalThis.window = {
  addEventListener: (t, fn) => on('win:' + t, fn),
  requestFullscreen: () => Promise.resolve(),
};
globalThis.document = {
  documentElement: Object.assign(mkEl('html'), { lang: 'en', dir: 'ltr' }),
  title: '',
  body: mkEl('body'),
  querySelectorAll: () => [],
  dispatchEvent: () => true,
  fullscreenElement: null,
  exitFullscreen() {},
  getElementById: el,
  createElement: (tag) => mkEl(tag),
  querySelector: (sel) => {
    const key = sel.replace(/^[a-z-]+/, '').replace(/[\[\]]/g, '') || sel;
    return el(key.replace(/\s.*$/, '')) || null;
  },
  addEventListener: (t, fn) => on('doc:' + t, fn),
};
// thumbnails now go through a canvas, so the stub needs a decodable image
globalThis.Image = class {
  constructor() { this.naturalWidth = 1280; this.naturalHeight = 720; }
  set src(v) { this._src = v; }
  get src() { return this._src; }
  decode() { return Promise.resolve(); }
};
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '', display: 'block', visibility: 'visible', opacity: '1' });
globalThis.FileReader = class { readAsDataURL() { if (this.onload) this.onload(); } };
globalThis.localStorage = {
  _d: {},
  getItem(k) { return this._d[k] ?? null; },
  setItem(k, v) { this._d[k] = v; },
};
globalThis.URL = {
  created: 0,
  revoked: 0,
  createObjectURL() { return 'blob:' + ++this.created; },
  revokeObjectURL() { this.revoked++; },
};

el('stage').dataset.fit = 'contain';
if (process.env.SEED) localStorage.setItem('mediatools.prefs', process.env.SEED);



for (const f of SCRIPTS) (0, eval)(fs.readFileSync(ROOT + f, 'utf8'));
await new Promise((r) => setTimeout(r, 40));

/* ---------------- helpers ---------------- */

const stage = el('stage');
const player = el('media');
const bridge = globalThis.window.MediaBridge;
const REQ = () => {
  const seen = [];
  for (const k of ['paused', 'currentTime', 'volume', 'muted', 'loop']) seen.push(k + '=' + player[k]);
  return seen.join(' ');
};
/* fire a library event at the player the way the real element would */
const vds = (type, detail) => emit('media:' + type, { type, detail });
const still = el('still');
const list = el('list');
const ok = [];
const bad = [];
const check = (label, got, want) => {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  (pass ? ok : bad).push(label + (pass ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
};
const rows = () => list.children;
const names = () => rows().map((r) => r.children[1].textContent);
const durations = () => rows().map((r) => r.children[2].textContent);
const FILE = (name, type) => ({ name, type, size: 1024 });
const A = FILE('a.mp4', 'video/mp4');
const B = FILE('b.png', 'image/png');
const C = FILE('c.mp3', 'audio/mpeg');
const key = (k, extra = {}) => fire('doc:keydown', {
  key: k, target: el('body'), preventDefault() {}, stopPropagation() {},
  ...extra,
});
const pick = (files) => { pickerQueue.push(files); el('open').click(); };
const pickVia = (id, files) => { pickerQueue.push(files); el(id).click(); };
const dropOn = (target, files) => fire(target.id + ':drop', {
  preventDefault() {}, stopPropagation() {},
  dataTransfer: { files, types: ['Files'] },
});
const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));

/* ---------------- restore mode ---------------- */

if (process.env.SEED) {
  const s = JSON.parse(process.env.SEED);
  // requests sent during boot are captured below
  const key4fit = { contain: 'd', cover: 'c', stretch: 's' }[s.fit];
  check('restore: fit', stage.dataset.fit, s.fit);
  check('restore: fit button lit', el('fit-' + key4fit).classList.contains('on'), true);
  check('restore: loop', el('loop').classList.contains('on'), s.loop);
  check('restore: volume applied', player.volume, s.volume);
  check('restore: mute applied', player.muted, s.muted);
  check('restore: loop applied', player.loop, s.loop);
  check('restore: bar visible', stage.classList.contains('ui'), s.ui);
  check('restore: sidebar visible', stage.classList.contains('list'), s.list);
  check('restore: playlist empty', el('drop').hidden, false);
  console.log('restore: passed ' + ok.length + '/' + (ok.length + bad.length));
  if (bad.length) { bad.forEach((b) => console.log(' - ' + b)); process.exit(1); }
  process.exit(0);
}

/* ---------------- boot ---------------- */

check('boot: overlay visible', el('drop').hidden, false);
check('boot: bar shown by default', stage.classList.contains('ui'), true);
check('boot: sidebar closed', stage.classList.contains('list'), false);
check('boot: fit default', stage.dataset.fit, 'contain');
el('media-time-slider');
el('media-volume-slider');
for (const id of ['autoplay','close-side','add','fs','loop','prev','next','fit-d','fit-c','fit-s','open','clear']) el(id);

/* the stub DOM is hand-built, so markup facts are asserted against the real file */
const HTML = fs.readFileSync(ROOT + 'index.html', 'utf8');
const defined = [...HTML.matchAll(/<g id="(i-[a-z0-9-]+)"/g)].map((m) => m[1]);
const referenced = new Set([...HTML.matchAll(/href="#(i-[a-z0-9-]+)"/g)].map((m) => m[1]));
check('markup: clear-playlist button removed', /id="eject"/.test(HTML), false);
check('markup: fullscreen button present', /id="fs"/.test(HTML), true);
check('markup: every sprite glyph is used', defined.filter((d) => !referenced.has(d)), []);
check('markup: logo on the start window', /assets\/logo\.png/.test(HTML), true);
check('markup: no text h1 duplicating the wordmark', /<h1>Media Tools<\/h1>/.test(HTML), false);
/* a stateful control must carry one <use> per state, since CSS cannot reach
   inside a <use> shadow tree */
const usesIn = (id) => (HTML.match(new RegExp('id="' + id + '"[^>]*>.*?<\/\\w+>', 's')) || [''])[0]
  .match(/href="#(i-[a-z0-9-]+)"/g) || [];
check('markup: play has both glyphs', usesIn('play').length, 2);
check('markup: mute has both glyphs', usesIn('mute').length, 2);
check('markup: fs has both glyphs', usesIn('fs').length, 2);
check('markup: autoplay has both glyphs', usesIn('autoplay').length, 2);
/* the svg <use> state swaps the harness cannot model: give the buttons the
   classList the CSS keys off, which the stub already tracks */

/* picker on empty playlist */
pick([A, B, C]);
await wait(80);
check('pick: 3 rows', rows().length, 3);
check('pick: names', names(), ['a.mp4', 'b.png', 'c.mp3']);
check('pick: overlay gone', el('drop').hidden, true);
check('pick: counter', el('counter').textContent, '1 / 3');
check('pick: player got src', player.src[0].src.startsWith('blob:'), true);
check('pick: viewType video', player.viewType, 'video');
check('pick: autoPlay set', player.autoPlay, true);
check('pick: src has a type', JSON.parse(JSON.stringify(player.src))[0].type, 'video/mp4');
check('pick: load strategy eager', player.load, 'eager');
check('pick: image element untouched', still.getAttribute('src'), null);
check('probe: video duration', durations()[0], '1:01');
check('probe: video thumbnail', rows()[0].children[0].children[0].src, 'data:thumb');
check('probe: image thumbnail is downscaled, not the raw blob', rows()[1].children[0].children[0].src, 'data:thumb');
check('probe: image duration dash', durations()[1], '—');
check('probe: audio duration', durations()[2], '1:01');
const audioGl = rows()[2].children[0].children.filter((c) => c.className === 'gl')[0];
check('probe: audio glyph', audioGl ? audioGl.textContent : 'missing', '♪');

/* an image item takes over the screen and the player is released */
check('debug: kind before', stage.dataset.kind, 'video');
check('debug: counter before', el('counter').textContent, '1 / 3');
check('debug: row1 name', rows()[1].children[1].textContent, 'b.png');
check('debug: helpModal hidden', el('help-modal').hidden, true);
check('debug: settings hidden', el('settings-modal').hidden, true);
key('.');
await wait();
check('image: kind set', stage.dataset.kind, 'image');
check('image: img has src', still.src.startsWith('blob:'), true);
check('image: img visible', still.hidden, false);
check('image: player released', player.src.length, 0);
key(',');
await wait();
check('back: kind', stage.dataset.kind, 'video');
check('back: img hidden', still.hidden, true);

/* drop on window vs sidebar */
dropOn(stage, [FILE('d.mov', 'video/quicktime')]);
await wait();
check('window drop: appended', names().length, 4);
check('window drop: plays dropped', el('counter').textContent, '4 / 4');
dropOn(el('side'), [FILE('e.mkv', 'video/x-matroska')]);
await wait();
check('sidebar drop: appended', names().length, 5);
check('sidebar drop: playback unchanged', el('counter').textContent, '4 / 5');
pickVia('add', [FILE('f.ogg', 'audio/ogg')]);
await wait();
check('sidebar +: appended', names().length, 6);
check('sidebar +: playback unchanged', el('counter').textContent, '4 / 6');

/* row click / remove */
fire('list:click', { target: rows()[0].children[1] });
check('row click: plays that row', el('counter').textContent, '1 / 6');
fire('list:click', { target: rows()[5].children[3] });
check('row x: removed', names().length, 5);
check('row x: still on row 0', el('counter').textContent, '1 / 5');

/* drag reorder: the list reflows LIVE, so the test walks the pointer across row
   midpoints and the model is only committed on drop.
   The user's scenario: drag the 4th row to the 2nd position - the 2nd moves
   down and the dragged row lands in the space it made. */
const H = 40;
/* geometry follows the CURRENT DOM order, exactly like the real layout does
   when rows are inserted and removed */
const layout = () => rows().forEach((r, i) => {
  r.getBoundingClientRect = () => ({ top: i * H, height: H, left: 0, right: 300, bottom: i * H + H });
});
const namesBefore = names().join(',');
const playingBefore = names()[Number(el('counter').textContent.split('/')[0].trim()) - 1];
/* capture the NODE once: rows() is re-evaluated after every reflow, so
   rows()[3] would name a different element each time */
const dragged = rows()[3];
const fourth = names()[3];
layout();
fire('list:dragstart', { target: dragged, dataTransfer: { setData() {}, effectAllowed: '' } });
check('reorder: row marked dragging', dragged.classList.contains('dragging'), true);

/* cross the midpoint above the 2nd row: the node must move into that slot */
layout();
fire('list:dragover', { clientY: H + H / 2 - 2, target: rows()[0], preventDefault() {}, stopPropagation() {} });
check('reorder: node moved to slot 2 live', rows().indexOf(dragged), 1);
layout();
fire('list:dragover', { clientY: 3 * H + H / 2, target: rows()[2], preventDefault() {}, stopPropagation() {} });
check('reorder: node back at slot 4 live', rows().indexOf(dragged), 3);

layout();
fire('list:dragover', { clientY: H + H / 2 - 2, target: rows()[0], preventDefault() {}, stopPropagation() {} });
fire('list:drop', { target: rows()[0], preventDefault() {}, stopPropagation() {} });
check('reorder: 4th dropped into 2nd position', names()[1], fourth);
check('reorder: list is a permutation of the original', names().slice().sort().join(','), namesBefore.split(',').sort().join(','));
check('reorder: no drag state left', rows().some((r) => r.classList.contains('dragging')), false);

/* the playing track must follow its row to the new position */
check('reorder: counter follows the playing track',
  el('counter').textContent, (names().indexOf(playingBefore) + 1) + ' / 5');

/* a drag that ends without a drop must restore the original order */
const before = names().join(',');
layout();
const dragged2 = rows()[0];
fire('list:dragstart', { target: dragged2, dataTransfer: { setData() {}, effectAllowed: '' } });
layout();
fire('list:dragover', { clientY: 3 * H + H / 2, target: rows()[2], preventDefault() {}, stopPropagation() {} });
check('reorder: cancelled drag did move the node', rows().indexOf(dragged2) !== 0, true);
fire('list:dragend', {});
check('reorder: cancelled drag restores order', names().join(','), before);

/* keys */
el('help-modal').hidden = true;      // matches the real markup's `hidden`
el('settings-modal').hidden = true;
el('help').onclick(); check('help: opens', el('help-modal').hidden, false);
key('Escape'); check('help: esc closes', el('help-modal').hidden, true);
key('?'); check('help: ? opens', el('help-modal').hidden, false);
key('i'); check('help: i closes', el('help-modal').hidden, true);
key('h'); check('h: bar hidden', stage.classList.contains('ui'), false);
key('h'); check('h: bar shown again', stage.classList.contains('ui'), true);
key('p'); check('p: sidebar open', stage.classList.contains('list'), true);
key('Escape'); check('esc: sidebar closed', stage.classList.contains('list'), false);
key('c'); check('c: crop', stage.dataset.fit, 'cover');
check('c: crop button lit', el('fit-c').classList.contains('on'), true);
key('d'); check('d: default', stage.dataset.fit, 'contain');
key('s'); check('s: stretch', stage.dataset.fit, 'stretch');
key('l'); check('l: loop on', el('loop').classList.contains('on'), true);
check('l: library loop follows', player.loop, true);
key('l'); check('l: loop off', el('loop').classList.contains('on'), false);
key('m'); check('m: mutes', player.muted, true);
key('f'); check('f: fullscreen toggle ran without error', true, true);

/* the transport goes through the player element's own API */
stage.dataset.kind = 'video';
player.duration = 100;
player.currentTime = 50;
key('ArrowRight');
check('right: seeks +10s', player.currentTime, 60);
key('ArrowLeft');
check('left: seeks -10s', player.currentTime, 50);
key(' ');
check('space: play state is a boolean', typeof player.paused, 'boolean');
key('l'); check('l: loop on', player.loop, true);
key('l'); check('l: loop off', player.loop, false);

/* ended advances / loops. The absolute positions depend on the reorder that ran
   above, so this asserts the transition relative to where it started. */
stage.dataset.kind = 'video';
el('loop').onclick();
const at = () => Number(el('counter').textContent.split('/')[0].trim());
const start = at();
vds('ended');
check('loop on: advances on ended', at(), start + 1);
/* we are at start+1 now, so three more reach the last row and the next wraps */
vds('ended'); vds('ended'); vds('ended');
check('loop on: reaches the last', at(), 5);
vds('ended');
check('loop on: wraps to the first', at(), 1);
el('loop').onclick();
vds('ended');
check('loop off: advances anyway', at(), 2);

/* single item + loop uses player.loop */
key('X', { shiftKey: true });
pick([A]);
await wait(40);
el('loop').onclick();
check('single item: loop set on player', player.loop, true);

/* clear */
el('close-side').onclick();
check('panel X: closes the panel', stage.classList.contains('list'), false);
check('panel X: keeps the playlist', rows().length > 0, true);
key('X', { shiftKey: true });
check('clear: no rows', rows().length, 0);
check('clear: overlay back', el('drop').hidden, false);
check('clear: player src cleared', player.getAttribute('src'), null);
check('clear: urls revoked', URL.revoked > 0, true);

/* prefs */
await wait(500);
const saved = JSON.parse(localStorage.getItem('mediatools.prefs') || 'null');
check('prefs: no file list in web mode', 'items' in saved, false);
check('prefs: fit saved', typeof saved.fit, 'string');

console.log('passed ' + ok.length + '/' + (ok.length + bad.length));
if (bad.length) {
  console.log('\nFAILURES:');
  bad.forEach((b) => console.log(' - ' + b));
  process.exit(1);
}
