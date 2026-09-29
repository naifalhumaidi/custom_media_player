const $ = (id) => document.getElementById(id);
const source = window.MediaSource;
const media = window.MediaBridge;
const settings = window.MediaSettings;
const { t, num } = window.I18n;
media.init();

const stage = $('stage');
const side = $('side');
const list = $('list');
const drop = $('drop');
const total = $('total');
const still = $('still');

const SEEK_STEP = 10;
const VOL_STEP = 0.05;
const THUMB_W = 160;
const FITS = { d: 'contain', c: 'cover', s: 'stretch' };
const FIT_LABEL = { d: 'Default', c: 'Crop', s: 'Stretch' };

let items = [];
let index = 0;
let loop = false;
let autoStart = true;
let saveTimer = 0;

const mod = (n, m) => ((n % m) + m) % m;

function fmt(s) {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  /* pad BEFORE localising, and localise digit by digit: running "01" through
     Intl.NumberFormat would parse it as 1 and throw the leading zero away */
  const pad = (v) => String(v).padStart(2, '0').split('').map((ch) => num(ch)).join('');
  return (h ? num(h) + ':' + pad(m) : num(m)) + ':' + pad(sec);
}

function once(el, event, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      el.removeEventListener(event, ok);
      reject(new Error('timeout ' + event));
    }, ms);
    const ok = () => {
      clearTimeout(timer);
      el.removeEventListener(event, ok);
      resolve();
    };
    el.addEventListener(event, ok);
  });
}

/* ---------------- probing: duration + thumbnail ---------------- */

function drawThumb(el) {
  const w = el.videoWidth;
  const h = el.videoHeight;
  if (!w || !h) return null;
  const scale = THUMB_W / w;
  const canvas = document.createElement('canvas');
  canvas.width = THUMB_W;
  canvas.height = Math.max(1, Math.round(h * scale));
  canvas.getContext('2d').drawImage(el, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.6);
}

async function probe(item) {
  if (item.kind === 'image') {
    item.thumb = source.urlFor(item);
    return item;
  }

  /* a detached media element only reads metadata (and grabs a frame for
     video). It is never in the document, so it cannot disturb the player. */
  const el = document.createElement(item.kind === 'audio' ? 'audio' : 'video');
  el.muted = true;
  el.playsInline = true;
  el.preload = 'metadata';
  el.src = source.urlFor(item);

  try {
    await once(el, 'loadedmetadata', 5000);
    if (Number.isFinite(el.duration)) item.duration = el.duration;
    if (el.videoWidth) {
      el.currentTime = Math.min(0.1, el.duration / 2);
      await once(el, 'seeked', 3000);
      item.thumb = drawThumb(el);
    }
  } catch {}

  el.removeAttribute('src');
  el.load();
  return item;
}

async function probeAll(batch) {
  let next = 0;
  const worker = async () => {
    while (next < batch.length) {
      const item = batch[next++];
      await probe(item);
      refreshRow(item);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
}

/* ---------------- playlist ---------------- */

function addItems(incoming, play) {
  const fresh = incoming.map((it) => ({ ...it, duration: null, thumb: null, position: 0 }));
  if (!fresh.length) return;
  const wasEmpty = items.length === 0;
  items = items.concat(fresh);
  drop.hidden = true;
  renderEmptyState();
  if (wasEmpty || play) load(wasEmpty ? 0 : items.length - fresh.length, true);
  else render();
  probeAll(fresh);
  scheduleSave();
}

function removeItem(i) {
  if (i < 0 || i >= items.length) return;
  const current = items[index];
  source.release(items[i]);
  items.splice(i, 1);
  if (!items.length) return clearAll();
  if (items[i] === current) load(Math.min(i, items.length - 1), true);
  else {
    index = Math.max(0, items.indexOf(current));
    render();
    scheduleSave();
  }
}

function moveItem(from, to) {
  if (from === to || from < 0 || from >= items.length) return;
  const current = items[index];
  const [moved] = items.splice(from, 1);
  items.splice(to, 0, moved);
  index = Math.max(0, items.indexOf(current));
  render();
  scheduleSave();
}

function clearAll() {
  for (const it of items) source.release(it);
  items = [];
  index = 0;
  media.clear();
  stage.dataset.kind = '';
  drop.hidden = false;
  renderEmptyState();
  $('title').textContent = '';
  $('counter').textContent = '';
  render();
  scheduleSave();
}

function load(i, play) {
  if (!items.length) return;
  index = mod(i, items.length);
  const it = items[index];
  stage.dataset.kind = it.kind;

  media.load({ url: source.urlFor(it), mime: it.mime, position: it.position }, it.kind, play);

  /* a still image has no timeline, so it never counts as "playing" */
  syncIcons(!!play && it.kind !== 'image');
  setTimeout(syncIcons, 0);

  render();
  scheduleSave();
}

function step(dir) {
  if (!items.length) return;
  load(index + dir, autoStart);
}

function toggle() {
  if (!items.length) return;
  if (stage.dataset.kind === 'image') return step(1);
  media.toggle();
}

function seekBy(delta) {
  if (stage.dataset.kind === 'image') return;
  media.seekBy(delta);
}

function syncToggleTitles() {
  $('loop').title = loop ? t('bar.loopOn') : t('bar.loopKey');
  $('autoplay').title = autoStart ? t('bar.autoplayKey') : t('bar.autoplayOff');
}

function toggleLoop() {
  loop = !loop;
  $('loop').classList.toggle('on', loop);
  syncToggleTitles();
  media.setLoop(loop);
  scheduleSave();
}

function toggleAutoStart() {
  autoStart = !autoStart;
  $('autoplay').classList.toggle('on', autoStart);
  $('autoplay').classList.toggle('off', !autoStart);
  syncToggleTitles();
  scheduleSave();
}

function setFit(mode) {
  if (!mode) return;
  stage.dataset.fit = mode;
  for (const key of Object.keys(FITS)) {
    $('fit-' + key).classList.toggle('on', FITS[key] === mode);
  }
  scheduleSave();
}

function setUi(on) {
  stage.classList.toggle('ui', on);
  publishBarHeight();
  scheduleSave();
}

/* the playlist panel must not squeeze the bar: it stops at the bar's top edge */
function publishBarHeight() {
  const bar = $('bar');
  stage.style.setProperty('--bar-h', bar.offsetHeight + 'px');
}

function setList(on) {
  stage.classList.toggle('list', on);
  renderEmptyState();
  scheduleSave();
}

/* An empty playlist still needs to say so, and the panel must be usable: the
   start overlay sits below the panel, so `p` works with nothing loaded. */
function renderEmptyState() {
  const open = stage.classList.contains('list') && !items.length;
  const note = $('side-empty');
  if (note) note.hidden = !open;
  list.hidden = open;
}

/* ---------------- rendering ---------------- */

function thumbNode(item) {
  const box = document.createElement('span');
  box.className = 'thumb';
  const kind = document.createElement('span');
  kind.className = 'kd';
  kind.textContent = item.kind[0];
  box.append(kind);
  if (item.thumb) {
    const img = document.createElement('img');
    img.src = item.thumb;
    img.alt = '';
    box.prepend(img);
  } else {
    const glyph = document.createElement('span');
    glyph.className = 'gl';
    glyph.textContent = item.kind === 'audio' ? '♪' : item.kind === 'image' ? '▢' : '▣';
    box.append(glyph);
  }
  return box;
}

function renderList() {
  list.textContent = '';
  items.forEach((item, i) => {
    const li = document.createElement('li');
    li.dataset.i = String(i);
    li.draggable = true;
    li.classList.toggle('on', i === index);

    const name = document.createElement('span');
    name.className = 'nm';
    name.textContent = item.name;
    name.title = item.path || item.name;

    const dur = document.createElement('span');
    dur.className = 'dur';
    dur.textContent = item.kind === 'image' ? '—' : item.duration ? fmt(item.duration) : '…';

    const x = document.createElement('button');
    x.className = 'x';
    x.type = 'button';
    x.title = t('panel.remove');
    x.setAttribute('aria-label', t('panel.removeAria'));
    x.textContent = '✕';
    x.dataset.x = String(i);

    li.append(thumbNode(item), name, dur, x);
    list.append(li);
  });

  const known = items.filter((it) => it.duration);
  total.textContent = !items.length
    ? ''
    : known.length === items.length
      ? t('panel.itemsTotal', { n: num(items.length), time: fmt(known.reduce((a, b) => a + b.duration, 0)) })
      : t('panel.items', { n: num(items.length) });
}

function refreshRow(item) {
  if (items.includes(item)) renderList();
}

function render() {
  const it = items[index];
  $('title').textContent = it ? it.name : '';
  $('counter').textContent = items.length > 1 && it ? num(index + 1) + ' / ' + num(items.length) : '';
  renderList();
  list.children[index]?.scrollIntoView({ block: 'nearest' });
}

/* ---------------- persistence ---------------- */

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 400);
}

function save() {
  source.saveState({
    items: items.map((it) => ({ name: it.name, kind: it.kind, path: it.path })),
    index,
    position: media.currentTime || 0,
    fit: stage.dataset.fit,
    loop,
    autoplay: autoStart,
    volume: media.volume,
    muted: media.muted,
    ui: stage.classList.contains('ui'),
    list: stage.classList.contains('list'),
    settings: settings.save(),
  });
}

/* ---------------- input ---------------- */

async function pick(play) {
  const picked = (await source.openFiles()).filter((it) => it.kind);
  if (picked.length) addItems(picked, play);
}

/* Transport UI is Vidstack's: <media-play-button>, <media-seek-button>,
   <media-mute-button>, <media-volume-slider>, <media-time-slider>,
   <media-time> and <media-fullscreen-button> own their own state. We only
   wire the controls the library has no equivalent for. */

$('next').onclick = () => step(1);
$('prev').onclick = () => step(-1);
$('loop').onclick = toggleLoop;
$('autoplay').onclick = toggleAutoStart;
for (const key of Object.keys(FITS)) $('fit-' + key).onclick = () => setFit(FITS[key]);
$('fs').onclick = () => media.toggleFullscreen();
$('open').onclick = () => pick(true);
$('add').onclick = () => pick(false);

/* The library's sliders keep correct state and ARIA values, but their
   `--slider-fill` custom property stays at 0% in v1.15.6, so we paint the
   fill ourselves from the same events. The library still owns dragging,
   keyboard control and accessibility. */
const timeSlider = document.querySelector('media-time-slider');
const volumeSlider = document.querySelector('media-volume-slider');

const paint = (el, ratio) => el && el.style.setProperty('--mt-fill', (ratio * 100).toFixed(2) + '%');

window.addEventListener('resize', () => {
  publishBarHeight();
  scheduleSave();
});

if (typeof ResizeObserver === 'function') {
  new ResizeObserver(publishBarHeight).observe($('bar'));
}

media.on('time', ({ currentTime }) => {
  if (stage.dataset.kind === 'image') return;
  if (items[index]) items[index].position = currentTime;
  const d = media.duration;
  paint(timeSlider, Number.isFinite(d) && d > 0 ? currentTime / d : 0);
});

/* The <img> sits above the player so a click on a picture never reaches the
   library's play/pause gesture, and it must not skip the image either. Use
   Space/Enter, the next button, or "." to move on. */

media.on('pause', scheduleSave);
media.on('play', scheduleSave);
media.on('ended', () => {
  if (items.length > 1) load(index + 1, autoStart);
});

media.on('error', () => {
  if (items.length > 1) step(1);
});

$('media').addEventListener('volume-change', () => {
  paint(volumeSlider, media.volume);
  $('mute').classList.toggle('muted', media.muted || media.volume === 0);
});
paint(volumeSlider, media.volume);

/* The class is the single source of truth the CSS keys off: "playing" present
   means the pause glyph shows. An argument lets the caller state the intent
   before the library has swapped the provider, because a track that loads
   paused fires no play/pause event at all. */
function syncIcons(playing) {
  $('play').classList.toggle('playing', playing === undefined ? media.playing : !!playing);
  $('mute').classList.toggle('muted', media.muted || media.volume === 0);
  const inFs = !!document.fullscreenElement;
  $('fs').classList.toggle('on', inFs);
  $('fs').title = inFs ? t('bar.fullscreenExitKey') : t('bar.fullscreenKey');
  $('fs').setAttribute('aria-label', inFs ? t('bar.fullscreenExit') : t('bar.fullscreen'));
}

/* double-click anywhere on the picture toggles fullscreen for the whole app */
stage.addEventListener('dblclick', () => media.toggleFullscreen());

/* ---------- instructions dialog ---------- */

const helpModal = $('help-modal');

function setHelp(on) {
  helpModal.hidden = !on;
  /* move focus into the dialog so Esc and Tab behave, and back out when it
     closes so the keyboard returns to the player */
  const target = on ? $('help-close') : $('help');
  if (target && typeof target.focus === 'function') target.focus();
}

$('help').onclick = () => setHelp(true);
$('help-close').onclick = () => setHelp(false);

/* One modal at a time: opening settings closes the instructions dialog and vice
   versa, so the two can never stack. The button itself is wired in settings.js
   because that module owns the dialog. */
function toggleSettings() {
  if (settings.isOpen()) return settings.close();
  setHelp(false);
  settings.open();
}

/* a click on the backdrop closes; a click inside the card must not bubble out */
helpModal.addEventListener('pointerdown', (e) => {
  if (e.target === helpModal) setHelp(false);
});

/* Clicking outside the panel closes it, the way a drawer behaves. The check
   ignores clicks that started on the panel or the bar. */
stage.addEventListener('pointerdown', (e) => {
  if (!stage.classList.contains('list')) return;
  if (e.target.closest?.('#side, #bar')) return;
  setList(false);
});

/* Wrapped, not passed by reference: an event listener hands its Event to the
   first parameter, which syncIcons would read as "the video is playing". */
const syncIconsFromEvent = () => syncIcons();
$('media').addEventListener('play', syncIconsFromEvent);
$('media').addEventListener('pause', syncIconsFromEvent);
document.addEventListener('fullscreenchange', syncIconsFromEvent);
syncIcons();

/* drop: window = add + play, sidebar = add only */

let dragTimer = 0;

function clearDragHint() {
  clearTimeout(dragTimer);
  stage.classList.remove('over');
  side.classList.remove('over');
}

function markDragHint() {
  clearTimeout(dragTimer);
  stage.classList.add('over');
  /* last-resort cleanup: a drag that ends outside the window never fires drop */
  dragTimer = setTimeout(clearDragHint, 4000);
}

stage.addEventListener('dragover', (e) => {
  e.preventDefault();
  /* a row being reordered must not paint the whole-window drop ring */
  if (dragNode) return;
  markDragHint();
});
stage.addEventListener('dragleave', (e) => {
  if (!stage.contains(e.relatedTarget)) clearDragHint();
});

/* A drag that starts over the window and is released outside of it - or handed
   back to the OS file manager - fires no drop on us, and dragleave can arrive
   with a null relatedTarget. Without these the white hint ring stays painted
   around the player for good. */
document.addEventListener('dragleave', clearDragHint);
document.addEventListener('drop', clearDragHint);
document.addEventListener('dragend', clearDragHint);
window.addEventListener('blur', clearDragHint);
stage.addEventListener('drop', (e) => {
  e.preventDefault();
  clearDragHint();
  const picked = source.dropItems(e).filter((it) => it.kind);
  if (picked.length) addItems(picked, true);
});

side.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.stopPropagation();
  /* A drag originating on a row is a reorder, not a file drop: the row's own
     dragover calls stopPropagation, so reaching here means real files. */
  if (dragNode) return;
  markDragHint();
});
side.addEventListener('dragleave', (e) => {
  if (!side.contains(e.relatedTarget)) clearDragHint();
});
side.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  clearDragHint();
  const picked = source.dropItems(e).filter((it) => it.kind);
  if (picked.length) addItems(picked, false);
});

/* sidebar: click to play, x to remove, drag to reorder */

list.addEventListener('click', (e) => {
  const x = e.target.closest?.('.x');
  if (x) return removeItem(Number(x.dataset.x));
  const li = e.target.closest?.('li');
  if (li) load(Number(li.dataset.i), autoStart);
});

/* Reorder, Haruna-style: the list reflows LIVE while dragging. Crossing a row's
   midpoint actually moves the dragged node, so the rows close the gap in real
   time and what you see mid-drag is exactly what you get on drop. The model is
   only committed once the drag ends, so a cancelled drag restores itself. */
let dragNode = null;

/* Fires when a drag ends without a drop (Escape, or released outside). The DOM
   was moved during the drag but `items` was not, so re-rendering puts every row
   back where the model says it belongs. */
function cancelDrag() {
  dragNode = null;
  renderList();
}

list.addEventListener('dragstart', (e) => {
  const li = e.target.closest?.('li');
  if (!li) return;
  dragNode = li;
  li.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', li.dataset.i);
});

list.addEventListener('dragover', (e) => {
  if (!dragNode) return;
  e.preventDefault();
  e.stopPropagation();

  const rows = [...list.children].filter((r) => r !== dragNode);
  /* the row whose midpoint we have crossed decides the new slot */
  const before = rows.find((r) => {
    const box = r.getBoundingClientRect();
    return e.clientY < box.top + box.height / 2;
  });

  if (before) {
    if (before.previousElementSibling !== dragNode) list.insertBefore(dragNode, before);
  } else if (rows.length && rows[rows.length - 1] !== dragNode) {
    list.appendChild(dragNode);
  }
});

list.addEventListener('drop', (e) => {
  if (!dragNode) return;
  e.preventDefault();
  e.stopPropagation();

  /* The DOM order is the new order. dataset.i still holds each row's ORIGINAL
     index, because the nodes were only moved, never renumbered - so reading
     them in DOM order recovers the intended permutation exactly. */
  const current = items[index];
  items = [...list.children].map((li) => items[Number(li.dataset.i)]);
  index = Math.max(0, items.indexOf(current));

  dragNode = null;
  /* render(), not renderList(): the counter has to follow the current track to
     its new position */
  render();
  scheduleSave();
});

list.addEventListener('dragend', cancelDrag);

$('close-side').onclick = () => setList(false);

/* keys */

/* Capture phase on purpose: the media library's buttons and sliders call
   stopPropagation() on keydown, so a bubbling listener never sees the key once
   a control has focus - which is why L and C stopped working. */
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  const k = e.key.toLowerCase();

  /* let the library's own sliders handle their arrow keys */
  if (e.target.closest?.('media-time-slider, media-volume-slider') && k.startsWith('arrow')) return;

  if (k === '?' || k === 'i') return setHelp(helpModal.hidden);
  if (k === 'h') return setUi(!stage.classList.contains('ui'));
  if (k === 'p') return setList(!stage.classList.contains('list'));
  /* the dialogs are the topmost layers, so Esc closes them before the panel */
  if (k === 'escape' && settings.isOpen()) return settings.close();
  if (k === 'escape' && !helpModal.hidden) return setHelp(false);
  if (k === 'escape' && stage.classList.contains('list')) return setList(false);
  if (k === ',') return step(-1);
  if (k === '.') return step(1);
  if (FITS[k]) return setFit(FITS[k]);
  if (k === 'l') return toggleLoop();
  if (k === 'a') return toggleAutoStart();
  if (k === 'x' && e.shiftKey) return clearAll();
  if (k === 'm') return media.toggleMute();
  if (k === 'f') return media.toggleFullscreen();

  if (k === ' ' || k === 'enter' || k === 'k') {
    /* Space always means play/pause, even when a control still holds focus:
       otherwise the browser re-activates that button instead. The focus is
       dropped afterwards so the next press behaves the same again. */
    const focused = e.target;
    if (focused && focused !== document.body && typeof focused.blur === 'function') focused.blur();
    e.preventDefault();
    e.stopPropagation();
    if (k !== 'k' && stage.dataset.kind === 'image') return step(1);
    toggle();
    return;
  }
  if (k === 'arrowleft') {
    if (stage.dataset.kind === 'image') return;
    media.seekBy(-SEEK_STEP);
    e.preventDefault();
    return;
  }
  if (k === 'arrowright') {
    if (stage.dataset.kind === 'image') return;
    media.seekBy(SEEK_STEP);
    e.preventDefault();
    return;
  }
  if (k === 'arrowup' || k === 'arrowdown') {
    media.setVolume(media.volume + (k === 'arrowup' ? VOL_STEP : -VOL_STEP));
    e.preventDefault();
  }
}, true);

/* ---------------- boot ---------------- */

async function restore() {
  const state = await source.loadState();

  /* language + brand colour + logo first: the strings and the styles both
     depend on them */
  settings.load(state);
  localizeTimePlaceholder();
  if (state?.fit) stage.dataset.fit = state.fit;

  setFit(stage.dataset.fit);
  setUi(!!state?.ui);
  setList(!!state?.list);

  if (typeof state?.volume === 'number') media.setVolume(state.volume);
  if (typeof state?.loop === 'boolean' && state.loop) toggleLoop();
  if (state?.autoplay === false) toggleAutoStart();
  if (state?.muted) media.toggleMute();

  if (!state?.items?.length) return;

  items = state.items.map((it) => ({ ...it, duration: null, thumb: null, position: 0 }));
  drop.hidden = true;
  index = mod(state.index || 0, items.length);
  items[index].position = state.position || 0;
  load(index, false);
  probeAll(items);
}

/* settings first: the language decides every string, and the brand colour is
   read by the stylesheets on the very first paint */
settings.wire();

/* a language / colour / logo change has to reach storage */
document.addEventListener('mediatools:settings', scheduleSave);

/* Anything the app builds in JS (tooltips, counts, durations) is not covered by
   the data-i18n sweep, so re-render it when the language changes. */
function localizeTimePlaceholder() {
  /* the library writes these itself once media is loaded, and it follows the
     document language; only the empty placeholder is ours to translate */
  if (($('media').getAttribute('src') || '').length > 2) return;
  const zero = num(0) + ':' + String('00').padStart(2, '0').split('').map((c) => num(c)).join('');
  document.querySelectorAll('media-time').forEach((el) => { el.textContent = zero; });
}

window.I18n.onChange(() => {
  syncIcons();
  syncToggleTitles();
  localizeTimePlaceholder();
  render();
});

restore();
