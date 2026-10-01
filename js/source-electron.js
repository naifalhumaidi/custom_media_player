"use strict";
var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
(() => {
  if (!window.MediaShell || window.MediaShell.shell !== "electron") return;
  const mime = window.MediaMime;
  if (!mime) throw new Error("source-electron: js/mime.js must load first");
  const { mimeFor, kindOf, baseName, isPlayable } = mime;
  const shell = window.MediaShell;
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
      /* Cleared by `fileExists` when the file turns out to be gone. The row
         stays; the alternative is a playlist that quietly loses tracks. */
      missing: false
    };
  }
  __name(toItem, "toItem");
  async function withUrls(items) {
    await Promise.all(items.map(async (item) => {
      if (!item || !item.path) return;
      try {
        item.url = await shell.mediaUrl(item.path);
      } catch {
        item.url = null;
      }
    }));
    return items;
  }
  __name(withUrls, "withUrls");
  const source = {
    /* The whole point of the desktop build: the playlist is written as paths
       and read back on the next launch. */
    canPersist: /* @__PURE__ */ __name(() => true, "canPersist"),
    async openFiles() {
      const paths = await shell.pickFiles();
      return withUrls((paths || []).map(toItem));
    },
    async openFolder() {
      const dir = await shell.pickFolder();
      if (!dir) return [];
      const paths = await shell.listFolder(dir);
      return withUrls((paths || []).filter((p) => isPlayable(baseName(p))).map(toItem));
    },
    /* Real, unlike the Tauri's. Electron gives a DOM DragEvent carrying File
           objects, and the preload turns each into a path - the only way to get one
           on current Electron, where `File.path` no longer exists.
    
           A file with no path - a folder, a virtual item - is refused rather than
           added as a row that can never play. */
    dropItems(event) {
      const list = event && event.dataTransfer ? event.dataTransfer.files : null;
      if (!list || !list.length) return [];
      const items = [];
      for (const file of Array.from(list)) {
        const path = shell.pathForFile(file);
        if (path) items.push(toItem(path));
      }
      return items;
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
       releases is a blob: URL it created; this holds a URL naming a path the
       shell registered, valid for as long as the row is in the playlist. That is
       what lets a clear-undo bring the row straight back. */
    release() {
    },
    async fileExists(item) {
      if (!item || !item.path) return false;
      try {
        return await shell.fileExists(item.path);
      } catch {
        return true;
      }
    },
    async loadState() {
      try {
        const state = await shell.loadState();
        if (state && Array.isArray(state.items)) await withUrls(state.items);
        return state;
      } catch (err) {
        console.warn("[electron] could not read the saved state:", err);
        return null;
      }
    },
    async saveState(state) {
      const prefs = {};
      for (const key of PERSISTED) prefs[key] = state[key];
      if (Array.isArray(prefs.items)) {
        prefs.items = prefs.items.map((item) => {
          if (!item || typeof item !== "object" || !("url" in item)) return item;
          const { url, ...rest } = item;
          return rest;
        });
      }
      try {
        await shell.saveState(prefs);
        document.dispatchEvent(new CustomEvent("mediatools:saved"));
      } catch (err) {
        console.warn("[electron] could not write the saved state:", err);
        document.dispatchEvent(new CustomEvent("mediatools:save-error", { detail: err }));
      }
    },
    /* The desktop shell delivers a DOM drop, so the app's own listener handles
       it and there is nothing to subscribe to here. Returning an unsubscribe
       keeps the adapter interchangeable with the other two. */
    onExternalDrop() {
      return () => {
      };
    }
  };
  window.MediaFileSourceElectron = source;
  let fullscreenActive = false;
  const listeners = [];
  const announce = /* @__PURE__ */ __name(() => {
    for (const fn of listeners) {
      try {
        fn(fullscreenActive);
      } catch (err) {
        console.warn("[electron] a fullscreen listener threw:", err);
      }
    }
  }, "announce");
  const fullscreenHook = {
    get active() {
      return fullscreenActive;
    },
    toggle() {
      const next = !fullscreenActive;
      fullscreenActive = next;
      try {
        shell.setFullscreen(next);
      } catch (err) {
        fullscreenActive = !next;
        throw err;
      }
      announce();
    },
    onChange(fn) {
      listeners.push(fn);
    }
  };
  window.MediaFullscreen = fullscreenHook;
  shell.isFullscreen().then((live) => {
    fullscreenActive = Boolean(live);
  }).catch(() => {
  });
  if (typeof window.addEventListener === "function") {
    window.addEventListener("resize", () => {
      shell.isFullscreen().then((live) => {
        const next = Boolean(live);
        if (next === fullscreenActive) return;
        fullscreenActive = next;
        announce();
      }).catch(() => {
      });
    });
  }
})();
//# sourceMappingURL=source-electron.js.map
