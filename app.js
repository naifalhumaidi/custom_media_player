const $ = (id) => document.getElementById(id);
const source = window.MediaSource;
const media = window.MediaBridge;
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
let dragFrom = -1;
let saveTimer = 0;

const mod = (n, m) => ((n % m) + m) % m;

function fmt(s) {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
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

function toggleLoop() {
  loop = !loop;
  $('loop').classList.toggle('on', loop);
  $('loop').title = 'Loop playlist (L)' + (loop ? ' — on' : '');
  media.setLoop(loop);
  scheduleSave();
}

function toggleAutoStart() {
  autoStart = !autoStart;
  $('autoplay').classList.toggle('on', autoStart);
  $('autoplay').classList.toggle('off', !autoStart);
  $('autoplay').title =
    'Auto-start on track change (a)' + (autoStart ? ' — on' : ' — off');
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
  scheduleSave();
}

function setList(on) {
  stage.classList.toggle('list', on);
  scheduleSave();
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
    x.title = 'Remove';
    x.textContent = '✕';
    x.dataset.x = String(i);

    li.append(thumbNode(item), name, dur, x);
    list.append(li);
  });

  const known = items.filter((it) => it.duration);
  total.textContent = items.length
    ? items.length + (known.length === items.length ? ' items · ' + fmt(known.reduce((a, b) => a + b.duration, 0)) : ' items')
    : '';
}

function refreshRow(item) {
  if (items.includes(item)) renderList();
}

function render() {
  const it = items[index];
  $('title').textContent = it ? it.name : '';
  $('counter').textContent = items.length > 1 && it ? index + 1 + ' / ' + items.length : '';
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
$('eject').onclick = clearAll;
$('open').onclick = () => pick(true);
$('add').onclick = () => pick(false);

/* The library's sliders keep correct state and ARIA values, but their
   `--slider-fill` custom property stays at 0% in v1.15.6, so we paint the
   fill ourselves from the same events. The library still owns dragging,
   keyboard control and accessibility. */
const timeSlider = document.querySelector('media-time-slider');
const volumeSlider = document.querySelector('media-volume-slider');

const paint = (el, ratio) => el && el.style.setProperty('--mt-fill', (ratio * 100).toFixed(2) + '%');

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

function syncIcons() {
  $('play').classList.toggle('playing', !media.playing);
  $('mute').classList.toggle('muted', media.muted || media.volume === 0);
  $('fs').classList.toggle('on', !!document.fullscreenElement);
}

/* double-click anywhere on the picture toggles fullscreen for the whole app */
stage.addEventListener('dblclick', () => media.toggleFullscreen());

$('media').addEventListener('play', syncIcons);
$('media').addEventListener('pause', syncIcons);
document.addEventListener('fullscreenchange', syncIcons);
syncIcons();

/* drop: window = add + play, sidebar = add only */

stage.addEventListener('dragover', (e) => {
  e.preventDefault();
  stage.classList.add('over');
});
stage.addEventListener('dragleave', (e) => {
  if (!stage.contains(e.relatedTarget)) stage.classList.remove('over');
});
stage.addEventListener('drop', (e) => {
  e.preventDefault();
  stage.classList.remove('over');
  const picked = source.dropItems(e).filter((it) => it.kind);
  if (picked.length) addItems(picked, true);
});

side.addEventListener('dragover', (e) => {
  e.preventDefault();
  side.classList.add('over');
});
side.addEventListener('dragleave', (e) => {
  if (!side.contains(e.relatedTarget)) side.classList.remove('over');
});
side.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  side.classList.remove('over');
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

list.addEventListener('dragstart', (e) => {
  const li = e.target.closest?.('li');
  if (!li) return;
  dragFrom = Number(li.dataset.i);
  li.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', li.dataset.i);
});

list.addEventListener('dragover', (e) => {
  if (dragFrom < 0) return;
  e.preventDefault();
  const li = e.target.closest?.('li');
  for (const row of list.children) row.classList.remove('before', 'after');
  if (!li) return;
  const box = li.getBoundingClientRect();
  li.classList.add(e.clientY < box.top + box.height / 2 ? 'before' : 'after');
});

list.addEventListener('drop', (e) => {
  if (dragFrom < 0) return;
  e.preventDefault();
  e.stopPropagation();
  const li = e.target.closest?.('li');
  const to = li ? Number(li.dataset.i) : items.length - 1;
  const from = dragFrom;
  dragFrom = -1;
  for (const row of list.children) row.classList.remove('dragging', 'before', 'after');
  moveItem(from, to);
});

list.addEventListener('dragend', () => {
  dragFrom = -1;
  for (const row of list.children) row.classList.remove('dragging', 'before', 'after');
});

$('close-side').onclick = () => setList(false);

/* keys */

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  const k = e.key.toLowerCase();

  /* let the library's own sliders handle their arrow keys */
  if (e.target.closest?.('media-time-slider, media-volume-slider') && k.startsWith('arrow')) return;

  if (k === 'h') return setUi(!stage.classList.contains('ui'));
  if (k === 'p') return setList(!stage.classList.contains('list'));
  if (k === 'escape' && stage.classList.contains('list')) return setList(false);
  if (k === ',') return step(-1);
  if (k === '.') return step(1);
  if (FITS[k]) return setFit(FITS[k]);
  if (k === 'l') return toggleLoop();
  if (k === 'a') return toggleAutoStart();
  if (k === 'm') return media.toggleMute();
  if (k === 'f') return media.toggleFullscreen();

  if (k === ' ' || k === 'enter' || k === 'k') {
    /* a focused button already handles its own activation */
    if (e.target.tagName === 'BUTTON') return;
    if (k !== 'k' && e.target.closest?.('media-play-button, media-seek-button, media-mute-button, media-fullscreen-button')) return;
    if (k !== 'k' && stage.dataset.kind === 'image') return step(1);
    toggle();
    e.preventDefault();
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
});

/* ---------------- boot ---------------- */

async function restore() {
  const state = await source.loadState();

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

$('mode').textContent = source.canPersist()
  ? ''
  : 'web preview — the playlist lives in memory only, a refresh clears it';
restore();
