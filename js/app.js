"use strict";
var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
const $ = /* @__PURE__ */ __name((id) => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`app: #${id} is not in the page`);
  return found;
}, "$");
const noticeEl = $("notice");
let noticeTimer;
function notice(text, { sticky = false, ms = 4e3 } = {}) {
  if (!noticeEl || !text) return;
  noticeEl.textContent = text;
  noticeEl.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    noticeEl.hidden = true;
  }, ms);
  noticeSticky = sticky;
}
__name(notice, "notice");
let noticeSticky = false;
const clearNotice = /* @__PURE__ */ __name(() => {
  if (noticeSticky) return;
  clearTimeout(noticeTimer);
  if (noticeEl) noticeEl.hidden = true;
}, "clearNotice");
const source = window.MediaFileSource;
const media = window.MediaBridge;
const settings = window.MediaSettings;
const { t, num } = window.I18n;
media.init();
const stage = $("stage");
const side = $("side");
const list = $("list");
const drop = $("drop");
const total = $("total");
const still = $("still");
const SEEK_STEP = 10;
const VOL_STEP = 0.05;
const THUMB_W = 160;
const FITS = { d: "contain", c: "cover", s: "stretch" };
let items = [];
let index = 0;
let loop = false;
let autoStart = true;
let saveTimer;
let dragNode = null;
let erroredIndex = -1;
let ready = false;
let queued = null;
let undo = null;
let undoTimer;
const mod = /* @__PURE__ */ __name((n, m) => (n % m + m) % m, "mod");
function fmt(s) {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor(s % 3600 / 60);
  const sec = Math.floor(s % 60);
  const pad = /* @__PURE__ */ __name((v) => String(v).padStart(2, "0").split("").map((ch) => num(Number(ch))).join(""), "pad");
  return (h ? num(h) + ":" + pad(m) : num(m)) + ":" + pad(sec);
}
__name(fmt, "fmt");
function once(el, event, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      el.removeEventListener(event, ok);
      reject(new Error("timeout " + event));
    }, ms);
    const ok = /* @__PURE__ */ __name(() => {
      clearTimeout(timer);
      el.removeEventListener(event, ok);
      resolve();
    }, "ok");
    el.addEventListener(event, ok);
  });
}
__name(once, "once");
function drawThumb(el) {
  const w = el.videoWidth;
  const h = el.videoHeight;
  if (!w || !h) return null;
  const scale = THUMB_W / w;
  const canvas = document.createElement("canvas");
  canvas.width = THUMB_W;
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.6);
}
__name(drawThumb, "drawThumb");
async function drawImageThumb(url) {
  try {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = url;
    await (img.decode ? img.decode() : new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
    }));
    if (!img.naturalWidth) return null;
    const scale = THUMB_W / img.naturalWidth;
    const canvas = document.createElement("canvas");
    canvas.width = THUMB_W;
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.6);
  } catch {
    return null;
  }
}
__name(drawImageThumb, "drawImageThumb");
async function probe(item) {
  if (typeof source.fileExists === "function") {
    item.missing = !await source.fileExists(item);
    if (item.missing) return item;
  }
  if (item.kind === "image") {
    item.thumb = await drawImageThumb(source.urlFor(item));
    return item;
  }
  const el = document.createElement(item.kind === "audio" ? "audio" : "video");
  el.muted = true;
  el.playsInline = true;
  el.crossOrigin = "anonymous";
  el.preload = "metadata";
  try {
    el.src = source.urlFor(item);
  } catch (err) {
    console.warn("[app] cannot resolve", item.name, err);
    return item;
  }
  try {
    await once(el, "loadedmetadata", 2500);
    if (Number.isFinite(el.duration)) item.duration = el.duration;
    else if (el.duration === Infinity) item.duration = null, item.openEnded = true;
    if (el.videoWidth) {
      el.currentTime = Math.min(0.1, el.duration / 2);
      await once(el, "seeked", 2e3);
      item.thumb = drawThumb(el);
    }
  } catch {
  }
  el.removeAttribute("src");
  el.load();
  return item;
}
__name(probe, "probe");
function runProbes(batch) {
  probeAll(batch).catch((err) => console.warn("[app] the probe queue stopped:", err));
}
__name(runProbes, "runProbes");
async function probeAll(batch) {
  let next = 0;
  const worker = /* @__PURE__ */ __name(async () => {
    while (next < batch.length) {
      const item = batch[next++];
      await probe(item);
      refreshRow(item);
    }
  }, "worker");
  await Promise.all([worker(), worker(), worker()]);
}
__name(probeAll, "probeAll");
function existingIndexOf(item) {
  if (!item) return -1;
  const by = item.path ? (it) => it && it.path === item.path : (it) => it && it.name === item.name && it.size === item.size;
  return items.findIndex(by);
}
__name(existingIndexOf, "existingIndexOf");
function addItems(incoming, play) {
  if (!incoming || !incoming.length) return;
  undo = null;
  clearTimeout(undoTimer);
  if (!ready) {
    queued = (queued || []).concat([{ items: incoming, play }]);
    return;
  }
  const fresh = incoming.map((it) => ({ ...it, duration: null, thumb: null, position: 0 }));
  if (!fresh.length) return;
  const wanted = fresh.filter((it) => existingIndexOf(it) === -1);
  if (!wanted.length) {
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
__name(addItems, "addItems");
function restoreCleared() {
  if (!undo) return;
  const saved = undo;
  undo = null;
  clearTimeout(undoTimer);
  if (items.length) clearAll(false);
  items = saved.items.slice();
  index = 0;
  render();
  if (items.length) load(Math.min(saved.index, items.length - 1), false);
  notice(t("notice.restored", { n: num(items.length) }));
}
__name(restoreCleared, "restoreCleared");
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
    return clearAll(false);
  }
  if (wasCurrent) {
    load(Math.min(nextIndex, items.length - 1), autoStart);
    source.release(removed);
    return;
  }
  source.release(removed);
  index = nextIndex;
  render();
  scheduleSave();
}
__name(removeItem, "removeItem");
function clearAll(keepUndo) {
  media.clear();
  if (keepUndo && items.length) {
    undo = { items: items.slice(), index };
    clearTimeout(undoTimer);
    undoTimer = setTimeout(() => {
      undo = null;
    }, 3e4);
  }
  for (const it of items) source.release(it);
  items = [];
  index = 0;
  stage.dataset.kind = "";
  drop.hidden = false;
  renderEmptyState();
  $("title").textContent = "";
  $("counter").textContent = "";
  render();
  scheduleSave();
}
__name(clearAll, "clearAll");
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
    console.warn("[app] cannot resolve", it.name, err);
    notice(t("notice.cannotPlay"));
    return;
  }
  media.load({ url, mime: it.mime, kind: it.kind, position: it.position }, it.kind, play);
  syncIcons(!!play && it.kind !== "image");
  setTimeout(syncIcons, 0);
  render();
  scheduleSave();
}
__name(load, "load");
function step(dir) {
  if (!items.length) return;
  load(index + dir, autoStart);
}
__name(step, "step");
function toggle() {
  if (!items.length) return;
  if (stage.dataset.kind === "image") return step(1);
  media.toggle();
}
__name(toggle, "toggle");
function syncToggleTitles() {
  $("loop").title = loop ? t("bar.loopOn") : t("bar.loopKey");
  $("autoplay").title = autoStart ? t("bar.autoplayKey") : t("bar.autoplayOff");
  $("loop").setAttribute("aria-pressed", String(loop));
  $("autoplay").setAttribute("aria-pressed", String(autoStart));
  publishMenuState();
}
__name(syncToggleTitles, "syncToggleTitles");
function toggleLoop() {
  loop = !loop;
  $("loop").classList.toggle("on", loop);
  syncToggleTitles();
  media.setLoop(loop);
  scheduleSave();
}
__name(toggleLoop, "toggleLoop");
function toggleAutoStart() {
  autoStart = !autoStart;
  $("autoplay").classList.toggle("on", autoStart);
  $("autoplay").classList.toggle("off", !autoStart);
  syncToggleTitles();
  scheduleSave();
}
__name(toggleAutoStart, "toggleAutoStart");
function setFit(mode) {
  if (!mode) return;
  stage.dataset.fit = mode;
  for (const key of Object.keys(FITS)) {
    $("fit-" + key).classList.toggle("on", FITS[key] === mode);
  }
  scheduleSave();
}
__name(setFit, "setFit");
function setUi(on) {
  stage.classList.toggle("ui", on);
  publishBarHeight();
  scheduleSave();
}
__name(setUi, "setUi");
function publishBarHeight() {
  const bar = $("bar");
  stage.style.setProperty("--bar-h", bar.offsetHeight + "px");
}
__name(publishBarHeight, "publishBarHeight");
function setList(on) {
  stage.classList.toggle("list", on);
  renderEmptyState();
  scheduleSave();
}
__name(setList, "setList");
function renderEmptyState() {
  const open = stage.classList.contains("list") && !items.length;
  const note = $("side-empty");
  if (note) note.hidden = !open;
  list.hidden = open;
  const hint = document.querySelector(".side-hint");
  if (hint) hint.hidden = open || !items.length;
}
__name(renderEmptyState, "renderEmptyState");
const KIND_GLYPH = {
  video: '<svg viewBox="0 0 24 24"><path d="M7 4.5 20 12 7 19.5z" fill="currentColor"/></svg>',
  audio: '<svg viewBox="0 0 24 24"><path d="M9 17.5V6.2l10-2v11.1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6.5" cy="17.5" r="2.6" fill="currentColor"/><circle cx="16.5" cy="15.3" r="2.6" fill="currentColor"/></svg>',
  image: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="m6.5 16.5 3.8-4.2 2.7 2.8 2.4-2.4 2.1 2.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
};
function thumbNode(item) {
  const box = document.createElement("span");
  box.className = "thumb";
  if (item.kind) {
    const badge = document.createElement("span");
    badge.className = "kd";
    badge.setAttribute("aria-hidden", "true");
    badge.innerHTML = KIND_GLYPH[item.kind] || "";
    box.append(badge);
  }
  if (item.thumb) {
    const img = document.createElement("img");
    img.src = item.thumb;
    img.alt = "";
    box.prepend(img);
  } else {
    const glyph = document.createElement("span");
    glyph.className = item.missing ? "gone" : "gl";
    glyph.textContent = item.kind === "audio" ? "♪" : item.kind === "image" ? "▢" : "▣";
    box.append(glyph);
  }
  return box;
}
__name(thumbNode, "thumbNode");
function renderList() {
  if (dragNode) return;
  list.textContent = "";
  items.forEach((item, i) => {
    const li = document.createElement("li");
    li.dataset.i = String(i);
    li.draggable = true;
    li.tabIndex = 0;
    li.setAttribute("role", "button");
    if (i === index) li.setAttribute("aria-current", "true");
    li.classList.toggle("on", i === index);
    const name = document.createElement("span");
    name.className = "nm";
    name.textContent = item.name;
    name.title = item.path || item.name;
    const dur = document.createElement("span");
    dur.className = "dur";
    if (item.missing) {
      dur.classList.add("missing");
      dur.textContent = t("panel.missing");
      dur.title = t("panel.missingHint");
    }
    dur.textContent = item.kind === "image" ? "—" : item.duration ? fmt(item.duration) : item.openEnded ? "∞" : "…";
    const x = document.createElement("button");
    x.className = "x";
    x.type = "button";
    x.title = t("panel.remove");
    x.setAttribute("aria-label", t("panel.removeAria"));
    x.textContent = "✕";
    x.dataset.x = String(i);
    if (item.missing) li.classList.add("missing");
    li.append(thumbNode(item), name, dur, x);
    list.append(li);
  });
  updateTotal();
}
__name(renderList, "renderList");
function refreshRow(item) {
  if (dragNode) return;
  const i = items.indexOf(item);
  if (i < 0) return;
  const li = list.children[i];
  if (!li) return renderList();
  const existing = li.querySelector?.(".thumb") || li.firstElementChild || li.children[0];
  const nextThumb = thumbNode(item);
  if (existing && existing.replaceWith) existing.replaceWith(nextThumb);
  else if (existing) li.replaceChild?.(nextThumb, existing);
  else li.prepend(nextThumb);
  const durCell = li.querySelector?.(".dur");
  if (durCell) {
    durCell.textContent = item.kind === "image" ? "—" : item.duration ? fmt(item.duration) : item.openEnded ? "∞" : "…";
  }
  updateTotal();
}
__name(refreshRow, "refreshRow");
function updateTotal() {
  const known = items.filter((it) => it.duration);
  total.textContent = !items.length ? "" : known.length === items.length ? t("panel.itemsTotal", { n: num(items.length), time: fmt(known.reduce((a, b) => a + (b.duration || 0), 0)) }) : t("panel.items", { n: num(items.length) });
}
__name(updateTotal, "updateTotal");
function render() {
  const it = items[index];
  $("title").textContent = it ? it.name : "";
  $("counter").textContent = items.length > 1 && it ? num(index + 1) + " / " + num(items.length) : "";
  renderList();
  const row = list.children[index];
  if (row && typeof row.scrollIntoView === "function") {
    try {
      row.scrollIntoView({ block: "nearest" });
    } catch {
    }
  }
}
__name(render, "render");
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 400);
}
__name(scheduleSave, "scheduleSave");
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
    ui: stage.classList.contains("ui"),
    list: stage.classList.contains("list"),
    settings: settings.save()
  });
}
__name(save, "save");
async function pick(play) {
  const all = await source.openFiles();
  reportUnusable(all);
  const picked = all.filter((it) => it.kind);
  if (picked.length) addItems(picked, play);
}
__name(pick, "pick");
function reportUnusable(all) {
  const skipped = (all || []).filter((it) => !it.kind).length;
  if (skipped) notice(t("notice.dropped", { n: num(skipped) }), { sticky: true });
}
__name(reportUnusable, "reportUnusable");
$("next").onclick = () => step(1);
$("prev").onclick = () => step(-1);
$("loop").onclick = toggleLoop;
$("autoplay").onclick = toggleAutoStart;
for (const key of Object.keys(FITS)) $("fit-" + key).onclick = () => setFit(FITS[key]);
$("fs").onclick = () => {
  Promise.resolve(media.toggleFullscreen()).then(() => syncIcons());
};
function openFiles() {
  return pick(true);
}
__name(openFiles, "openFiles");
function addFiles() {
  return pick(false);
}
__name(addFiles, "addFiles");
async function addFolder() {
  const all = await source.openFolder?.() || [];
  reportUnusable(all);
  const picked = all.filter((it) => it.kind);
  if (picked.length) addItems(picked, false);
}
__name(addFolder, "addFolder");
const addFilesAction = /* @__PURE__ */ __name(() => addFiles(), "addFilesAction");
const openButton = document.getElementById("open");
if (openButton) openButton.onclick = () => openFiles();
$("add").onclick = addFilesAction;
$("empty-add").onclick = addFilesAction;
const clearModal = $("clear-modal");
function askToClear() {
  if (clearModal.hidden) clearModal.hidden = false;
  $("clear-cancel").focus();
}
__name(askToClear, "askToClear");
function dismissClear() {
  clearModal.hidden = true;
}
__name(dismissClear, "dismissClear");
let clearReturnFocus = null;
$("clear-ok").onclick = () => {
  dismissClear();
  if (clearReturnFocus && clearReturnFocus.focus) clearReturnFocus.focus();
  clearAll(true);
};
$("clear-cancel").onclick = () => {
  dismissClear();
  if (clearReturnFocus && clearReturnFocus.focus) clearReturnFocus.focus();
};
function inClearDialog(target) {
  return !!clearModal.contains(target);
}
__name(inClearDialog, "inClearDialog");
clearModal.addEventListener("click", (e) => {
  if (e.target === clearModal) {
    dismissClear();
    if (clearReturnFocus && clearReturnFocus.focus) clearReturnFocus.focus();
  }
});
if (source.canPersist()) {
  const clearButton = $("clear-list");
  if (clearButton) {
    clearButton.hidden = false;
    clearButton.onclick = () => {
      clearReturnFocus = document.activeElement;
      askToClear();
    };
  }
}
if (typeof source.openFolder === "function") {
  const addFolderButton = $("add-folder");
  if (addFolderButton) {
    addFolderButton.hidden = false;
    addFolderButton.onclick = addFolder;
  }
  const emptyAddFolder = $("empty-add-folder");
  if (emptyAddFolder) {
    emptyAddFolder.hidden = false;
    emptyAddFolder.onclick = addFolder;
  }
}
if (typeof source.onExternalDrop === "function") {
  source.onExternalDrop((incoming) => {
    reportUnusable(incoming);
    const picked = incoming.filter((it) => it.kind);
    if (picked.length) addItems(picked, true);
  });
}
window.addEventListener("resize", () => {
  publishBarHeight();
  scheduleSave();
});
if (typeof ResizeObserver === "function") {
  new ResizeObserver(publishBarHeight).observe($("bar"));
}
media.on("time", ({ currentTime }) => {
  if (stage.dataset.kind === "image") return;
  if (items[index]) items[index].position = currentTime;
  const d = media.duration;
  media.paintTime(Number.isFinite(d) && d > 0 ? currentTime / d : 0);
  const cur = $("time-now");
  const dur = $("time-total");
  if (cur) cur.textContent = fmt(currentTime);
  if (dur) dur.textContent = Number.isFinite(d) && d > 0 ? fmt(d) : zeroTime();
});
still.addEventListener("click", (e) => e.stopPropagation());
media.on("pause", scheduleSave);
media.on("play", clearNotice);
media.on("play", scheduleSave);
media.on("ended", () => {
  const next = index + 1;
  if (next < items.length) return load(next, autoStart);
  if (loop) return load(0, true);
  media.pause();
  scheduleSave();
});
media.on("error", () => {
  if (items.length < 2) {
    notice(t("notice.cannotPlay"));
    media.pause();
    return;
  }
  if (erroredIndex === index) return;
  erroredIndex = index;
  const next = index + 1;
  if (next < items.length) return load(next, autoStart);
  if (loop) return load(0, autoStart);
  notice(t("notice.cannotPlay"));
  media.pause();
  scheduleSave();
});
media.on("blocked", () => notice(t("notice.blocked")));
$("mute").onclick = () => media.toggleMute();
const volumeInput = $("volume");
volumeInput.addEventListener("input", () => media.setVolume(Number(volumeInput.value)));
const showVolume = /* @__PURE__ */ __name(() => {
  const wanted = media.muted ? 0 : media.volume;
  if (document.activeElement !== volumeInput) volumeInput.value = String(wanted);
  media.paintVolume(media.volume);
}, "showVolume");
media.on("volume", () => {
  showVolume();
  syncIcons();
});
showVolume();
const SHORTCUTS = [
  { id: "playPause", label: "bar.play", keys: ["Space", "K"] },
  { id: "seekBack", label: "bar.back", keys: ["ArrowLeft"] },
  { id: "seekForward", label: "bar.forward", keys: ["ArrowRight"] },
  { id: "volumeUp", label: "bar.volumeUp", keys: ["ArrowUp"] },
  { id: "volumeDown", label: "bar.volumeDown", keys: ["ArrowDown"] },
  { id: "previous", label: "bar.previous", keys: [","] },
  { id: "next", label: "bar.next", keys: ["."] },
  { id: "mute", label: "bar.mute", keys: ["M"] },
  { id: "loop", label: "bar.loop", keys: ["L"] },
  { id: "autoplay", label: "bar.autoplay", keys: ["A"] },
  { id: "fitDefault", label: "bar.fitDefault", keys: ["D"] },
  { id: "fitCrop", label: "bar.fitCrop", keys: ["C"] },
  { id: "fitStretch", label: "bar.fitStretch", keys: ["S"] },
  { id: "fullscreen", label: "bar.fullscreen", keys: ["F"] },
  { id: "controls", label: "bar.controls", keys: ["H"] },
  { id: "panel", label: "bar.panel", keys: ["P"] },
  { id: "open", label: "bar.open", keys: ["O"] },
  { id: "addFolder", label: "bar.addFolder", keys: ["Shift+O"] },
  { id: "clear", label: "panel.clearTitle", keys: ["Shift+X"] },
  { id: "undo", label: "bar.undo", keys: ["Shift+Z"] },
  { id: "settings", label: "bar.settings", keys: ["Ctrl+,"] }
];
let shortcutOverrides = {};
function keysOf(id) {
  return shortcutOverrides[id] || SHORTCUTS.find((s) => s.id === id).keys;
}
__name(keysOf, "keysOf");
function prettyKey(key) {
  const parts = key.split("+");
  const last = parts.pop();
  const named = {
    ArrowLeft: "←",
    ArrowRight: "→",
    ArrowUp: "↑",
    ArrowDown: "↓",
    " ": "Space",
    Control: "Ctrl",
    Ctrl: "Ctrl",
    Meta: "Ctrl",
    Command: "Ctrl",
    Escape: "Esc",
    Shift: "Shift",
    Alt: "Alt",
    AltGraph: "AltGr",
    Enter: "Enter",
    Tab: "Tab",
    Backspace: "Backspace",
    Delete: "Del"
  };
  const mods = parts.map((p) => named[p] || p);
  const tail = named[last] || (last.length === 1 ? last.toUpperCase() : last);
  return [...mods, tail].join("+");
}
__name(prettyKey, "prettyKey");
const MODIFIER_ORDER = ["Control", "Alt", "Shift"];
const MODIFIER_ALIASES = {
  Ctrl: "Control",
  Control: "Control",
  Meta: "Control",
  Cmd: "Control",
  Command: "Control",
  Super: "Control",
  Alt: "Alt",
  Option: "Alt",
  Shift: "Shift"
};
const SPACING_ALIASES = {
  " ": "Space",
  Space: "Space",
  Spacebar: "Space",
  Escape: "Escape",
  Esc: "Escape",
  Left: "ArrowLeft",
  Right: "ArrowRight",
  Up: "ArrowUp",
  Down: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  Del: "Delete",
  Return: "Enter"
};
function normaliseBinding(binding) {
  const parts = binding.split("+");
  const key = parts.pop() || "";
  const mods = MODIFIER_ORDER.filter((m) => parts.some((p) => MODIFIER_ALIASES[p] === m));
  const folded = key.length === 1 ? key.toUpperCase() : key;
  const canonical = SPACING_ALIASES[folded] || folded;
  const dropShift = mods.includes("Shift") && key.length === 1 && !/[a-z0-9]/i.test(key);
  return [...mods.filter((m) => !(dropShift && m === "Shift")), canonical].join("+");
}
__name(normaliseBinding, "normaliseBinding");
function bindingFromEvent(event) {
  const key = typeof event.key === "string" ? event.key : "";
  const mods = [
    event.ctrlKey || event.metaKey ? "Control" : "",
    event.altKey ? "Alt" : "",
    event.shiftKey ? "Shift" : ""
  ].filter(Boolean);
  return normaliseBinding([...mods, key].join("+"));
}
__name(bindingFromEvent, "bindingFromEvent");
function normalise(key) {
  return normaliseBinding(key);
}
__name(normalise, "normalise");
function ownerOf(binding) {
  const wanted = normalise(binding);
  for (const entry of SHORTCUTS) {
    if (keysOf(entry.id).some((key) => normalise(key) === wanted)) return entry.id;
  }
  return null;
}
__name(ownerOf, "ownerOf");
function setShortcut(id, keys) {
  const clash = keys.map((k) => ownerOf(k)).find((owner) => owner && owner !== id);
  if (clash) return { ok: false, owner: clash };
  shortcutOverrides[id] = keys;
  paintShortcutLabels();
  saveShortcuts();
  return { ok: true };
}
__name(setShortcut, "setShortcut");
function resetShortcuts() {
  shortcutOverrides = {};
  paintShortcutLabels();
  saveShortcuts();
}
__name(resetShortcuts, "resetShortcuts");
function currentShortcuts() {
  const out = {};
  for (const entry of SHORTCUTS) out[entry.id] = keysOf(entry.id).slice();
  return out;
}
__name(currentShortcuts, "currentShortcuts");
const STATE_LABELS = {
  mute: /* @__PURE__ */ __name(() => $("mute").classList.contains("muted") ? t("bar.unmute") : t("bar.mute"), "mute"),
  fullscreen: /* @__PURE__ */ __name(() => media.fullscreen ? t("bar.fullscreenExit") : t("bar.fullscreen"), "fullscreen")
};
function paintStateTooltips() {
  for (const id of Object.keys(STATE_LABELS)) paintShortcutLabel(id);
}
__name(paintStateTooltips, "paintStateTooltips");
function paintShortcutLabels() {
  for (const entry of SHORTCUTS) paintShortcutLabel(entry.id);
}
__name(paintShortcutLabels, "paintShortcutLabels");
function paintShortcutLabel(id) {
  {
    const entry = SHORTCUTS.find((e) => e.id === id);
    if (!entry) return;
    const keys = keysOf(entry.id);
    const suffix = keys.length ? ` (${keys.map(prettyKey).join(", ")})` : "";
    for (const el of document.querySelectorAll(`[data-shortcut="${entry.id}"]`)) {
      const stateful = STATE_LABELS[entry.id];
      let label = "";
      if (stateful) {
        label = stateful() || "";
      } else {
        const base = el.getAttribute("data-i18n-title");
        const translated = base ? t(base) : el.title;
        label = translated.replace(/\s*\([^)]*\)\s*$/, "") || translated;
      }
      el.title = label + suffix;
    }
  }
}
__name(paintShortcutLabel, "paintShortcutLabel");
function saveShortcuts() {
  try {
    localStorage.setItem("mediatools.shortcuts", JSON.stringify(shortcutOverrides));
  } catch (err) {
    console.warn("[app] could not save the shortcuts:", err);
  }
}
__name(saveShortcuts, "saveShortcuts");
function loadShortcuts() {
  try {
    const raw = localStorage.getItem("mediatools.shortcuts");
    if (!raw) return;
    const parsed = JSON.parse(raw);
    const known = new Set(SHORTCUTS.map((entry) => entry.id));
    for (const [id, keys] of Object.entries(parsed)) {
      if (known.has(id) && Array.isArray(keys) && keys.every((k) => typeof k === "string")) {
        shortcutOverrides[id] = keys;
      }
    }
  } catch (err) {
    console.warn("[app] could not read the saved shortcuts, using the defaults:", err);
  }
}
__name(loadShortcuts, "loadShortcuts");
function syncIcons(playing) {
  const isPlaying = playing === void 0 ? media.playing : !!playing;
  const muted = media.muted || media.volume === 0;
  $("play").classList.toggle("playing", isPlaying);
  $("mute").classList.toggle("muted", muted);
  $("mute").setAttribute("aria-pressed", String(muted));
  const inFs = media.fullscreen;
  $("fs").classList.toggle("on", inFs);
  $("fs").title = inFs ? t("bar.fullscreenExitKey") : t("bar.fullscreenKey");
  $("fs").setAttribute("aria-label", inFs ? t("bar.fullscreenExit") : t("bar.fullscreen"));
  $("mute").setAttribute("aria-label", muted ? t("bar.unmute") : t("bar.mute"));
  paintStateTooltips();
  $("play").setAttribute("aria-label", isPlaying ? t("bar.pause") : t("bar.play"));
  $("loop").setAttribute("aria-pressed", String(loop));
  $("autoplay").setAttribute("aria-pressed", String(autoStart));
  publishMenuState();
}
__name(syncIcons, "syncIcons");
stage.addEventListener("dblclick", () => media.toggleFullscreen());
const helpModal = $("help-modal");
helpModal.hidden = true;
$("settings-modal").hidden = true;
function setHelp(on) {
  helpModal.hidden = !on;
  if (on) {
    const first = $("help-close");
    if (first && typeof first.focus === "function") first.focus();
  } else {
    const back = document.querySelector(".bar, #stage");
    if (back && typeof back.focus === "function") back.focus();
  }
}
__name(setHelp, "setHelp");
const helpButton = document.getElementById("help");
if (helpButton) helpButton.onclick = () => setHelp(true);
$("help-close").onclick = () => setHelp(false);
function trapFocus(dialog, e) {
  if (e.key !== "Tab") return;
  const focusable = [...dialog.querySelectorAll(
    'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])'
  )].filter((node) => !node.closest("[hidden]") && !node.disabled);
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
__name(trapFocus, "trapFocus");
document.addEventListener("keydown", (e) => {
  const open = settings.isOpen() ? $("settings-modal") : helpModal.hidden ? null : helpModal;
  if (open) trapFocus(open, e);
}, true);
helpModal.addEventListener("pointerdown", (e) => {
  if (e.target === helpModal) setHelp(false);
});
stage.addEventListener("pointerdown", (e) => {
  if (!stage.classList.contains("list")) return;
  if (e.target.closest?.("#side, #bar")) return;
  setList(false);
});
const syncIconsFromEvent = /* @__PURE__ */ __name(() => syncIcons(), "syncIconsFromEvent");
media.on("play", syncIconsFromEvent);
media.on("pause", syncIconsFromEvent);
media.onFullscreenChange(syncIconsFromEvent);
syncIcons();
let capturing = null;
function renderShortcutTable() {
  const body = document.getElementById("shortcut-rows");
  if (!body) return;
  body.textContent = "";
  for (const entry of SHORTCUTS) {
    const row = document.createElement("tr");
    row.dataset.shortcutRow = entry.id;
    const name = document.createElement("th");
    name.textContent = t(entry.label);
    row.appendChild(name);
    const cell = document.createElement("td");
    const button = document.createElement("button");
    button.className = "key-cell";
    button.type = "button";
    button.dataset.shortcutCell = entry.id;
    button.textContent = keysOf(entry.id).map(prettyKey).join(", ") || "—";
    cell.appendChild(button);
    row.appendChild(cell);
    body.appendChild(row);
  }
}
__name(renderShortcutTable, "renderShortcutTable");
function beginCapture(id, cell) {
  endCapture();
  capturing = { id, row: cell.closest("tr"), cell };
  cell.textContent = t("settings.shortcutsPress");
  cell.classList.add("capturing");
  cell.focus?.();
}
__name(beginCapture, "beginCapture");
function endCapture() {
  if (!capturing) return;
  capturing.cell.classList.remove("capturing");
  capturing.cell.textContent = keysOf(capturing.id).map(prettyKey).join(", ") || "—";
  capturing = null;
}
__name(endCapture, "endCapture");
document.getElementById("shortcut-rows")?.addEventListener("click", (e) => {
  const button = e.target.closest("[data-shortcut-cell]");
  if (!button || !button.dataset.shortcutCell) return;
  beginCapture(button.dataset.shortcutCell, button);
});
document.addEventListener("keydown", (e) => {
  if (!capturing) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === "Escape") {
    const back = capturing.cell;
    endCapture();
    back.focus?.();
    return;
  }
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
  const id = capturing.id;
  const binding = bindingFromEvent(e);
  const result = setShortcut(id, [binding]);
  if (!result.ok) {
    const hint2 = document.getElementById("shortcut-hint");
    if (hint2) {
      hint2.textContent = t("settings.shortcutsTaken") + " — " + t(SHORTCUTS.find((s2) => s2.id === result.owner).label);
      hint2.classList.add("is-error");
    }
    endCapture();
    return;
  }
  const hint = document.getElementById("shortcut-hint");
  if (hint) {
    hint.textContent = t("settings.shortcutsSaved");
    hint.classList.remove("is-error");
  }
  endCapture();
  renderShortcutTable();
  const again = document.querySelector(`[data-shortcut-cell="${id}"]`);
  again?.focus?.();
}, true);
renderShortcutTable();
function repaintShortcutLabels() {
  paintShortcutLabels();
}
__name(repaintShortcutLabels, "repaintShortcutLabels");
const resetButton = document.getElementById("shortcut-reset");
if (resetButton) {
  resetButton.onclick = () => {
    resetShortcuts();
    renderShortcutTable();
    const hint = document.getElementById("shortcut-hint");
    if (hint) {
      hint.textContent = t("settings.shortcutsReset");
      hint.classList.remove("is-error");
    }
  };
}
const MENU_ACTIONS = {
  "open-files": /* @__PURE__ */ __name(() => openFiles(), "open-files"),
  "add-files": /* @__PURE__ */ __name(() => addFiles(), "add-files"),
  "add-folder": /* @__PURE__ */ __name(() => addFolder(), "add-folder"),
  "clear-playlist": /* @__PURE__ */ __name(() => {
    clearReturnFocus = document.activeElement;
    askToClear();
  }, "clear-playlist"),
  "play-pause": /* @__PURE__ */ __name(() => media.toggle(), "play-pause"),
  "previous": /* @__PURE__ */ __name(() => step(-1), "previous"),
  "next": /* @__PURE__ */ __name(() => step(1), "next"),
  "settings": /* @__PURE__ */ __name(() => settings.toggle(), "settings"),
  "info": /* @__PURE__ */ __name(() => setHelp(true), "info"),
  "toggle-panel": /* @__PURE__ */ __name(() => setList(!stage.classList.contains("list")), "toggle-panel"),
  "toggle-controls": /* @__PURE__ */ __name(() => setUi(!stage.classList.contains("ui")), "toggle-controls"),
  "fit-contain": /* @__PURE__ */ __name(() => setFit("contain"), "fit-contain"),
  "fit-cover": /* @__PURE__ */ __name(() => setFit("cover"), "fit-cover"),
  "fit-stretch": /* @__PURE__ */ __name(() => setFit("stretch"), "fit-stretch"),
  fullscreen: /* @__PURE__ */ __name(() => media.toggleFullscreen(), "fullscreen"),
  "toggle-loop": /* @__PURE__ */ __name(() => toggleLoop(), "toggle-loop"),
  "toggle-autoplay": /* @__PURE__ */ __name(() => toggleAutoStart(), "toggle-autoplay")
};
function publishMenuState() {
  const shell = window.MediaShell;
  if (!shell || typeof shell.menuState !== "function") return;
  try {
    shell.menuState({
      loop: $("loop").classList.contains("on"),
      autoplay: $("autoplay").classList.contains("on")
    });
  } catch {
  }
}
__name(publishMenuState, "publishMenuState");
function runMenuCommand(command) {
  const action = MENU_ACTIONS[command];
  if (action) {
    action();
    publishMenuState();
    return;
  }
  console.warn("[app] the menu asked for something this build cannot do:", command);
}
__name(runMenuCommand, "runMenuCommand");
if (window.MediaShell && typeof window.MediaShell.onMenuCommand === "function") {
  window.MediaShell.onMenuCommand(runMenuCommand);
  publishMenuState();
}
if (typeof window.MediaMenu === "undefined") {
  window.MediaMenu = {
    send: runMenuCommand,
    /* What every action is bound to right now. The menu reads it so its
       accelerators follow a reassignment instead of going stale. */
    get bindings() {
      return currentShortcuts();
    },
    shortcuts: /* @__PURE__ */ __name(() => SHORTCUTS.map((entry) => ({ id: entry.id, label: entry.label, keys: keysOf(entry.id).slice() })), "shortcuts")
  };
}
let dragTimer;
function clearDragHint() {
  clearTimeout(dragTimer);
  stage.classList.remove("over");
  side.classList.remove("over");
}
__name(clearDragHint, "clearDragHint");
function markDragHint() {
  clearTimeout(dragTimer);
  stage.classList.add("over");
  dragTimer = setTimeout(clearDragHint, 4e3);
}
__name(markDragHint, "markDragHint");
stage.addEventListener("dragover", (e) => {
  e.preventDefault();
  if (dragNode) return;
  markDragHint();
});
stage.addEventListener("dragleave", (e) => {
  if (!stage.contains(e.relatedTarget)) clearDragHint();
});
document.addEventListener("dragleave", clearDragHint);
document.addEventListener("drop", clearDragHint);
document.addEventListener("dragend", clearDragHint);
window.addEventListener("blur", clearDragHint);
stage.addEventListener("drop", async (e) => {
  e.preventDefault();
  clearDragHint();
  addItems(await pickedFrom(e), true);
});
side.addEventListener("dragover", (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (dragNode) return;
  markDragHint();
});
side.addEventListener("dragleave", (e) => {
  if (!side.contains(e.relatedTarget)) clearDragHint();
});
side.addEventListener("drop", async (e) => {
  e.preventDefault();
  e.stopPropagation();
  clearDragHint();
  addItems(await pickedFrom(e), false);
});
async function pickedFrom(e) {
  try {
    const res = await source.dropItems?.(e) || [];
    const all = Array.isArray(res) ? res : [];
    reportUnusable(all);
    return all.filter((it) => it && it.kind);
  } catch (err) {
    console.warn("[app] could not read the dropped items:", err);
    return [];
  }
}
__name(pickedFrom, "pickedFrom");
list.addEventListener("click", (e) => {
  const x = e.target.closest?.(".x");
  if (x) return removeItem(Number(x.dataset.x));
  const li = e.target.closest?.("li");
  if (!li) return;
  if (items[Number(li.dataset.i)]?.missing) {
    notice(t("panel.missingHint"));
    return;
  }
  load(Number(li.dataset.i), autoStart);
});
list.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const x = e.target.closest?.(".x");
  if (x && (e.key === "Enter" || e.key === " ")) {
    e.preventDefault();
    removeItem(Number(x.dataset.x));
    return;
  }
  const li = e.target.closest?.("li");
  if (!li) return;
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    load(Number(li.dataset.i), autoStart);
  } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const stepBy = e.key === "ArrowDown" ? 1 : -1;
    const here = [...list.children].indexOf(li);
    const next = here < 0 ? null : list.children[here + stepBy];
    if (next) next.focus();
  }
});
function cancelDrag() {
  dragNode = null;
  renderList();
}
__name(cancelDrag, "cancelDrag");
list.addEventListener("dragstart", (e) => {
  const li = e.target.closest?.("li");
  if (!li) return;
  dragNode = li;
  li.classList.add("dragging");
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = "move";
    const id = li.dataset.i;
    if (id !== void 0) e.dataTransfer.setData("text/plain", id);
  }
});
list.addEventListener("dragover", (e) => {
  if (!dragNode) return;
  e.preventDefault();
  e.stopPropagation();
  const rows = [...list.children].filter((r) => r !== dragNode);
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
list.addEventListener("drop", (e) => {
  if (!dragNode) return;
  e.preventDefault();
  e.stopPropagation();
  const current = items[index];
  const perm = [...list.children].map((li) => items[Number(li.dataset.i)]);
  dragNode = null;
  if (perm.length !== items.length || perm.some((x) => !x)) {
    renderList();
    return;
  }
  items = perm;
  index = Math.max(0, items.indexOf(current));
  render();
  scheduleSave();
});
list.addEventListener("dragend", cancelDrag);
$("close-side").onclick = () => setList(false);
document.addEventListener("keydown", (e) => {
  const k = typeof e.key === "string" ? e.key : "";
  const binding = bindingFromEvent(e);
  if (!clearModal.hidden) {
    if (k.toLowerCase() === "escape") {
      dismissClear();
      if (clearReturnFocus && clearReturnFocus.focus) clearReturnFocus.focus();
      return;
    }
    if (k === "Enter" && !inClearDialog(e.target)) {
      dismissClear();
      if (clearReturnFocus && clearReturnFocus.focus) clearReturnFocus.focus();
    }
    return;
  }
  let action = null;
  for (const entry of SHORTCUTS) {
    const matched = keysOf(entry.id).some((key) => normalise(key) === binding);
    if (matched) {
      action = entry.id;
      break;
    }
  }
  if (action === "settings") {
    if (settings.isOpen()) return settings.close();
    settings.toggle();
    repaintShortcutLabels();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const isEscape = k.toLowerCase() === "escape";
  if (isEscape && settings.isOpen()) return settings.close();
  if (isEscape && !helpModal.hidden) return setHelp(false);
  const typing = e.target.closest?.('input, select, textarea, [contenteditable="true"]');
  if (settings.isOpen() || typing) return;
  if (media.ownsArrowKey(e.target) && k.startsWith("Arrow")) return;
  const inRow = e.target.closest?.("#list li");
  if (inRow && (k === "Enter" || k === " " || k.startsWith("Arrow"))) return;
  if (isEscape && stage.classList.contains("list")) return setList(false);
  if (!action) return;
  if (action === "playPause") {
    const focused = e.target;
    if (focused && focused !== document.body && focused.closest?.("#bar") && typeof focused.blur === "function") {
      focused.blur();
    }
    e.preventDefault();
    e.stopPropagation();
    if (stage.dataset.kind === "image") return step(1);
    return toggle();
  }
  if (action === "seekBack" || action === "seekForward") {
    if (stage.dataset.kind === "image") return;
    media.seekBy(action === "seekBack" ? -SEEK_STEP : SEEK_STEP);
    e.preventDefault();
    return;
  }
  if (action === "volumeUp" || action === "volumeDown") {
    media.setVolume(media.volume + (action === "volumeUp" ? VOL_STEP : -VOL_STEP));
    e.preventDefault();
    return;
  }
  switch (action) {
    case "previous":
      return step(-1);
    case "next":
      return step(1);
    case "mute":
      return media.toggleMute();
    case "loop":
      return toggleLoop();
    case "autoplay":
      return toggleAutoStart();
    case "fitDefault":
      return setFit("contain");
    case "fitCrop":
      return setFit("cover");
    case "fitStretch":
      return setFit("stretch");
    case "fullscreen":
      return media.toggleFullscreen();
    case "controls":
      return setUi(!stage.classList.contains("ui"));
    case "panel":
      return setList(!stage.classList.contains("list"));
    case "open":
      return openFiles();
    case "addFolder":
      return addFolder();
    case "clear":
      clearReturnFocus = document.activeElement;
      return askToClear();
    case "undo":
      return restoreCleared();
    default:
      return;
  }
}, true);
async function restore() {
  const state = await source.loadState();
  loadShortcuts();
  renderShortcutTable();
  settings.load(state);
  if (state?.fit) stage.dataset.fit = state.fit;
  repaintShortcutLabels();
  setFit(stage.dataset.fit);
  setUi(state?.ui !== false);
  setList(!!state?.list);
  if (typeof state?.volume === "number") media.setVolume(state.volume);
  if (typeof state?.loop === "boolean" && state.loop) toggleLoop();
  if (state?.autoplay === false) toggleAutoStart();
  if (state?.muted) media.toggleMute();
  ready = true;
  const pending = queued;
  queued = null;
  if (pending) for (const batch of pending) addItems(batch.items, batch.play);
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
__name(restore, "restore");
settings.wire();
document.addEventListener("mediatools:settings", scheduleSave);
const zeroTime = /* @__PURE__ */ __name(() => fmt(0), "zeroTime");
window.I18n.onChange(() => {
  syncIcons();
  syncToggleTitles();
  paintShortcutLabels();
  if (!items.length || stage.dataset.kind === "image") {
    const cur = $("time-now");
    const dur = $("time-total");
    if (cur) cur.textContent = zeroTime();
    if (dur) dur.textContent = zeroTime();
  }
  render();
});
restore().catch((err) => {
  console.warn("[app] could not restore the saved state:", err);
  ready = true;
  const pending = queued;
  queued = null;
  if (pending) for (const batch of pending) addItems(batch.items, batch.play);
  render();
});
//# sourceMappingURL=app.js.map
