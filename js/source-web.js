"use strict";
var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
(() => {
  const mime = window.MediaMime;
  if (!mime) throw new Error("source-browser: js/mime.js must load first");
  const { mimeFor, kindOf } = mime;
  const PREFS = "mediatools.prefs";
  const PERSISTED = ["index", "position", "fit", "loop", "volume", "muted", "ui", "list", "autoplay", "settings"];
  let picker = null;
  function pickInput() {
    if (picker) return picker;
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = "image/*,video/*,audio/*";
    input.style.display = "none";
    document.body.append(input);
    picker = input;
    return input;
  }
  __name(pickInput, "pickInput");
  function toItem(file) {
    const type = mimeFor(file.name, file.type);
    return {
      name: file.name,
      mime: type,
      kind: kindOf(type),
      path: null,
      size: file.size,
      file,
      missing: false
    };
  }
  __name(toItem, "toItem");
  const source = {
    /* A browser tab has no durable handle on a dropped file: the blob: URL dies
       with the document, and the File itself is not something we may store. So
       the playlist cannot be restored, and saying so is what stops the app
       from rebuilding a list of rows that can never play. */
    canPersist: /* @__PURE__ */ __name(() => false, "canPersist"),
    openFiles() {
      const input = pickInput();
      return new Promise((resolve) => {
        const done = /* @__PURE__ */ __name(() => {
          input.removeEventListener("change", done);
          const files = Array.from(input.files || []);
          input.value = "";
          resolve(files.map(toItem));
        }, "done");
        input.addEventListener("change", done);
        input.click();
      });
    },
    /* The one method that needs a DOM event. It is here, not in the contract,
       so the interface the app depends on stays implementable elsewhere. */
    dropItems(event) {
      return Array.from(event?.dataTransfer?.files || []).map(toItem);
    },
    urlFor(item) {
      if (!item.file && !item.url) {
        throw new Error("this item has been released and can no longer be played");
      }
      if (!item.url) item.url = URL.createObjectURL(item.file);
      return item.url;
    },
    /* Idempotent, and it keeps the File. The File belongs to the app, not to
       the adapter, and clearing it made a released item permanently unusable -
       a trap for the next caller. Only the URL is the adapter's to give back. */
    release(item) {
      if (!item) return;
      if (item.url) {
        URL.revokeObjectURL(item.url);
        item.url = null;
      }
    },
    async loadState() {
      try {
        const raw = localStorage.getItem(PREFS);
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    },
    async saveState(state) {
      const prefs = {};
      for (const key of PERSISTED) prefs[key] = state[key];
      try {
        localStorage.setItem(PREFS, JSON.stringify(prefs));
        document.dispatchEvent(new CustomEvent("mediatools:saved"));
      } catch (err) {
        console.warn("[prefs] could not be saved:", err);
        document.dispatchEvent(new CustomEvent("mediatools:save-error", { detail: err }));
      }
    }
  };
  window.MediaFileSourceWeb = source;
})();
//# sourceMappingURL=source-web.js.map
