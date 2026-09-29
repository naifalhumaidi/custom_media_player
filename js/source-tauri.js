/* Desktop file source: real paths, real persistence.

   The same contract as js/source-web.js, satisfied without a DOM. The browser
   source gets a `File` and hands back a blob: URL it must revoke; this one
   gets a path and hands back an asset URL the platform serves. Nothing is
   copied, so there is no disk cost and no library folder to manage - and a
   file that is later moved leaves a visible hole rather than a silent one.

   js/source.js selects this adapter when the shell is present. It registers
   nothing at all in a browser, so index.html can always include it.

   The one place the app has to know this adapter exists is the drop. A
   Tauri's webview does not deliver a DOM DragEvent with files - it delivers
   absolute paths on a tauri:// event - so the adapter subscribes to that
   itself and answers `onExternalDrop`, which app.js uses if it is offered. */

(() => {
  /* Not the desktop shell: register nothing and let the browser adapter win. */
  if (!window.__TAURI_INTERNALS__) return;

  const tauri = window.__TAURI__;
  const core = tauri && tauri.core;
  if (!core || typeof core.invoke !== 'function') {
    console.error('[source-tauri] the Tauri API is not reachable; check withGlobalTauri in tauri.conf.json');
    return;
  }

  const { mimeFor, kindOf, baseName, isPlayable } = window.MediaMime;
  const invoke = core.invoke;

  const PERSISTED = ['index', 'position', 'fit', 'loop', 'volume', 'muted', 'ui', 'list', 'autoplay', 'settings', 'items'];

  function toItem(path) {
    const name = baseName(path);
    const mime = mimeFor(name, '');
    return {
      name,
      mime,
      kind: kindOf(mime),
      path,
      size: 0,
      file: null,
      /* Cleared by `file_exists` when the file turns out to be gone. The row
         stays; the alternative is a playlist that quietly loses tracks. */
      missing: false,
    };
  }

  /* How a path becomes something the webview will load. convertFileSrc is the
     documented route; if it is absent the asset URL is built by hand, because
     a missing function here would mean the app silently plays nothing. */
  function assetUrl(path) {
    if (typeof core.convertFileSrc === 'function') {
      return core.convertFileSrc(path);
    }
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    /* Linux and Windows serve the asset protocol over http on this host name;
       macOS uses a custom scheme. Getting this wrong fails loudly at load
       rather than quietly, so the fallback is worth having. */
    const host = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? null : 'http://asset.localhost/';
    return host ? host + encoded.replace(/^([A-Za-z]):/, '$1:') : 'asset://localhost/' + encoded;
  }

  window.MediaFileSourceTauri = {
    /* The whole point of the desktop build: the playlist is written as paths
       and read back on the next launch. */
    canPersist: () => true,

    async openFiles() {
      const paths = await invoke('pick_files');
      return (paths || []).map(toItem);
    },

    async openFolder() {
      const dir = await invoke('pick_folder');
      if (!dir) return [];
      const paths = await invoke('list_folder', { dir });
      /* Filtered here, with the shared table, so a folder full of documents
         does not produce a run of rows that cannot play. */
      return (paths || []).filter((p) => isPlayable(baseName(p))).map(toItem);
    },

    /* Not implemented on purpose. The desktop shell delivers paths on a
       tauri:// event rather than a DOM DragEvent, so the browser adapter's
       `dropItems(event)` has nothing to read here. See onExternalDrop. */
    dropItems() { return []; },

    urlFor(item) {
      if (!item.path) {
        throw new Error('this item has no path and can no longer be played');
      }
      /* Cached: the player asks repeatedly, and building the URL each time
         would re-encode a long path on every seek. */
      if (!item.url) item.url = assetUrl(item.path);
      return item.url;
    },

    /* Nothing to give back. The asset protocol is the platform's, and the file
       on disk is the user's. */
    release(item) {
      if (item) item.url = null;
    },

    async fileExists(item) {
      if (!item || !item.path) return false;
      try {
        return await invoke('file_exists', { path: item.path });
      } catch {
        /* Not knowing is not the same as knowing it is gone, and a false "gone"
           would hide a file the user still has. */
        return true;
      }
    },

    async loadState() {
      try {
        return await invoke('load_state');
      } catch (err) {
        console.warn('[tauri] could not read the saved state:', err);
        return null;
      }
    },

    async saveState(state) {
      const prefs = {};
      for (const key of PERSISTED) prefs[key] = state[key];
      try {
        await invoke('save_state', { state: prefs });
        document.dispatchEvent(new CustomEvent('mediatools:saved'));
      } catch (err) {
        /* Reported rather than swallowed: a failed write loses the playlist
           and every preference with no visible sign. */
        console.warn('[tauri] could not write the saved state:', err);
        document.dispatchEvent(new CustomEvent('mediatools:save-error', { detail: err }));
      }
    },

    /* Dropped files, as absolute paths. The app subscribes with this instead
       of listening for a DOM drop, because there is no DataTransfer here. */
    onExternalDrop(callback) {
      if (!tauri.event || typeof tauri.event.listen !== 'function') return () => {};
      let pending = [];
      /* A real variable, not a property of `pending`. Storing the timer on the
         array loses it on the next concat, so the debounce never had anything
         to clear and a fifty-file drop arrived as fifty separate additions. */
      let timer = 0;
      let stopped = false;

      const off = tauri.event.listen('tauri://drag-drop', (event) => {
        const payload = (event && event.payload) || {};
        if (payload.type !== 'drop' || !payload.paths || !payload.paths.length) return;
        pending = pending.concat(payload.paths.map(toItem));
        clearTimeout(timer);
        timer = setTimeout(() => {
          const batch = pending;
          pending = [];
          timer = 0;
          if (!stopped) callback(batch);
        }, 0);
      });

      return () => {
        stopped = true;
        clearTimeout(timer);
        if (typeof off === 'function') off();
      };
    },
  };
})();
