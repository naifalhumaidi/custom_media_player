import type { FileSource, I18nModule, MediaBridge, MediaItem, SettingsModule } from './types.js';

/* Every element this app needs, by id.

   Throws when one is missing, which is the whole point. It used to return null,
   and every use of it then had to be null-checked - 100-odd places where the
   check existed to satisfy a type rather than because a missing element was a
   state worth handling. In a built app a missing element means index.html and
   app.js disagree about the page, which is not a runtime condition to recover
   from but a build that is wrong: failing here says which id, immediately,
   instead of "cannot read properties of null" somewhere unrelated later. */
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`app: #${id} is not in the page`);
  return found as unknown as T;
};
const noticeEl = $('notice');
let noticeTimer: ReturnType<typeof setTimeout> | undefined;

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
const source = window.MediaFileSource as FileSource;
const media = window.MediaBridge as MediaBridge;
const settings = window.MediaSettings as SettingsModule;
const { t, num } = window.I18n as I18nModule;
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
/* S is the settings dialog, on request - it is the control that had no shortcut
   at all while claiming one in the instructions.

   That letter was already the stretch fit, so stretch moved to E rather than
   being dropped: the three fit keys are a set, and losing one would have left
   two controls on the bar with no key while the third had two meanings. The
   buttons, the tooltips and the instructions all moved together. */
const FITS = { d: 'contain', c: 'cover', s: 'stretch' };

let items: MediaItem[] = [];
let index = 0;
let loop = false;
let autoStart = true;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
/* The row currently being reordered, or null. Declared with the rest of the
   state because renderList() reads it, and renderList() can run before the
   reorder section is reached. */
let dragNode: HTMLElement | null = null;
/* One failure is allowed per track, so a playlist of unplayable files skips
   forward instead of bouncing between two broken items forever. */
let erroredIndex = -1;
/* False until the saved state has been applied. A desktop source reads it over
   IPC, so anything added in that window would be silently overwritten by the
   restore that lands afterwards. Input is not refused - it is queued, because
   dropping a file the user just dragged is worse than playing it a moment
   late. */
let ready = false;
let queued: Array<{ items: MediaItem[]; play: boolean }> | null = null;
/* Shift+X destroys an hours-long ordering with no way back, and the browser
   source cannot re-resolve files, so recovery has to happen before the release.
   The File handles are kept until the next change replaces them. */
let undo: { items: MediaItem[]; index: number } | null = null;
let undoTimer: ReturnType<typeof setTimeout> | undefined;

const mod = (n, m) => ((n % m) + m) % m;

function fmt(s) {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  /* pad BEFORE localising, and localise digit by digit: running "01" through
     Intl.NumberFormat would parse it as 1 and throw the leading zero away */
  const pad = (v) => String(v).padStart(2, '0').split('').map((ch) => num(Number(ch))).join('');
  return (h ? num(h) + ':' + pad(m) : num(m)) + ':' + pad(sec);
}

function once(el, event, ms) {
  return new Promise<void>((resolve, reject) => {
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
  const ctx = canvas.getContext('2d');
  /* A null context means the browser refused, which happens under heavy memory
     pressure. Returning null leaves the row on its placeholder; drawing into it
     would throw from inside a promise. */
  if (!ctx) return null;
  ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.6);
}

/* Same job for a still image, which has no videoWidth/videoHeight. A file that
   is not a decodable image must leave the row on its placeholder glyph rather
   than reject and take the probe queue down. */
async function drawImageThumb(url) {
  try {
    const img = new Image();
    /* Same reason as the video probe: without this the canvas is tainted and
       `toDataURL` throws, which is the desktop thumbnails failing silently. */
    img.crossOrigin = 'anonymous';

    img.src = url;

    /* The fallback must be able to FAIL: without an onerror, a corrupt image
       never settles and permanently occupies one of the three probe workers. */
    await (img.decode
      ? img.decode()
      : new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; }));
    if (!img.naturalWidth) return null;

    const scale = THUMB_W / img.naturalWidth;
    const canvas = document.createElement('canvas');
    canvas.width = THUMB_W;
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    /* High, because this is a photograph reduced by a factor of ten and the
       default filter is visibly worse than the difference is worth. */
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    /* Read out before the bitmap is dropped: toDataURL is synchronous, but the
       canvas is resized to nothing on the next line and a comment claiming
       otherwise is worth nothing. */
    const out = canvas.toDataURL('image/jpeg', 0.6);
    /* Let go of the decoded bitmap. It is the expensive thing and nothing needs
       it once the 160px version exists - the photograph itself is fetched again
       by the <img> that displays it, from the item's own URL.

       A comment here claimed this kept a folder of large photographs inside the
       decoder's budget. It does not: the same six images failed identically with
       and without it, at every worker count, and the real cause was the browser
       decoder refusing a bitmap while three were in flight. What this does do is
       release memory sooner, which is worth having and is not the fix. */
    img.src = '';
    canvas.width = 0;
    canvas.height = 0;
    return out;
  } catch (err) {
    /* Logged, not swallowed. A bare `catch { return null }` here is why a row can
       sit on its placeholder glyph with nothing anywhere saying why - the failure
       is invisible, and the only symptom is a thumbnail that never appears, which
       reads as "slow" rather than as "failed". It cost an afternoon to find one
       row of six that never got its picture, and the reason was right here in a
       catch with no body. */
    const why = err instanceof Error ? err.name + ': ' + err.message : String(err);
    console.warn('[app] no thumbnail for this image:', why);
    return null;
  }
}

async function probe(item) {
  /* A desktop source can say whether the file is still on disk, and a saved
     playlist outlives the files in it. Asked first because the alternative -
     letting the media element discover a moved file - costs a probe timeout
     per row and produces no message at all. */
  if (typeof source.fileExists === 'function') {
    item.missing = !(await source.fileExists(item));
    if (item.missing) return item;
  }

  /* An image row used to carry the item's own blob URL, so a playlist of large
     photos made the browser hold and decode every original just to paint a
     160px row. Downscale once, like the video path does. */
  if (item.kind === 'image') {
    item.thumb = await drawImageThumb(source.urlFor(item));
    return item;
  }

  /* a detached media element only reads metadata (and grabs a frame for
     video). It is never in the document, so it cannot disturb the player. */
  /* `playsInline` and `videoWidth` belong to one of the two element types
     each, which is why a union rejects them. The probe uses properties both
     share, plus those two, so the type is the intersection - stated once here
     rather than cast at every use below. */
  const el = document.createElement(item.kind === 'audio' ? 'audio' : 'video') as HTMLVideoElement;
  el.muted = true;
  el.playsInline = true;
  /* Declared as a CORS request, and this is what makes thumbnails work at all
     on the desktop.

     The shell serves media from a loopback port while the page is served from
     `tauri://` or `http://localhost`, so they are different origins. Without
     this the fetch is opaque, the canvas that drawThumb() paints into is
     tainted, and `toDataURL` throws a SecurityError - silently, inside a
     promise, leaving every row on its placeholder glyph.

     The server already sends `Access-Control-Allow-Origin: *`, so declaring the
     request is all that is needed. A browser tab is unaffected: a blob: URL is
     same-origin either way. */
  el.crossOrigin = 'anonymous';
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

/* Three workers, and the count is not the problem it looked like.

   It was reduced to two on the theory that three concurrent image decodes
   exhausted the browser's decoder - a photograph throws
   `EncodingError: The source image cannot be decoded`, one row of six keeps its
   placeholder glyph for good, and three in flight is a plausible cause.

   It is not the cause. Measured at one, two and three workers, the same six
   photographs lose the same row every time - and so do six small ones, which no
   decoder budget can explain. Whatever it is, it is not concurrency, so the
   count goes back to what it was and the change is withdrawn rather than left in
   as a plausible-sounding guess.

   What is real, and kept: the decode failure used to be swallowed by an empty
   catch, so nothing anywhere said why a row had no picture. It is logged now. */
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

/* Already in the playlist?

   Reported as "when I drop the same video again it pauses, then the next time
   it starts, then it pauses". Dropping the same file twice added a second row
   for it and loaded that row, and a load of a source the element already holds
   is a no-op as far as the library is concerned: no new metadata event, so the
   autoplay that was asked for never arrives, and whether it played or sat still
   came down to the state the previous load happened to leave behind. That is
   the alternation.

   The fix is not to make the load more reliable. Dropping a file you already
   have should not add it twice: the user dropped it once, they can see it in the
   list, and the useful thing to do is go to it. Which is what this does. */
function existingIndexOf(item) {
  if (!item) return -1;
  /* A path is the identity on the desktop, where the same file has one name for
     its whole life. In a browser tab there is no path, so the name is all there
     is - which is not much, but it is what the user can see in the list. */
  const by = item.path
    ? (it) => it && it.path === item.path
    : (it) => it && it.name === item.name && it.size === item.size;
  return items.findIndex(by);
}

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

  /* Duplicates are dropped and the rows that were already there are selected
     instead. Only when every one of them is a duplicate - otherwise the new
     files would be added and the duplicates ignored, which is what the user
     meant either way. */
  const wanted = fresh.filter((it) => existingIndexOf(it) === -1);
  if (!wanted.length) {
    /* Every one of them is already here: play the first, which is what a click
       on its row does. `render()` after the load, because `load` is what marks
       the current row, and the row has to be painted as current. */
    const first = existingIndexOf(fresh[0]);
    if (first >= 0 && !items[first]?.missing) {
      load(first, true);
      render();
    }
    return;
  }

  const wasEmpty = items.length === 0;
  items = items.concat(wanted);

  drop.hidden = true;
  renderEmptyState();
  if (wasEmpty || play) load(wasEmpty ? 0 : items.length - wanted.length, true);
  else render();
  runProbes(wanted);
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
  stage.dataset.kind = String(it.kind);

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
  media.load({ url, mime: it.mime, kind: it.kind, position: it.position }, it.kind, play);

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


function syncToggleTitles() {
  $('loop').title = loop ? t('bar.loopOn') : t('bar.loopKey');
  $('autoplay').title = autoStart ? t('bar.autoplayKey') : t('bar.autoplayOff');
  /* the on/off state is a flat tint on screen, which conveys nothing to a
     screen reader, so it has to be stated as well */
  $('loop').setAttribute('aria-pressed', String(loop));
  $('autoplay').setAttribute('aria-pressed', String(autoStart));
  /* The menu's checkmarks follow the same source as the buttons' lit state, so
     the two cannot disagree. syncIcons already runs on every state change, so
     this costs nothing and there is nowhere else to forget it. */
  publishMenuState();
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
  /* The drop hint appears only once there is a playlist to add to. Shown
     alongside the empty message it repeated the same instruction twice, in two
     voices, and neither mentioned the buttons. */
  const hint = document.querySelector<HTMLElement>('.side-hint');
  if (hint) hint.hidden = open || !items.length;
}

/* ---------------- rendering ---------------- */

/* Small shapes, drawn inline rather than pulled from the sprite: the sprite is
   for controls, and these are labels inside a 32px box. */
const KIND_GLYPH = {
  video: '<svg viewBox="0 0 24 24"><path d="M7 4.5 20 12 7 19.5z" fill="currentColor"/></svg>',
  audio: '<svg viewBox="0 0 24 24"><path d="M9 17.5V6.2l10-2v11.1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6.5" cy="17.5" r="2.6" fill="currentColor"/><circle cx="16.5" cy="15.3" r="2.6" fill="currentColor"/></svg>',
  image: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="m6.5 16.5 3.8-4.2 2.7 2.8 2.4-2.4 2.1 2.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
} as const;

function thumbNode(item) {
  const box = document.createElement('span');
  box.className = 'thumb';
  /* A type badge, as a glyph rather than a letter. It used to be the first
     character of the kind - "V", "A", "I" - in a corner badge, which read as a
     stray character rather than as a label. A shape is understood at 12px; a
     single capital letter is not. */
  if (item.kind) {
    const badge = document.createElement('span');
    badge.className = 'kd';
    badge.setAttribute('aria-hidden', 'true');
    badge.innerHTML = KIND_GLYPH[item.kind] || '';
    box.append(badge);
  }
  if (item.thumb) {
    const img = document.createElement('img');
    img.src = item.thumb;
    img.alt = '';
    box.prepend(img);
  } else {
    const glyph = document.createElement('span');
    glyph.className = item.missing ? 'gone' : 'gl';
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
    (li as HTMLElement).dataset.i = String(i);
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
    if (item.missing) {
      dur.classList.add('missing');
      dur.textContent = t('panel.missing');
      dur.title = t('panel.missingHint');
    }
    dur.textContent = item.kind === 'image' ? '—' : item.duration ? fmt(item.duration) : (item.openEnded ? '∞' : '…');

    const x = document.createElement('button');
    x.className = 'x';
    x.type = 'button';
    x.title = t('panel.remove');
    x.setAttribute('aria-label', t('panel.removeAria'));
    x.textContent = '✕';
    (x as HTMLElement).dataset.x = String(i);

    if (item.missing) li.classList.add('missing');
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
      ? t('panel.itemsTotal', { n: num(items.length), time: fmt(known.reduce((a, b) => a + (b.duration || 0), 0)) })
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
/* Refreshed after the toggle as well as on the change event. The event is the
   right mechanism - it also covers the window leaving fullscreen by a window
   manager shortcut, which this cannot - but the button must not wait on a
   notification that a shell might deliver a frame late, or it reads as a dead
   control. Both, because they fail differently. */
$('fs').onclick = () => { Promise.resolve(media.toggleFullscreen()).then(() => syncIcons()); };
/* Named, because the keyboard reaches the same two actions as the buttons. Two
   implementations of "add files" would drift, and the one on the keyboard would
   be the one nobody tests. */
function openFiles() { return pick(true); }
function addFiles() { return pick(false); }

async function addFolder() {
  const all = (await source.openFolder?.()) || [];
  reportUnusable(all);
  const picked = all.filter((it) => it.kind);
  if (picked.length) addItems(picked, false);
}

/* One function object per action, handed to every button that offers it.

   Writing `() => addFiles()` at each site gives each button its own arrow, and
   two arrows calling the same function are equal in behaviour and unequal by
   identity - so nothing can check that the two copies still agree, and a change
   to one of them would be silent. Naming the handler once makes "the panel's
   Add files is the same action as the header's" a thing a test can assert. */
const addFilesAction = () => addFiles();

/* Optional: the Open button has left the bar for the File menu. `$()` throws on a
   missing element by design - it catches a page and a script that disagree - so a
   button that is genuinely not there has to be asked for with getElementById. */
const openButton = document.getElementById('open');
if (openButton) openButton.onclick = () => openFiles();
$('add').onclick = addFilesAction;

/* The same two actions again, inside the empty panel.

   They were in the markup from the start and had no handler at all, so the only
   place a user could add anything to an empty playlist was a button that did
   nothing. */
$('empty-add').onclick = addFilesAction;

/* ---------- clearing, with a confirmation ---------- */

/* A playlist can be an hour of arranging, and the clear control is a trash can
   sitting beside the add button. One mis-click and it is gone. So both ways in
   - the button and Shift+X - ask first.

   The question is not ceremony. The undo already exists and is generous, thirty
   seconds and the whole list back in order, and it is still not enough: a person
   who clears by accident and does not notice for half a minute has already
   moved on, and nothing would bring the list back at that point. Asking first is
   the only version of this that is actually safe.

   Escape cancels, Enter cancels (Cancel holds the focus), and the dialog takes
   the keyboard while it is up, exactly as the settings dialog does. */
const clearModal = $('clear-modal');

function askToClear() {
  if (clearModal.hidden) clearModal.hidden = false;
  /* Cancel first, deliberately: a Return keypress that arrives without the
     dialog being read should not empty anything. */
  $('clear-cancel').focus();
}

function dismissClear() {
  clearModal.hidden = true;
}

/* Whatever had focus goes back, so closing a dialog does not strand the
   keyboard at the top of the document. */
let clearReturnFocus: HTMLElement | null = null;

$('clear-ok').onclick = () => {
  dismissClear();
  if (clearReturnFocus && clearReturnFocus.focus) clearReturnFocus.focus();
  /* keepUndo, like the keyboard shortcut. The button is easier to hit by
     accident than a key combination, so the undo is more necessary here, not
     less. */
  clearAll(true);
};
$('clear-cancel').onclick = () => {
  dismissClear();
  if (clearReturnFocus && clearReturnFocus.focus) clearReturnFocus.focus();
};

/* Whether the key landed inside the dialog rather than on the backdrop. */
function inClearDialog(target: EventTarget | null): boolean {
  return !!clearModal.contains(target as Node);
}

/* The two buttons, in the order they appear, and the focus moving along them.

   The order is read from the DOM rather than written out, so a third button is
   included without this being told, and the movement cannot go out of step with
   what is actually on screen.

   Arrows are handled here because HTML does not do them: focus moves between
   buttons with Tab, and the arrow keys are for toolbars and menus. Two real
   buttons in a real dialog therefore had working Tab and working Enter and
   nothing else. Up and down are accepted alongside left and right because a
   person will try both, and a dead key is a worse answer than either. Wrapping,
   because the two are a set and Tab is. */
function clearButtons(): HTMLElement[] {
  return Array.from(clearModal.querySelectorAll<HTMLElement>('button'))
    .filter((b) => !b.hidden && !(b as HTMLButtonElement).disabled);
}

function moveClearFocus(step: number) {
  const buttons = clearButtons();
  if (!buttons.length) return;
  const here = buttons.indexOf(document.activeElement as HTMLElement);
  /* From nowhere - focus was outside the buttons, or on the backdrop - start at
     one end rather than an arbitrary one, and going forward lands on Cancel,
     which is the safe direction. */
  const next = here < 0
    ? (step > 0 ? 0 : buttons.length - 1)
    : (here + step + buttons.length) % buttons.length;
  buttons[next].focus();
}

clearModal.addEventListener('click', (e) => {
  /* A click on the backdrop, outside the card, cancels. A click on the card
     itself must not, or the text could not be selected. */
  if (e.target === clearModal) {
    dismissClear();
    if (clearReturnFocus && clearReturnFocus.focus) clearReturnFocus.focus();
  }
});

/* The clear button, in the panel header. Only where the playlist can actually
   be kept: in a browser tab everything is lost on reload anyway, so a clear
   button there is a way to throw work away for nothing. */
if (source.canPersist()) {
  const clearButton = $('clear-list');
  if (clearButton) {
    clearButton.hidden = false;
    clearButton.onclick = () => {
      clearReturnFocus = document.activeElement as HTMLElement | null;
      askToClear();
    };
  }
}

/* A folder is only meaningful where files have real paths, so the control only
   appears when the source offers one - in both places it appears, which are the
   panel header and the empty panel. */
if (typeof source.openFolder === 'function') {
  const addFolderButton = $('add-folder');
  if (addFolderButton) {
    addFolderButton.hidden = false;
    addFolderButton.onclick = addFolder;
  }
  const emptyAddFolder = $('empty-add-folder');
  if (emptyAddFolder) {
    emptyAddFolder.hidden = false;
    emptyAddFolder.onclick = addFolder;
  }
}

/* On the desktop the webview delivers dropped paths on a shell event, not as a
   DOM DragEvent with files - there is no DataTransfer to read. The adapter
   subscribes and answers here, so the same add-and-play rule applies. */
if (typeof source.onExternalDrop === 'function') {
  source.onExternalDrop((incoming) => {
    reportUnusable(incoming);
    const picked = incoming.filter((it) => it.kind);
    if (picked.length) addItems(picked, true);
  });
}

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

/* The <img> sits above the player, so a click on a picture never reaches the
   library's play/pause gesture.

   It used to advance to the next item on a click, which was removed on request:
   the control bar sits over the bottom of the picture, and a click reaching
   for the volume or the scrubber was landing on the image and skipping the
   track. Space, Right and the Next button all move on, and nothing is lost.

   It still swallows the click, deliberately. Without a handler the event falls
   through to the player's own gesture, which would toggle play on a medium that
   has no play state. */
still.addEventListener('click', (e) => e.stopPropagation());

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

/* Mute and volume, wired here rather than left to the library.

   The library's own controls are bound to the player, and the player has no
   media to bind to once the playlist is empty - so with nothing loaded they were
   on screen, took the click, and changed nothing. The bridge writes straight to
   the media element, which always exists, so these two always answer. */

$('mute').onclick = () => media.toggleMute();

const volumeInput = $<HTMLInputElement>('volume');
/* `input` rather than `change`, so the fill follows the pointer instead of
   appearing when the button is let go. `change` is still what a keyboard user
   produces, and it also fires `input`, so there is nothing to add. */
volumeInput.addEventListener('input', () => media.setVolume(Number(volumeInput.value)));

/* The element is the source of truth, not the input: the keyboard shortcuts and
   a restored setting both change the volume without touching the control, and a
   slider left showing the old number is a lie. Written only when they differ,
   because assigning `value` to a range input the pointer is currently dragging
   fights the drag. */
const showVolume = () => {
  const wanted = media.muted ? 0 : media.volume;
  if (document.activeElement !== volumeInput) volumeInput.value = String(wanted);
  media.paintVolume(media.volume);
};

media.on('volume', () => {
  showVolume();
  /* syncIcons owns the mute class and the control's name, so muting used to
     leave the button still labelled "Mute" while it was already muted */
  syncIcons();
});
showVolume();

/* The class is the single source of truth the CSS keys off: "playing" present
   means the pause glyph shows. An argument lets the caller state the intent
   before the library has swapped the provider, because a track that loads
   paused fires no play/pause event at all. */
/* ---------------- shortcuts ---------------- */

/* One table, and everything reads it.

   The dispatch used to be a chain of `if (k === ...)` and the settings dialog
   had its own list of names, and the tooltips had a third. Three places naming
   the same twenty keys is three places for a key to be wrong, and the user found
   out: "i just looked at the first letter and assigned a shortcut" - a key that
   was printed in the instructions and did nothing, because it was never bound.

   So the table is the definition. The keyboard reads it, the settings table
   renders it, the tooltips are built from it, and changing one changes all
   three. A key that is listed but not here cannot be printed at all.

   `keys` are the defaults, not the current values. The current values live in
   `shortcutOverrides`, so Reset is one assignment rather than a walk over
   everything. */
const SHORTCUTS = [
  { id: 'playPause', label: 'bar.play', keys: ['Space', 'K'] },
  { id: 'seekBack', label: 'bar.back', keys: ['ArrowLeft'] },
  { id: 'seekForward', label: 'bar.forward', keys: ['ArrowRight'] },
  { id: 'volumeUp', label: 'bar.volumeUp', keys: ['ArrowUp'] },
  { id: 'volumeDown', label: 'bar.volumeDown', keys: ['ArrowDown'] },
  { id: 'previous', label: 'bar.previous', keys: [','] },
  { id: 'next', label: 'bar.next', keys: ['.'] },
  { id: 'mute', label: 'bar.mute', keys: ['M'] },
  { id: 'loop', label: 'bar.loop', keys: ['L'] },
  { id: 'autoplay', label: 'bar.autoplay', keys: ['A'] },
  { id: 'fitDefault', label: 'bar.fitDefault', keys: ['D'] },
  { id: 'fitCrop', label: 'bar.fitCrop', keys: ['C'] },
  { id: 'fitStretch', label: 'bar.fitStretch', keys: ['S'] },
  { id: 'fullscreen', label: 'bar.fullscreen', keys: ['F'] },
  { id: 'controls', label: 'bar.controls', keys: ['H'] },
  { id: 'panel', label: 'bar.panel', keys: ['P'] },
  { id: 'open', label: 'bar.open', keys: ['O'] },
  { id: 'addFolder', label: 'bar.addFolder', keys: ['Shift+O'] },
  { id: 'clear', label: 'panel.clearTitle', keys: ['Shift+X'] },
  { id: 'undo', label: 'bar.undo', keys: ['Shift+Z'] },
  { id: 'settings', label: 'bar.settings', keys: ['Ctrl+,'] },
] as const;

type ShortcutId = typeof SHORTCUTS[number]['id'];

let shortcutOverrides: Partial<Record<ShortcutId, string[]>> = {};

/* What a shortcut is bound to right now: the override if there is one, the
   default otherwise. */
function keysOf(id: ShortcutId): readonly string[] {
  return shortcutOverrides[id] || SHORTCUTS.find((s) => s.id === id)!.keys;
}

/* The key as a person reads it: "Ctrl+," rather than "ctrl+," and "Shift+X"
   rather than "shift+x". Used in the settings table, the tooltips and the
   menu, so the three cannot spell a key three different ways. */
function prettyKey(key: string): string {
  const parts = key.split('+');
  const last = parts.pop() as string;
  /* Spelled the way a keyboard is labelled, not the way the DOM calls it. The
     arrows are drawn rather than named, because "ArrowLeft" in a table of
     shortcuts is a sentence about the DOM and not an instruction. */
  const named: Record<string, string> = {
    ArrowLeft: '\u2190', ArrowRight: '\u2192', ArrowUp: '\u2191', ArrowDown: '\u2193',
    ' ': 'Space', Control: 'Ctrl', Ctrl: 'Ctrl', Meta: 'Ctrl', Command: 'Ctrl',
    Escape: 'Esc', Shift: 'Shift', Alt: 'Alt', AltGraph: 'AltGr',
    Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Del',
  };
  /* A modifier keeps its own spelling rather than being shouted: "CTRL+," is
     not a keyboard label, and "Ctrl+," is. */
  const mods = parts.map((p) => named[p] || p);
  const tail = named[last] || (last.length === 1 ? last.toUpperCase() : last);
  return [...mods, tail].join('+');
}

/* A binding, as one comparable string: "Control+," , "Shift+X", "Space".

   Two things have to agree before a key counts as the same binding - the stored
   one and the one just pressed - so both are put through here.

   The stored form already carries its modifiers ("Shift+X"), and the pressed one
   carries them on the event (e.key is "x", e.shiftKey is true). Normalising both
   to the same spelling is the whole job, and it has to handle the stored form
   explicitly: reading "Shift+X" as a key called Shift+X and then prepending
   Shift again gives "Shift+Shift+X", which matches nothing. That is why
   Shift+X and every other modified binding stopped working when the dispatch
   became table-driven - the letters came back one at a time, the modified keys
   never did.

   Modifiers are emitted in a fixed order, so Ctrl+Shift+A and Shift+Ctrl+A are
   one binding written two ways rather than two bindings, which would let a
   person assign both and find that one of them never fires. */
const MODIFIER_ORDER = ['Control', 'Alt', 'Shift'] as const;

/* How a modifier is spelled in the table, and how it is spelled elsewhere.
   "Ctrl+,", "Control+," and a command key held on a Mac are one binding, and
   without this they are three - so the one in the table matched nothing at all
   and the key silently did nothing. */
const MODIFIER_ALIASES: Record<string, string> = {
  Ctrl: 'Control',
  Control: 'Control',
  Meta: 'Control',
  Cmd: 'Control',
  Command: 'Control',
  Super: 'Control',
  Alt: 'Alt',
  Option: 'Alt',
  Shift: 'Shift',
};

/* How one key is spelled in the table, and how the DOM spells the same key. A
   table of bindings that said " " instead of "Space" would be unreadable, and a
   table that said "Escape" would not match the key the browser sends. Both are
   the same key, so both spellings fold to one before anything is compared. */
const SPACING_ALIASES: Record<string, string> = {
  ' ': 'Space',
  Space: 'Space',
  Spacebar: 'Space',
  Escape: 'Escape',
  Esc: 'Escape',
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  Del: 'Delete',
  Return: 'Enter',
};

function normaliseBinding(binding: string): string {
  const parts = binding.split('+');
  const key = (parts.pop() as string) || '';
  const mods = MODIFIER_ORDER.filter((m) =>
    parts.some((p) => MODIFIER_ALIASES[p] === m));
  /* A single letter has no meaningful case, and e.key does not gain one just
     because Shift is held. Named keys keep theirs exactly. */
  const folded = key.length === 1 ? key.toUpperCase() : key;
  /* "Space" and " " are the same key. The table spells it the way a person
     reads it, because a table of bindings that said " " would be unreadable;
     e.key says the other thing, because that is what the DOM calls it. Neither
     spelling is wrong, so both fold to one. The same goes for "Esc", which the
     table prints and the event calls "Escape". */
  const canonical = SPACING_ALIASES[folded] || folded;
  /* Shift is already in a symbol key: "!" is Shift+1 on every layout, so
     "Shift+!" is the same key twice and would otherwise never match. */
  const dropShift = mods.includes('Shift') && key.length === 1 && !/[a-z0-9]/i.test(key);
  return [...mods.filter((m) => !(dropShift && m === 'Shift')), canonical].join('+');
}

/* The binding a keypress means, from the event alone. */
function bindingFromEvent(event: KeyboardEvent): string {
  const key = typeof event.key === 'string' ? event.key : '';
  const mods = [
    event.ctrlKey || event.metaKey ? 'Control' : '',
    event.altKey ? 'Alt' : '',
    event.shiftKey ? 'Shift' : '',
  ].filter(Boolean);
  return normaliseBinding([...mods, key].join('+'));
}

/* What a stored binding is, spelled the same way. */
function normalise(key: string): string {
  return normaliseBinding(key);
}

/* Does this binding belong to anything? Used before accepting a new one, so a
   person is told what already has it instead of finding out by pressing. */
function ownerOf(binding: string): ShortcutId | null {
  const wanted = normalise(binding);
  for (const entry of SHORTCUTS) {
    if (keysOf(entry.id).some((key) => normalise(key) === wanted)) return entry.id;
  }
  return null;
}

function setShortcut(id: ShortcutId, keys: string[]): { ok: true } | { ok: false; owner: ShortcutId } {
  const clash = keys.map((k) => ownerOf(k)).find((owner) => owner && owner !== id);
  if (clash) return { ok: false, owner: clash };
  shortcutOverrides[id] = keys;
  paintShortcutLabels();
  saveShortcuts();
  return { ok: true };
}

function resetShortcuts(): void {
  shortcutOverrides = {};
  paintShortcutLabels();
  saveShortcuts();
}

function currentShortcuts(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const entry of SHORTCUTS) out[entry.id] = keysOf(entry.id).slice();
  return out;
}

/* The three places a key is written down: the tooltip on the control, the menu
   item, and the settings table. All three are painted from the table, so a
   reassignment shows up in the tooltip the moment it is made - which is what the
   user asked for, and what could not happen while each had its own copy. */
/* The tooltip for a control: its label, then whatever is bound now.

   Four things used to write this string - the markup, the translations, the
   icon sync, and the settings table - and they disagreed. This is the only one.

   A label that depends on state (Mute / Unmute, Enter / Leave fullscreen) is
   named here rather than read from the markup, because the markup only knows one
   of the two and the other is what the user is looking at. */
const STATE_LABELS: Record<string, () => string | null> = {
  mute: () => ($('mute').classList.contains('muted') ? t('bar.unmute' as never) : t('bar.mute' as never)),
  fullscreen: () => (media.fullscreen ? t('bar.fullscreenExit' as never) : t('bar.fullscreen' as never)),
};

/* The tooltips whose words depend on state rather than on a binding. */
function paintStateTooltips() {
  for (const id of Object.keys(STATE_LABELS)) paintShortcutLabel(id);
}

function paintShortcutLabels() {
  for (const entry of SHORTCUTS) paintShortcutLabel(entry.id);
}

/* One control's tooltip. Split out so the frequent path - a state change - can
   touch two controls instead of walking the whole table and the document. */
function paintShortcutLabel(id: string) {
  {
    const entry = SHORTCUTS.find((e) => e.id === id);
    if (!entry) return;
    const keys = keysOf(entry.id);
    const suffix = keys.length ? ` (${keys.map(prettyKey).join(', ')})` : '';
    for (const el of document.querySelectorAll<HTMLElement>(`[data-shortcut="${entry.id}"]`)) {
      const stateful = STATE_LABELS[entry.id];
      let label = '';
      if (stateful) {
        label = stateful() || '';
      } else {
        const base = el.getAttribute('data-i18n-title');
        const translated = base ? t(base as never) : el.title;
        /* Any key already in the string is dropped before the current one is
           added, so a repaint replaces rather than accumulates. */
        label = translated.replace(/\s*\([^)]*\)\s*$/, '') || translated;
      }
      el.title = label + suffix;
    }
  }
}

/* Shortcuts are saved with everything else, so a reassignment survives a
   restart. A separate key rather than a field in prefs, because they are not a
   preference - they are how the preferences are reached. */
function saveShortcuts() {
  try {
    /* Only the overrides, not the whole table. A file that listed every action
       would carry on describing bindings the user has since been shown are not
       the defaults, and would grow with every action added later. */
    localStorage.setItem('mediatools.shortcuts', JSON.stringify(shortcutOverrides));
  } catch (err) {
    console.warn('[app] could not save the shortcuts:', err);
  }
}

function loadShortcuts() {
  try {
    const raw = localStorage.getItem('mediatools.shortcuts');
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, string[]>;
    /* Only keys that are still actions, and only values that are strings, so a
       hand-edited or stale file cannot put a non-key where a key belongs and
       break every lookup. */
    const known = new Set<string>(SHORTCUTS.map((entry) => entry.id));
    for (const [id, keys] of Object.entries(parsed)) {
      if (known.has(id) && Array.isArray(keys) && keys.every((k) => typeof k === 'string')) {
        shortcutOverrides[id as ShortcutId] = keys;
      }
    }
  } catch (err) {
    console.warn('[app] could not read the saved shortcuts, using the defaults:', err);
  }
}

function syncIcons(playing?: boolean) {
  const isPlaying = playing === undefined ? media.playing : !!playing;
  const muted = media.muted || media.volume === 0;
  $('play').classList.toggle('playing', isPlaying);
  /* `.muted` is what the icon swap and the gold "this is on" background both key
     off, so the two can never disagree. `aria-pressed` says the same thing to a
     screen reader, which cannot see a class. */
  $('mute').classList.toggle('muted', muted);
  $('mute').setAttribute('aria-pressed', String(muted));
  const inFs = media.fullscreen;
  $('fs').classList.toggle('on', inFs);
  $('fs').title = inFs ? t('bar.fullscreenExitKey') : t('bar.fullscreenKey');
  $('fs').setAttribute('aria-label', inFs ? t('bar.fullscreenExit') : t('bar.fullscreen'));
  /* the toggles announce their ACTION, so the accessible name has to follow the
     state: "Mute" while muted would be a lie */
  $('mute').setAttribute('aria-label', muted ? t('bar.unmute') : t('bar.mute'));
  /* The tooltip is not written here. paintShortcutLabels owns it, because writing
     it here was a fourth place the binding was spelled out and the one that won:
     syncIcons runs on every play, pause and volume change, so it replaced the
     tooltip with a bare "Unmute" and dropped the key.

     Only the two controls whose label depends on state, rather than the whole
     table. syncIcons runs on every state change and a full repaint walks the
     document, which is what turned a 30-file track change from 800ms into
     5000ms - one slow thing repeated, rather than one slow thing. */
  paintStateTooltips();
  $('play').setAttribute('aria-label', isPlaying ? t('bar.pause') : t('bar.play'));
  $('loop').setAttribute('aria-pressed', String(loop));
  $('autoplay').setAttribute('aria-pressed', String(autoStart));
  /* The menu's checkmarks follow the same source as the buttons' lit state, so
     the two cannot disagree. syncIcons already runs on every state change, so
     this costs nothing and there is nowhere else to forget it. */
  publishMenuState();
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
  /* Move focus into the dialog so Esc and Tab behave.

     Coming back out goes to the player rather than to the button that opened it:
     the Info and Settings buttons are in the application menu, not in the page,
     so there is nothing in the document to hand the focus back to. `focus()` on
     a missing element throws, which is what this used to do the moment the bar
     buttons went. */
  if (on) {
    const first = $('help-close');
    if (first && typeof first.focus === 'function') first.focus();
  } else {
    const back = document.querySelector('.bar, #stage');
    if (back && typeof (back as HTMLElement).focus === 'function') (back as HTMLElement).focus();
  }
}

/* Optional, because both buttons now live in the application menu. The dialog is
   still reachable from there, and from the keyboard, and `setHelp` is what all
   three call. */
const helpButton = document.getElementById('help');
if (helpButton) helpButton.onclick = () => setHelp(true);
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
  if ((e.target as HTMLElement).closest?.('#side, #bar')) return;
  setList(false);
});

/* Wrapped, not passed by reference: an event listener hands its Event to the
   first parameter, which syncIcons would read as "the video is playing". */
const syncIconsFromEvent = () => syncIcons();
media.on('play', syncIconsFromEvent);
media.on('pause', syncIconsFromEvent);
media.onFullscreenChange(syncIconsFromEvent);
syncIcons();

/* ---------------- the shortcut table in Settings ---------------- */

/* Click a cell, press a key, Escape cancels.

   A table rather than a free-text field, because a shortcut is not something a
   person types - it is something they press. And the capture is a real keypress,
   so a cell cannot be given something the keyboard cannot produce: "Ctrl+;" is
   not a shortcut, and typing it used to be the only way this could be set.

   A binding already in use is refused, and the row that has it is named. Silently
   taking it would leave two actions on one key with no way to tell which runs. */
let capturing: { id: ShortcutId; row: HTMLElement; cell: HTMLElement } | null = null;

function renderShortcutTable() {
  const body = document.getElementById('shortcut-rows');
  if (!body) return;
  body.textContent = '';

  for (const entry of SHORTCUTS) {
    const row = document.createElement('tr');
    row.dataset.shortcutRow = entry.id;

    const name = document.createElement('th');
    name.textContent = t(entry.label as never);
    row.appendChild(name);

    const cell = document.createElement('td');
    const button = document.createElement('button');
    button.className = 'key-cell';
    button.type = 'button';
    button.dataset.shortcutCell = entry.id;
    button.textContent = keysOf(entry.id).map(prettyKey).join(', ') || '\u2014';
    cell.appendChild(button);
    row.appendChild(cell);

    body.appendChild(row);
  }

  /* The click handler is attached once, below, not here. This function runs
     again every time a binding changes, and a listener added on each run would
     stack - so one click began four captures, and the last one won, which looked
     like the first click doing nothing. */
}

function beginCapture(id: ShortcutId, cell: HTMLElement) {
  endCapture();
  capturing = { id, row: cell.closest('tr') as HTMLElement, cell };
  cell.textContent = t('settings.shortcutsPress' as never);
  cell.classList.add('capturing');
  /* Focused, so the next keypress goes here without a click. */
  (cell as HTMLElement).focus?.();
}

function endCapture() {
  if (!capturing) return;
  capturing.cell.classList.remove('capturing');
  capturing.cell.textContent = keysOf(capturing.id).map(prettyKey).join(', ') || '\u2014';
  capturing = null;
}

/* One click listener for the whole table, and one key listener for the capture -
   rather than twenty of each, attached and detached on every render. Delegated,
   so the rows themselves can be thrown away and rebuilt freely. */
document.getElementById('shortcut-rows')?.addEventListener('click', (e) => {
  const button = (e.target as HTMLElement).closest<HTMLElement>('[data-shortcut-cell]');
  if (!button || !button.dataset.shortcutCell) return;
  beginCapture(button.dataset.shortcutCell as ShortcutId, button);
});

document.addEventListener('keydown', (e) => {
  if (!capturing) return;
  e.preventDefault();
  e.stopPropagation();

  if (e.key === 'Escape') {
    const back = capturing.cell;
    endCapture();
    (back as HTMLElement).focus?.();
    return;
  }

  /* A modifier on its own is not a shortcut. Someone reaching for Ctrl+A has not
     chosen A yet, and binding it to "Ctrl" would take the key from everything. */
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;

  const id = capturing.id;
  const binding = bindingFromEvent(e);
  const result = setShortcut(id, [binding]);
  if (!result.ok) {
    /* Said plainly, and the old binding is left alone. Taking the key would leave
       two actions on it with no way to know which runs. */
    const hint = document.getElementById('shortcut-hint');
    if (hint) {
      hint.textContent = t(('settings.shortcutsTaken' as never)) + ' \u2014 ' + t((SHORTCUTS.find((s2) => s2.id === result.owner)!.label as never));
      hint.classList.add('is-error');
    }
    endCapture();
    return;
  }

  const hint = document.getElementById('shortcut-hint');
  if (hint) {
    hint.textContent = t('settings.shortcutsSaved' as never);
    hint.classList.remove('is-error');
  }
  endCapture();
  renderShortcutTable();
  /* The focus is on a cell that no longer exists after the re-render, so it goes
     back to the row it came from. */
  const again = document.querySelector(`[data-shortcut-cell="${id}"]`) as HTMLElement | null;
  again?.focus?.();
}, true);

/* Rendered here, at the bottom of the script, rather than only inside the
   restore path. `restore` is async - it awaits the shell - so a table rendered
   only there does not exist until the saved state has arrived, and the dialog can
   be opened before then. Rendered with the defaults, and repainted once the saved
   bindings are loaded. */
renderShortcutTable();
/* Every control's tooltip is repainted at the end of boot, after every label has
   been written. Painting it earlier loses: the translations apply `title` to
   every element with data-i18n-title, and the tooltip is one of them, so a paint
   that came first was silently undone and the key was simply absent from the
   control. Three paints - here, on a reassignment, and on a language change -
   because those are the only three moments a label or a binding changes. */
function repaintShortcutLabels() {
  paintShortcutLabels();
}

const resetButton = document.getElementById('shortcut-reset');
if (resetButton) {
  resetButton.onclick = () => {
    resetShortcuts();
    renderShortcutTable();
    const hint = document.getElementById('shortcut-hint');
    if (hint) {
      hint.textContent = t('settings.shortcutsReset' as never);
      hint.classList.remove('is-error');
    }
  };
}

/* ---------------- the application menu ---------------- */

/* The menu sends a named command and this does the same thing the button does,
   by calling the same function. That is the entire point: a menu that
   reimplemented the actions would be a second implementation to keep in step,
   and the two would disagree the first time either changed.

   Anything the menu cannot do is listed in `UNSUPPORTED` rather than ignored, so
   an action that arrives from a shell without an implementation says so in the
   console instead of doing nothing and looking like a dead menu item. */
const MENU_ACTIONS = {
  'open-files': () => openFiles(),
  'add-files': () => addFiles(),
  'add-folder': () => addFolder(),
  'clear-playlist': () => {
    clearReturnFocus = document.activeElement as HTMLElement | null;
    askToClear();
  },
  'play-pause': () => media.toggle(),
  'previous': () => step(-1),
  'next': () => step(1),
  /* One dialog at a time.

     Both of these could be open at once, and they could: opening Info while
     Settings was up left two modal dialogs stacked, and the one on top could be
     dismissed to reveal another underneath that the person had then forgotten
     about. Escape closes whichever is on top, so the state underneath survived -
     which is the worst shape for a modal pair, because neither dialog is
     reachable by its own close button any more.

     So opening one closes the other. Not "hides" - closes, properly, through the
     same function its own close button uses, so there is one way out of each and
     both are the same. */
  'settings': () => {
    if (!helpModal.hidden) setHelp(false);
    settings.toggle();
  },
  'info': () => {
    if (settings.isOpen()) settings.close();
    setHelp(true);
  },
  'toggle-panel': () => setList(!stage.classList.contains('list')),
  'toggle-controls': () => setUi(!stage.classList.contains('ui')),
  'fit-contain': () => setFit('contain'),
  'fit-cover': () => setFit('cover'),
  'fit-stretch': () => setFit('stretch'),
  fullscreen: () => media.toggleFullscreen(),
  'toggle-loop': () => toggleLoop(),
  'toggle-autoplay': () => toggleAutoStart(),
} as const;

/* The two states the menu shows as checkmarks. Read from the page and sent back
   whenever they change, because a checkmark that only knows what it was at start
   is worse than none: it says Loop is off while the playlist is looping. */
function publishMenuState() {
  const shell = window.MediaShell;
  if (!shell || typeof shell.menuState !== 'function') return;
  try {
    shell.menuState({
      loop: $('loop').classList.contains('on'),
      autoplay: $('autoplay').classList.contains('on'),
    });
  } catch { /* the shell is on its way out; nothing to do */ }
}

function runMenuCommand(command) {
  const action = MENU_ACTIONS[command];
  if (action) {
    action();
    publishMenuState();
    return;
  }
  console.warn('[app] the menu asked for something this build cannot do:', command);
}

if (window.MediaShell && typeof window.MediaShell.onMenuCommand === 'function') {
  window.MediaShell.onMenuCommand(runMenuCommand);
  publishMenuState();
}

/* The menu, callable.

   Not a test hook bolted on afterwards: the menu is this app's own interface -
   every action is reachable from it - and a suite that cannot send a command
   cannot check that a menu item does what the button it replaced did. Which is
   the bug a menu invites.

   Read-only in effect: it sends a named command through exactly the same table
   the shell sends it through, so exercising it here exercises the real route
   rather than a parallel one that could drift. */
if (typeof window.MediaMenu === 'undefined') {
  window.MediaMenu = {
    send: runMenuCommand,
    /* What every action is bound to right now. The menu reads it so its
       accelerators follow a reassignment instead of going stale. */
    get bindings() { return currentShortcuts(); },
    shortcuts: () => SHORTCUTS.map((entry) => ({ id: entry.id, label: entry.label, keys: keysOf(entry.id).slice() })),
  };
}

/* drop: window = add + play, sidebar = add only */

let dragTimer: ReturnType<typeof setTimeout> | undefined;

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
  if (!stage.contains(e.relatedTarget as Node | null)) clearDragHint();
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
  if (!side.contains(e.relatedTarget as Node | null)) clearDragHint();
});
side.addEventListener('drop', async (e) => {
  e.preventDefault();
  e.stopPropagation();
  clearDragHint();
  addItems(await pickedFrom(e), false);
});

/* A desktop source resolves paths over IPC, so dropItems may be async.

   The await is the point. This used to take the result, ask whether it was an
   array, and use it if so - which is right for a promise exactly never, because
   a pending promise is not an array. The check ran before the value existed, the
   result was discarded as not-an-array, and the drop added nothing. It was
   written as though the await were still ahead of it, one line down. */
async function pickedFrom(e) {
  try {
    const res = (await source.dropItems?.(e)) || [];
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
  const x = (e.target as HTMLElement).closest?.('.x');
  if (x) return removeItem(Number((x as HTMLElement).dataset.x));
  const li = (e.target as HTMLElement).closest?.('li');
  if (!li) return;
  /* A row whose file has moved is still removable, but selecting it would
     hand the player a path that is not there. */
  if (items[Number((li as HTMLElement).dataset.i)]?.missing) {
    notice(t('panel.missingHint'));
    return;
  }
  load(Number((li as HTMLElement).dataset.i), autoStart);
});

/* Keyboard equivalent of clicking a row. Without it the playlist is
   unusable without a mouse. */
list.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const x = (e.target as HTMLElement).closest?.('.x');
  if (x && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    removeItem(Number((x as HTMLElement).dataset.x));
    return;
  }
  /* Any other key - including the arrows - belongs to the row, so focus is not
     stranded on a button the user cannot get out of. */
  const li = (e.target as HTMLElement).closest?.('li');
  if (!li) return;
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    load(Number((li as HTMLElement).dataset.i), autoStart);
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    /* Move focus along the list, the way a listbox behaves. The step is taken
       from the row's position in the current DOM rather than from the model,
       because a render can renumber the rows between the keypress and here. */
    e.preventDefault();
    const stepBy = e.key === 'ArrowDown' ? 1 : -1;
    const here = [...list.children].indexOf(li);
    const next = here < 0 ? null : list.children[here + stepBy];
    if (next) (next as HTMLElement).focus();
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
  const li = (e.target as HTMLElement).closest?.('li');
  if (!li) return;
  dragNode = li as HTMLElement;
  li.classList.add('dragging');
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    /* The id is what the drop handler reads back. Absent would mean this row was
       never assigned one, which is not a state worth dragging. */
    const id = (li as HTMLElement).dataset.i;
    if (id !== undefined) e.dataTransfer.setData('text/plain', id);
  }
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
  const perm = [...list.children].map((li) => items[Number((li as HTMLElement).dataset.i)]);
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
  /* e.key is absent on some synthetic and IME key events */
  const k = typeof e.key === 'string' ? e.key : '';

  /* Ctrl+, is read before the modifier guard and has to be: the guard exists so
     a browser or window-manager shortcut is not swallowed, and it returns on any
     modifier. Sitting under it, the one shortcut with a modifier in it could
     never fire, and nothing said so. It is looked up in the table like every
     other key, so it can be reassigned like every other key. */
  const binding = bindingFromEvent(e);

  if (!clearModal.hidden) {
    if (k.toLowerCase() === 'escape') {
      dismissClear();
      if (clearReturnFocus && clearReturnFocus.focus) clearReturnFocus.focus();
      return;
    }

    /* Arrows move between the buttons, and it was asked for. HTML does not do
       this on its own: focus moves between buttons with Tab, and the arrow keys
       are for toolbars and menus. Both directions are accepted, because a person
       will try all four and a dead key is a worse answer than a wrong one. */
    if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown') {
      moveClearFocus(k === 'ArrowRight' || k === 'ArrowDown' ? 1 : -1);
      return;
    }

    /* Enter belongs to the focused button, so it is not intercepted. On the
       backdrop - which should not happen, because focus starts on a button - it
       cancels, because cancelling is the safe direction. */
    if (k === 'Enter' && !inClearDialog(e.target)) {
      dismissClear();
      if (clearReturnFocus && clearReturnFocus.focus) clearReturnFocus.focus();
    }
    return;
  }

  /* Which action this key is for, according to the table and the overrides.

     The table spells letters the way a keyboard does - P, not p - so the lookup
     folds case. e.key is case-sensitive and the table is not, and a lookup that
     compares them literally matches nothing at all for every letter: the whole
     keyboard went dead the moment the dispatch stopped being a chain of
     `k === 'p'`, where the lowercase came from the same expression on both
     sides.

     A single letter has no meaningful case, so folding it is safe. A named key
     is compared exactly, because "ArrowLeft" and "arrowleft" would otherwise be
     two bindings. */
  let action: ShortcutId | null = null;
  for (const entry of SHORTCUTS) {
    const matched = keysOf(entry.id).some((key) => normalise(key) === binding);
    if (matched) {
      action = entry.id;
      break;
    }
  }

  if (action === 'settings') {
    if (settings.isOpen()) return settings.close();
    settings.toggle();
    repaintShortcutLabels();
    return;
  }

  /* Every other modified key belongs to the browser or the window manager:
     Ctrl+R reloads, Ctrl+W closes, Alt+Tab switches. Swallowing those would
     make the app feel like it had captured the keyboard. */
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  /* Case-insensitive, because these three compare a name and the rest of the
     handler folds case for the table. They used to be lowercase because the key
     was lowercased once at the top of the handler; the table does its own
     folding, so that went, and with it every Escape comparison. */
  const isEscape = k.toLowerCase() === 'escape';
  if (isEscape && settings.isOpen()) return settings.close();
  if (isEscape && !helpModal.hidden) return setHelp(false);

  /* Dialogs and form controls own the keyboard while they are up. Without this
     M muted the video behind the settings dialog, arrow keys changed the volume
     while a <select> was open, and Space could not scroll the instructions. */
  const typing = (e.target as HTMLElement).closest?.('input, select, textarea, [contenteditable="true"]');
  if (settings.isOpen() || typing) return;

  /* the library's own sliders handle their arrow keys */
  if (media.ownsArrowKey(e.target) && k.startsWith('Arrow')) return;

  /* A focused playlist row handles its own Enter, Space and arrows. This
     listener is in the capture phase, so without this it consumed them first
     and the row was unreachable by keyboard - the row handler never ran. */
  const inRow = (e.target as HTMLElement).closest?.('#list li');
  if (inRow && (k === 'Enter' || k === ' ' || k.startsWith('Arrow'))) return;

  if (isEscape && stage.classList.contains('list')) return setList(false);
  if (!action) return;

  /* Space is play/pause even when a control still holds focus: otherwise the
     browser re-activates that button instead. Focus is only dropped for the
     control-bar case this was reported about, so keyboard navigation elsewhere
     is not destroyed. */
  if (action === 'playPause') {
    const focused = e.target as HTMLElement | null;
    if (focused && focused !== document.body && focused.closest?.('#bar') && typeof focused.blur === 'function') {
      focused.blur();
    }
    e.preventDefault();
    e.stopPropagation();
    if (stage.dataset.kind === 'image') return step(1);
    return toggle();
  }

  if (action === 'seekBack' || action === 'seekForward') {
    if (stage.dataset.kind === 'image') return;
    media.seekBy(action === 'seekBack' ? -SEEK_STEP : SEEK_STEP);
    e.preventDefault();
    return;
  }

  if (action === 'volumeUp' || action === 'volumeDown') {
    media.setVolume(media.volume + (action === 'volumeUp' ? VOL_STEP : -VOL_STEP));
    e.preventDefault();
    return;
  }

  switch (action) {
    case 'previous': return step(-1);
    case 'next': return step(1);
    case 'mute': return media.toggleMute();
    case 'loop': return toggleLoop();
    case 'autoplay': return toggleAutoStart();
    case 'fitDefault': return setFit('contain');
    case 'fitCrop': return setFit('cover');
    case 'fitStretch': return setFit('stretch');
    case 'fullscreen': return media.toggleFullscreen();
    case 'controls': return setUi(!stage.classList.contains('ui'));
    case 'panel': return setList(!stage.classList.contains('list'));
    case 'open': return openFiles();
    case 'addFolder': return addFolder();
    case 'clear':
      clearReturnFocus = document.activeElement as HTMLElement | null;
      return askToClear();
    case 'undo': return restoreCleared();
    default: return;
  }
}, true);

/* ---------------- boot ---------------- */

async function restore() {
  const state = await source.loadState();

  /* language + brand colour + logo first: the strings and the styles both
     depend on them */
  /* Repainted now that the saved bindings are in. The table was already rendered
     once at the bottom of this file, before the await, so the dialog is never
     empty if it is opened early - and so the labels on the controls exist
     before the saved state arrives. */
  loadShortcuts();
  renderShortcutTable();

  settings.load(state);
  if (state?.fit) stage.dataset.fit = state.fit;

  /* After settings.load, which applies the translations and writes every
     data-i18n-title. Painting before it was undone by the paint after it. */
  repaintShortcutLabels();

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

(window.I18n as I18nModule).onChange(() => {
  syncIcons();
  syncToggleTitles();
  /* The shortcut table renders its names, so it has to be rendered again. It was
     built once at boot, which meant the Settings dialog listed every action in
     English inside an Arabic app - the one part of the dialog that did not
     follow the language. */
  renderShortcutTable();
  /* After the translations are applied, because apply() writes every
     data-i18n-title - and the tooltip is one of those. Painting before it was
     silently undone, and the key vanished from the control. */
  paintShortcutLabels();
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
