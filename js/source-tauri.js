"use strict";
var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
(() => {
  if (!window.__TAURI_INTERNALS__) return;
  const tauri = window.__TAURI__;
  const core = tauri && tauri.core;
  if (!core || typeof core.invoke !== "function") {
    console.error("[source-tauri] the Tauri API is not reachable; check withGlobalTauri in tauri.conf.json");
    return;
  }
  const mime = window.MediaMime;
  if (!mime) throw new Error("source-tauri: js/mime.js must load first");
  const { mimeFor, kindOf, baseName, isPlayable } = mime;
  const invoke = core.invoke;
  const call = /* @__PURE__ */ __name(async (cmd, args) => await invoke(cmd, args), "call");
  const PERSISTED = ["index", "position", "fit", "loop", "volume", "muted", "ui", "list", "autoplay", "settings", "items"];
  function toItem(path) {
    const name = baseName(path);
    const mime2 = mimeFor(name, "");
    return {
      name,
      mime: mime2,
      kind: kindOf(mime2),
      path,
      size: 0,
      file: null,
      /* Cleared by `file_exists` when the file turns out to be gone. The row
         stays; the alternative is a playlist that quietly loses tracks. */
      missing: false
    };
  }
  __name(toItem, "toItem");
  async function withUrls(items) {
    await Promise.all(items.map(async (item) => {
      if (!item || !item.path) return;
      try {
        item.url = await call("media_url", { path: item.path });
      } catch (err) {
        item.url = null;
      }
    }));
    return items;
  }
  __name(withUrls, "withUrls");
  let fullscreenActive = false;
  const fullscreenListeners = [];
  const announce = /* @__PURE__ */ __name(() => {
    for (const fn of fullscreenListeners) {
      try {
        fn(fullscreenActive);
      } catch (err) {
        console.warn("[tauri] a fullscreen listener threw:", err);
      }
    }
  }, "announce");
  function watchWindow() {
    const api = tauri && tauri.window;
    if (!api || typeof api.getCurrentWindow !== "function") return;
    api.getCurrentWindow().onResized(() => {
      call("is_fullscreen").then((live) => {
        if (live === fullscreenActive) return;
        fullscreenActive = live;
        announce();
      }).catch(() => {
      });
    }).catch(() => {
    });
  }
  __name(watchWindow, "watchWindow");
  const fullscreenHook = {
    get active() {
      return fullscreenActive;
    },
    async toggle() {
      const next = !fullscreenActive;
      fullscreenActive = next;
      try {
        await call("set_fullscreen", { fullscreen: next });
      } catch (err) {
        fullscreenActive = !next;
        throw err;
      }
      announce();
    },
    onChange(fn) {
      fullscreenListeners.push(fn);
    }
  };
  call("is_fullscreen").then((live) => {
    fullscreenActive = live;
    window.MediaFullscreen = fullscreenHook;
    watchWindow();
  }).catch(() => {
  });
  const source = {
    /* The whole point of the desktop build: the playlist is written as paths
       and read back on the next launch. */
    canPersist: /* @__PURE__ */ __name(() => true, "canPersist"),
    async openFiles() {
      const paths = await call("pick_files");
      return withUrls((paths || []).map(toItem));
    },
    async openFolder() {
      const dir = await call("pick_folder");
      if (!dir) return [];
      const paths = await call("list_folder", { dir });
      return withUrls((paths || []).filter((p) => isPlayable(baseName(p))).map(toItem));
    },
    /* Not implemented on purpose. The desktop shell delivers paths on a
       tauri:// event rather than a DOM DragEvent, so the browser adapter's
       `dropItems(event)` has nothing to read here. See onExternalDrop. */
    dropItems() {
      return [];
    },
    urlFor(item) {
      if (!item.path) {
        throw new Error("this item has no path and can no longer be played");
      }
      if (!item.url) {
        throw new Error("the shell could not give this file a playable URL");
      }
      return item.url;
    },
    /* Nothing to give back, and nothing to clear. What the browser source
       releases here is a blob: URL it created; this one holds a URL that names
       a path the shell registered, and it stays valid for as long as the row
       is in the playlist. That is what lets a clear-undo bring the row
       straight back without asking the shell for anything again. */
    release() {
    },
    async fileExists(item) {
      if (!item || !item.path) return false;
      try {
        return await call("file_exists", { path: item.path });
      } catch {
        return true;
      }
    },
    async loadState() {
      try {
        const state = await call("load_state");
        if (state && Array.isArray(state.items)) await withUrls(state.items);
        return state;
      } catch (err) {
        console.warn("[tauri] could not read the saved state:", err);
        return null;
      }
    },
    async saveState(state) {
      const prefs = {};
      for (const key of PERSISTED) prefs[key] = state[key];
      if (Array.isArray(prefs.items)) {
        const rows = prefs.items;
        prefs.items = rows.map((item) => {
          if (!item || typeof item !== "object" || !("url" in item)) return item;
          const { url, ...rest } = item;
          return rest;
        });
      }
      try {
        await call("save_state", { state: prefs });
        document.dispatchEvent(new CustomEvent("mediatools:saved"));
      } catch (err) {
        console.warn("[tauri] could not write the saved state:", err);
        document.dispatchEvent(new CustomEvent("mediatools:save-error", { detail: err }));
      }
    },
    /* Dropped files, as absolute paths. The app subscribes with this instead
       of listening for a DOM drop, because there is no DataTransfer here. */
    onExternalDrop(callback) {
      if (!tauri.event || typeof tauri.event.listen !== "function") return () => {
      };
      let pending = [];
      let timer;
      let stopped = false;
      let unlisten = null;
      tauri.event.listen("tauri://drag-drop", (event) => {
        const payload = event && event.payload || {};
        if (payload.type !== "drop" || !payload.paths || !payload.paths.length) return;
        pending = pending.concat((payload.paths || []).map(toItem));
        clearTimeout(timer);
        timer = setTimeout(async () => {
          const batch = pending;
          pending = [];
          timer = void 0;
          if (stopped) return;
          await withUrls(batch);
          if (!stopped) callback(batch);
        }, 0);
      }).then((off) => {
        unlisten = off;
      }).catch(() => {
      });
      return () => {
        stopped = true;
        clearTimeout(timer);
        const off = unlisten;
        unlisten = null;
        if (off) off();
      };
    }
  };
  window.MediaFileSourceTauri = source;
})();
//# sourceMappingURL=source-tauri.js.map
