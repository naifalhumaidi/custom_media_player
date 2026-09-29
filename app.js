const $ = (id) => document.getElementById(id);
const noticeEl = $('notice');
let noticeTimer = 0;

/* A message the user actually sees. Every failure used to be silent, which is
   indistinguishable from the app having hung.

   Two lifetimes, because the messages mean different things:
     - "press play to start" / "cannot play this file" describe the CURRENT
       state, so they are cleared the moment the media actually starts;
     - "3 files cannot be played here" describes something that has already
       happened and cannot be undone, so playback does not retire it. It simply
       times out. Clearing it when the video started was hiding the refusal the
       instant the video loaded. */
function notice(text, { sticky = false, ms = 4000 } = {}) {
  if (!noticeEl || !text) return;
  noticeEl.textContent = text;
  noticeEl.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { noticeEl.hidden = true; }, ms);
  noticeSticky = sticky;
}
let noticeSticky = false;
const clearNotice = () => {
  if (noticeSticky) return;
  clearTimeout(noticeTimer);
  if (noticeEl) noticeEl.hidden = true;
};
const source = window.MediaFileSource;
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

let items = [];
let index = 0;
let loop = false;
let autoStart = true;
let saveTimer = 0;
/* The row currently being reordered, or null. Declared with the rest of the
   state because renderList() reads it, and renderList() can run before the
   reorder section is reached. */
let dragNode = null;
/* One failure is allowed per track, so a playlist of unplayable files skips
   forward instead of bouncing between two broken items forever. */
let erroredIndex = -1;
/* False until the saved state has been applied. A desktop source reads it over
   IPC, so anything added in that window would be silently overwritten by the
   restore that lands afterwards. Input is not refused - it is queued, because
   dropping a file the user just dragged is worse than playing it a moment
   late. */
let ready = false;
let queued = null;
/* Shift+X destroys an hours-long ordering with no way back, and the browser
   source cannot re-resolve files, so recovery has to happen before the release.
   The File handles are kept until the next change replaces them. */
let undo = null;
let undoTimer = 0;

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

/* Same job for a still image, which has no videoWidth/videoHeight. A file that
   is not a decodable image must leave the row on its placeholder glyph rather
   than reject and take the probe queue down. */
async function drawImageThumb(url) {
  try {
    const img = new Image();
    img.src = url;
    /* the fallback must be able to FAIL: without an onerror, a corrupt image
       never settles and permanently occupies one of the three probe workers */
    await (img.decode
      ? img.decode()
      : new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; }));
    if (!img.naturalWidth) return null;
    const scale = THUMB_W / img.naturalWidth;
    const canvas = document.createElement('canvas');
    canvas.width = THUMB_W;
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.6);
  } catch {
    return null;
  }
}

async function probe(item) {
  /* An image row used to carry the item's own blob URL, so a playlist of large
     photos made the browser hold and decode every original just to paint a
     160px row. Downscale once, like the video path does. */
  if (item.kind === 'image') {
    item.thumb = await drawImageThumb(source.urlFor(item));
    return item;
  }

  /* a detached media element only reads metadata (and grabs a frame for
     video). It is never in the document, so it cannot disturb the player. */
  const el = document.createElement(item.kind === 'audio' ? 'audio' : 'video');
  el.muted = true;
  el.playsInline = true;
  el.preload = 'metadata';
  try {
    el.src = source.urlFor(item);
  } catch (err) {
    /* unresolvable item: leave the row on its placeholder rather than
       rejecting and taking the whole batch with it */
    console.warn('[app] cannot resolve', item.name, err);
    return item;
  }

  try {
    /* Short on purpose: a file that never reports metadata would otherwise
       hold a worker for the full timeout. At three workers, a few hundred
       unreadable files put the queue minutes behind and the panel looks
       frozen with no indication anything is happening. */
    await once(el, 'loadedmetadata', 2500);
    if (Number.isFinite(el.duration)) item.duration = el.duration;
    /* A streamed or open-ended source reports Infinity. Discarding it left the
       row at "..." forever and the total permanently unavailable, so it is
       recorded as open-ended and rendered as such. */
    else if (el.duration === Infinity) item.duration = null, item.openEnded = true;
    if (el.videoWidth) {
      el.currentTime = Math.min(0.1, el.duration / 2);
      await once(el, 'seeked', 2000);
      item.thumb = drawThumb(el);
    }
  } catch {}

  el.removeAttribute('src');
  el.load();
  return item;
}

/* probeAll's promise is deliberately not awaited by its callers - probing is
   background work - but a rejection must not be left unhandled: one
   unresolvable item would otherwise take the rest of the batch's durations
   with it and surface as nothing at all. */
function runProbes(batch) {
  probeAll(batch).catch((err) => console.warn('[app] the probe queue stopped:', err));
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
  if (!incoming || !incoming.length) return;
  /* the list has moved on, so a pending undo would restore a state the user
     has since replaced */
  undo = null;
  clearTimeout(undoTimer);
  /* Hold until the restore has landed, then apply in arrival order. Anything
     added now would otherwise be wiped by the restore that follows. */
  if (!ready) {
    queued = (queued || []).concat([{ items: incoming, play }]);
    return;
  }
  const fresh = incoming.map((it) => ({ ...it, duration: null, thumb: null, position: 0 }));
  if (!fresh.length) return;
  const wasEmpty = items.length === 0;
  items = items.concat(fresh);
  drop.hidden = true;
  renderEmptyState();
  if (wasEmpty || play) load(wasEmpty ? 0 : items.length - fresh.length, true);
  else render();
  runProbes(fresh);
  scheduleSave();
}

/* Put back a list cleared a moment ago. The window is short on purpose: an
   undo that never expires is just a second copy of the playlist. */
function restoreCleared() {
  if (!undo) return;
  const saved = undo;
  undo = null;
  clearTimeout(undoTimer);
  /* Replace the list, do not append to it: addItems() concatenates, so an
     undo after a fresh drop produced the two lists merged and then indexed
     the old position into the combined array. */
  if (items.length) clearAll(false);
  items = saved.items.slice();
  index = 0;
  render();
  if (items.length) load(Math.min(saved.index, items.length - 1), false);
  notice(t('notice.restored', { n: num(items.length) }));
}

function removeItem(i) {
  if (i < 0 || i >= items.length) return;
  undo = null;
  clearTimeout(undoTimer);
  const wasCurrent = i === index;
  const nextIndex = i < index ? index - 1 : index;
  const removed = items[i];
  items.splice(i, 1);

  if (!items.length) {
    source.release(removed);
    /* removing the last row is an explicit, single-item action; it needs no
       undo window */
    return clearAll(false);
  }

  /* Only reload when the row that was playing is the row that went away.
     The old test compared `items[i]` AFTER the splice, which is the item that
     shifted down into that slot - so deleting any row ABOVE the current one
     reloaded the current track (and passed play=true, overriding auto-start),
     while deleting the current row itself left the index at 0.

     The swap happens before the release, so the player is never left pointing
     at a URL that has already been revoked. */
  if (wasCurrent) {
    load(Math.min(nextIndex, items.length - 1), autoStart);
    source.release(removed);
    return;
  }

  /* the player is not reading `removed`, so the URL can go now */
  source.release(removed);
  index = nextIndex;
  render();
  scheduleSave();
}

function clearAll(keepUndo) {
  /* Let go of the media FIRST, then revoke. Revoking an object URL the player
     is still pointed at is a use-after-free of the resource by construction -
     it appears to work only because the next assignment happens to abort the
     in-flight fetch, which is an implementation detail, not a guarantee. */
  media.clear();
  /* release() is reversible: it hands back the URL and keeps the File, so the
     list can be put back exactly as it was. Shift+X destroys an hours-long
     ordering with no other way back, because the browser source cannot
     re-resolve a file that was never stored. */
  if (keepUndo && items.length) {
    undo = { items: items.slice(), index };
    clearTimeout(undoTimer);
    undoTimer = setTimeout(() => { undo = null; }, 30000);
  }
  for (const it of items) source.release(it);
  items = [];
  index = 0;
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
  erroredIndex = -1;
  const it = items[index];
  stage.dataset.kind = it.kind;

  let url;
  try {
    url = source.urlFor(it);
  } catch (err) {
    /* The source cannot produce something playable for this item. `items` and
       the DOM have already been updated by this point, so bail out visibly
       rather than letting the throw escape into whatever called load(). */
    console.warn('[app] cannot resolve', it.name, err);
    notice(t('notice.cannotPlay'));
    return;
  }
  media.load({ url, mime: it.mime, position: it.position }, it.kind, play);

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
  /* the on/off state is a flat tint on screen, which conveys nothing to a
     screen reader, so it has to be stated as well */
  $('loop').setAttribute('aria-pressed', String(loop));
  $('autoplay').setAttribute('aria-pressed', String(autoStart));
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
  /* a drag owns the DOM until it ends; re-rendering would detach the dragged
     node and the drop would apply a stale permutation */
  if (dragNode) return;
  list.textContent = '';
  items.forEach((item, i) => {
    const li = document.createElement('li');
    li.dataset.i = String(i);
    li.draggable = true;
    /* A row is the only way to pick a track, so it has to be reachable and
       operable from the keyboard, not just clickable. Reordering by keyboard is
       still a known gap. */
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    if (i === index) li.setAttribute('aria-current', 'true');
    li.classList.toggle('on', i === index);

    const name = document.createElement('span');
    name.className = 'nm';
    name.textContent = item.name;
    name.title = item.path || item.name;

    const dur = document.createElement('span');
    dur.className = 'dur';
    dur.textContent = item.kind === 'image' ? '—' : item.duration ? fmt(item.duration) : (item.openEnded ? '∞' : '…');

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

  updateTotal();
}

/* One probe finishing used to rebuild the whole list. With a few thousand files
   that is O(n^2) element churn and the UI locks up, so only the affected row is
   touched. A drag is never re-rendered: the dragged node is moved in the DOM by
   hand, and replacing the list mid-drag detaches it and corrupts the reorder. */
function refreshRow(item) {
  if (dragNode) return;
  const i = items.indexOf(item);
  if (i < 0) return;
  const li = list.children[i];
  if (!li) return renderList();
  /* Replace the existing thumb, never prepend a second one: an extra child
     would shift every later cell and corrupt the row's layout. */
  const existing = li.querySelector?.('.thumb') || li.firstElementChild || li.children[0];
  const nextThumb = thumbNode(item);
  if (existing && existing.replaceWith) existing.replaceWith(nextThumb);
  else if (existing) li.replaceChild?.(nextThumb, existing);
  else li.prepend(nextThumb);
  const durCell = li.querySelector?.('.dur');
  if (durCell) {
    durCell.textContent = item.kind === 'image' ? '—'
      : item.duration ? fmt(item.duration)
      : (item.openEnded ? '∞' : '…');
  }
  updateTotal();
}

function updateTotal() {
  const known = items.filter((it) => it.duration);
  total.textContent = !items.length
    ? ''
    : known.length === items.length
      ? t('panel.itemsTotal', { n: num(items.length), time: fmt(known.reduce((a, b) => a + b.duration, 0)) })
      : t('panel.items', { n: num(items.length) });
}

function render() {
  const it = items[index];
  $('title').textContent = it ? it.name : '';
  $('counter').textContent = items.length > 1 && it ? num(index + 1) + ' / ' + num(items.length) : '';
  renderList();
  const row = list.children[index];
  /* scrollIntoView is missing from some embedded webviews. A missing method
     must not abort the caller - render() runs inside load(), and throwing here
     used to kill the probe queue and leave every row showing "...". */
  if (row && typeof row.scrollIntoView === 'function') {
    try {
      row.scrollIntoView({ block: 'nearest' });
    } catch {}
  }
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
    position: items[index]?.position || 0,
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
  const all = await source.openFiles();
  reportUnusable(all);
  const picked = all.filter((it) => it.kind);
  if (picked.length) addItems(picked, play);
}

/* A drop or a picker that quietly discards files reads as the app ignoring
   you. Say how many were refused so the mismatch is explainable. */
function reportUnusable(all) {
  const skipped = (all || []).filter((it) => !it.kind).length;
  if (skipped) notice(t('notice.dropped', { n: num(skipped) }), { sticky: true });
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

window.addEventListener('resize', () => {
  publishBarHeight();
  scheduleSave();
});

if (typeof ResizeObserver === 'function') {
  new ResizeObserver(publishBarHeight).observe($('bar'));
}

media.on('time', ({ currentTime }) => {
  if (stage.dataset.kind === 'image') return;
  /* The bridge already withholds time updates from a provider that has been
     replaced, so by the time one arrives it belongs to the current item. */
  if (items[index]) items[index].position = currentTime;
  const d = media.duration;
  media.paintTime(Number.isFinite(d) && d > 0 ? currentTime / d : 0);
  /* The library formats <media-time> with Latin digits and has no number
     formatting of its own, so the readout has to be written here to follow the
     language. The library will overwrite it on its next update, which is fine:
     the two agree. */
  const cur = $('time-now');
  const dur = $('time-total');
  if (cur) cur.textContent = fmt(currentTime);
  if (dur) dur.textContent = Number.isFinite(d) && d > 0 ? fmt(d) : zeroTime();
});

/* The <img> sits above the player so a click on a picture never reaches the
   library's play/pause gesture. A still image has no play/pause to speak of,
   so a click on one moves on - the same thing Space does, which is what the
   instructions promise. */
still.addEventListener('click', () => step(1));

media.on('pause', scheduleSave);
/* A notice describes a state the user is in; it is retired when the media
   actually starts, not merely because something was loaded. */
media.on('play', clearNotice);
media.on('play', scheduleSave);

/* The end of the playlist is where the loop toggle actually does its work:
   `load` wraps with mod(), so without this the last track always jumped back
   to the first one and the button and the L key were inert. */
media.on('ended', () => {
  const next = index + 1;
  if (next < items.length) return load(next, autoStart);
  if (loop) return load(0, true);
  media.pause();
  scheduleSave();
});

/* An unplayable file used to call step(1) unconditionally, which wraps: N
   broken files produced N errors in quick succession and the decoder was
   hammered while the playlist skipped itself to the start. Advance at most
   once per track, and only when playback is actually under way. */
media.on('error', () => {
  if (items.length < 2) {
    /* Nothing to fall forward to, so stop here and say why. Silently freezing
       on a broken frame looks like a hang, not a failure. */
    notice(t('notice.cannotPlay'));
    media.pause();
    return;
  }
  if (erroredIndex === index) return;
  erroredIndex = index;
  const next = index + 1;
  if (next < items.length) return load(next, autoStart);
  if (loop) return load(0, autoStart);
  notice(t('notice.cannotPlay'));
  media.pause();
  scheduleSave();
});

/* Autoplay was refused - no user gesture yet, or the load was swapped out from
   under it. The player sits there claiming to be playing otherwise. */
media.on('blocked', () => notice(t('notice.blocked')));

media.on('volume', () => {
  media.paintVolume(media.volume);
  /* syncIcons owns the mute class and the control's name, so muting used to
     leave the button still labelled "Mute" while it was already muted */
  syncIcons();
});
media.paintVolume(media.volume);

/* The class is the single source of truth the CSS keys off: "playing" present
   means the pause glyph shows. An argument lets the caller state the intent
   before the library has swapped the provider, because a track that loads
   paused fires no play/pause event at all. */
function syncIcons(playing) {
  const isPlaying = playing === undefined ? media.playing : !!playing;
  const muted = media.muted || media.volume === 0;
  $('play').classList.toggle('playing', isPlaying);
  $('mute').classList.toggle('muted', muted);
  const inFs = media.fullscreen;
  $('fs').classList.toggle('on', inFs);
  $('fs').title = inFs ? t('bar.fullscreenExitKey') : t('bar.fullscreenKey');
  $('fs').setAttribute('aria-label', inFs ? t('bar.fullscreenExit') : t('bar.fullscreen'));
  /* the toggles announce their ACTION, so the accessible name has to follow the
     state: "Mute" while muted would be a lie */
  $('mute').setAttribute('aria-label', muted ? t('bar.unmute') : t('bar.mute'));
  $('mute').title = muted ? t('bar.unmuteKey') : t('bar.muteKey');
  $('play').setAttribute('aria-label', isPlaying ? t('bar.pause') : t('bar.play'));
  $('loop').setAttribute('aria-pressed', String(loop));
  $('autoplay').setAttribute('aria-pressed', String(autoStart));
}

/* double-click anywhere on the picture toggles fullscreen for the whole app */
stage.addEventListener('dblclick', () => media.toggleFullscreen());

/* ---------- instructions dialog ---------- */

const helpModal = $('help-modal');

/* Both dialogs are normalised explicitly rather than trusted from their markup
   attribute. The key handler treats an open dialog as owning the keyboard, so a
   stale or missing `hidden` would silently kill every app shortcut. */
helpModal.hidden = true;
$('settings-modal').hidden = true;

function setHelp(on) {
  helpModal.hidden = !on;
  /* move focus into the dialog so Esc and Tab behave, and back out when it
     closes so the keyboard returns to the player */
  const target = on ? $('help-close') : $('help');
  if (target && typeof target.focus === 'function') target.focus();
}

$('help').onclick = () => setHelp(true);
$('help-close').onclick = () => setHelp(false);

/* Both dialogs claim to be modal, so Tab has to stay inside them. Without
   this, Tab walked straight out into the control bar behind, while
   aria-modal="true" said otherwise. */
function trapFocus(dialog, e) {
  if (e.key !== 'Tab') return;
  const focusable = [...dialog.querySelectorAll(
    'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])',
  )].filter((node) => !node.closest('[hidden]') && !node.disabled);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const here = dialog.ownerDocument.activeElement;
  if (e.shiftKey && (here === first || !dialog.contains(here))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && here === last) {
    e.preventDefault();
    first.focus();
  }
}

document.addEventListener('keydown', (e) => {
  const open = settings.isOpen() ? $('settings-modal') : (helpModal.hidden ? null : helpModal);
  if (open) trapFocus(open, e);
}, true);

/* One modal at a time: opening settings closes the instructions dialog and vice
   versa, so the two can never stack. The button itself is wired in settings.js
   because that module owns the dialog. */
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
media.on('play', syncIconsFromEvent);
media.on('pause', syncIconsFromEvent);
media.onFullscreenChange(syncIconsFromEvent);
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
stage.addEventListener('drop', async (e) => {
  e.preventDefault();
  clearDragHint();
  addItems(await pickedFrom(e), true);
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
side.addEventListener('drop', async (e) => {
  e.preventDefault();
  e.stopPropagation();
  clearDragHint();
  addItems(await pickedFrom(e), false);
});

/* A desktop source resolves paths over IPC, so dropItems may be async. Awaiting
   and tolerating a non-array keeps a future adapter from turning the drop
   zones into silent dead zones. */
async function pickedFrom(e) {
  try {
    const res = await source.dropItems(e);
    const all = Array.isArray(res) ? res : [];
    reportUnusable(all);
    return all.filter((it) => it && it.kind);
  } catch (err) {
    console.warn('[app] could not read the dropped items:', err);
    return [];
  }
}

/* sidebar: click to play, x to remove, drag to reorder */

list.addEventListener('click', (e) => {
  const x = e.target.closest?.('.x');
  if (x) return removeItem(Number(x.dataset.x));
  const li = e.target.closest?.('li');
  if (li) load(Number(li.dataset.i), autoStart);
});

/* Keyboard equivalent of clicking a row. Without it the playlist is
   unusable without a mouse. */
list.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const x = e.target.closest?.('.x');
  if (x && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    removeItem(Number(x.dataset.x));
    return;
  }
  /* Any other key - including the arrows - belongs to the row, so focus is not
     stranded on a button the user cannot get out of. */
  const li = e.target.closest?.('li');
  if (!li) return;
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    load(Number(li.dataset.i), autoStart);
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    /* Move focus along the list, the way a listbox behaves. The step is taken
       from the row's position in the current DOM rather than from the model,
       because a render can renumber the rows between the keypress and here. */
    e.preventDefault();
    const stepBy = e.key === 'ArrowDown' ? 1 : -1;
    const here = [...list.children].indexOf(li);
    const next = here < 0 ? null : list.children[here + stepBy];
    if (next) next.focus();
  }
});

/* Reorder, Haruna-style: the list reflows LIVE while dragging. Crossing a row's
   midpoint actually moves the dragged node, so the rows close the gap in real
   time and what you see mid-drag is exactly what you get on drop. The model is
   only committed once the drag ends, so a cancelled drag restores itself. */
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
  const perm = [...list.children].map((li) => items[Number(li.dataset.i)]);
  dragNode = null;
  /* A re-render during the drag would have renumbered the rows and produced a
     short or hole-y permutation; refuse it rather than store `undefined` items. */
  if (perm.length !== items.length || perm.some((x) => !x)) {
    renderList();
    return;
  }
  items = perm;
  index = Math.max(0, items.indexOf(current));
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

  /* e.key is absent on some synthetic and IME key events */
  const k = typeof e.key === 'string' ? e.key.toLowerCase() : '';

  /* Dialogs and form controls own the keyboard while they are up. Without this
     M muted the video behind the settings dialog, arrow keys changed the volume
     while a <select> was open, and Space could not scroll the instructions. */
  const typing = e.target.closest?.('input, select, textarea, [contenteditable="true"]');

  if (k === 'escape' && settings.isOpen()) return settings.close();
  if (k === 'escape' && !helpModal.hidden) return setHelp(false);
  /* Settings owns the keyboard entirely, ?/i included: handled above this
     guard, `i` opened the instructions dialog on top of it, which broke the
     one-modal-at-a-time rule and left a dialog the keyboard could not
     dismiss. The instructions dialog is exempt, because ?/i toggles it. */
  if (settings.isOpen() || typing) return;
  if (k === '?' || k === 'i') return setHelp(helpModal.hidden);

  /* let the library's own sliders handle their arrow keys */
  if (media.ownsArrowKey(e.target) && k.startsWith('arrow')) return;

  /* A focused playlist row handles its own Enter, Space and arrows. This
     listener is in the capture phase, so without this it consumed them first
     and the row was unreachable by keyboard - the row handler never ran. */
  if (e.target.closest?.('#list li') && (k === 'enter' || k === ' ' || k.startsWith('arrow'))) return;

  if (k === 'h') return setUi(!stage.classList.contains('ui'));
  if (k === 'p') return setList(!stage.classList.contains('list'));
  if (k === 'escape' && stage.classList.contains('list')) return setList(false);
  if (k === ',') return step(-1);
  if (k === '.') return step(1);
  if (FITS[k]) return setFit(FITS[k]);
  if (k === 'l') return toggleLoop();
  if (k === 'a') return toggleAutoStart();
  if (k === 'x' && e.shiftKey) return clearAll(true);
  if (k === 'z' && e.shiftKey) return restoreCleared();
  if (k === 'm') return media.toggleMute();
  if (k === 'f') return media.toggleFullscreen();

  if (k === ' ' || k === 'enter' || k === 'k') {
    /* Space always means play/pause, even when a control still holds focus:
       otherwise the browser re-activates that button instead. Focus is only
       dropped for the control-bar case this was reported about, so keyboard
       navigation elsewhere is not destroyed. */
    const focused = e.target;
    if (focused && focused !== document.body && focused.closest?.('#bar') && typeof focused.blur === 'function') {
      focused.blur();
    }
    e.preventDefault();
    e.stopPropagation();
    if (stage.dataset.kind === 'image') return step(1);
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
  if (state?.fit) stage.dataset.fit = state.fit;

  setFit(stage.dataset.fit);
  /* The bar is shown unless it was explicitly hidden: `!!state.ui` left a
     first-time user with no controls at all, because a first run has no state
     and `!!undefined` is false. The same reasoning does not apply to the
     panel, which is closed by default. */
  setUi(state?.ui !== false);
  setList(!!state?.list);

  if (typeof state?.volume === 'number') media.setVolume(state.volume);
  if (typeof state?.loop === 'boolean' && state.loop) toggleLoop();
  if (state?.autoplay === false) toggleAutoStart();
  if (state?.muted) media.toggleMute();

  /* The saved state has landed; deliver anything the user added while it was
     still arriving, in the order they added it. */
  ready = true;
  const pending = queued;
  queued = null;
  if (pending) for (const batch of pending) addItems(batch.items, batch.play);

  /* Only rebuild a playlist the source can actually resolve. Restoring rows
     that carry no file would put the app on screen with a full list that can
     never play, every duration stuck at "…", and an unhandled rejection from
     the probe queue behind it. */
  if (state?.items?.length && !source.canPersist()) {
    state.items = [];
  }
  if (!state?.items?.length) return;

  items = state.items.map((it) => ({ ...it, duration: null, thumb: null, position: 0 }));
  drop.hidden = true;
  index = mod(state.index || 0, items.length);
  items[index].position = state.position || 0;
  load(index, false);
  runProbes(items);
}

/* settings first: the language decides every string, and the brand colour is
   read by the stylesheets on the very first paint */
settings.wire();

/* a language / colour / logo change has to reach storage */
document.addEventListener('mediatools:settings', scheduleSave);

/* Anything the app builds in JS (tooltips, counts, durations) is not covered by
   the data-i18n sweep, so re-render it when the language changes. */
const zeroTime = () => fmt(0);

window.I18n.onChange(() => {
  syncIcons();
  syncToggleTitles();
  /* the readout is refreshed by the next time event; the placeholder is not,
     because with nothing loaded there is no time event to come */
  if (!items.length || stage.dataset.kind === 'image') {
    const cur = $('time-now');
    const dur = $('time-total');
    if (cur) cur.textContent = zeroTime();
    if (dur) dur.textContent = zeroTime();
  }
  render();
});

restore().catch((err) => {
  /* A failed restore must not leave the app deaf to every drop. */
  console.warn('[app] could not restore the saved state:', err);
  ready = true;
  const pending = queued;
  queued = null;
  if (pending) for (const batch of pending) addItems(batch.items, batch.play);
  render();
});
