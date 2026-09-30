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

  /* How a path becomes something the webview will load.

     Not convertFileSrc, and not the asset protocol. On Linux the webview
     decodes through GStreamer, GStreamer has no URI handler for the asset
     scheme, and the load fails with no error the page can see - the file
     simply never starts. The shell therefore serves local files over loopback
     and hands back that URL. See src-tauri/src/media_server.rs for the whole
     account, including the alternatives that were tried.

     Registration happens when an item enters the playlist rather than when the
     player asks for it. That keeps `urlFor` synchronous, which is the contract
     in js/source.js and what app.js relies on in three places, including one
     where a rejected promise would be an unhandled rejection rather than a
     catchable error. */
  async function withUrls(items) {
    await Promise.all(items.map(async (item) => {
      if (!item || !item.path) return;
      try {
        item.url = await invoke('media_url', { path: item.path });
      } catch (err) {
        /* Left null on purpose. `urlFor` then refuses with a message that says
           the shell could not help, rather than handing back a URL that fails
           later with nothing to explain it. */
        item.url = null;
      }
    }));
    return items;
  }

  window.MediaFileSourceTauri = {
    /* The whole point of the desktop build: the playlist is written as paths
       and read back on the next launch. */
    canPersist: () => true,

    async openFiles() {
      const paths = await invoke('pick_files');
      return withUrls((paths || []).map(toItem));
    },

    async openFolder() {
      const dir = await invoke('pick_folder');
      if (!dir) return [];
      const paths = await invoke('list_folder', { dir });
      /* Filtered here, with the shared table, so a folder full of documents
         does not produce a run of rows that cannot play. */
      return withUrls((paths || []).filter((p) => isPlayable(baseName(p))).map(toItem));
    },

    /* Not implemented on purpose. The desktop shell delivers paths on a
       tauri:// event rather than a DOM DragEvent, so the browser adapter's
       `dropItems(event)` has nothing to read here. See onExternalDrop. */
    dropItems() { return []; },

    urlFor(item) {
      if (!item.path) {
        throw new Error('this item has no path and can no longer be played');
      }
      /* Set when the item entered the playlist. A row restored from disk is
         registered during loadState, because a URL written by a previous
         launch names a port from a previous process. */
      if (!item.url) {
        throw new Error('the shell could not give this file a playable URL');
      }
      return item.url;
    },

    /* Nothing to give back, and nothing to clear. What the browser source
       releases here is a blob: URL it created; this one holds a URL that names
       a path the shell registered, and it stays valid for as long as the row
       is in the playlist. That is what lets a clear-undo bring the row
       straight back without asking the shell for anything again. */
    release() {},

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
        const state = await invoke('load_state');
        /* Re-register every restored row. A URL written by a previous launch
           names a port from a process that no longer exists, so keeping it
           would restore a playlist that looks complete and plays nothing. */
        if (state && Array.isArray(state.items)) await withUrls(state.items);
        return state;
      } catch (err) {
        console.warn('[tauri] could not read the saved state:', err);
        return null;
      }
    },

    async saveState(state) {
      const prefs = {};
      for (const key of PERSISTED) prefs[key] = state[key];
      /* The loopback port and its token are per-process, so a saved URL is
         dead the moment the app closes. Written, it would be restored as a
         row that silently cannot play. */
      if (Array.isArray(prefs.items)) {
        prefs.items = prefs.items.map((item) => {
          if (!item || typeof item !== 'object' || !('url' in item)) return item;
          const { url, ...rest } = item;
          return rest;
        });
      }
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
        timer = setTimeout(async () => {
          const batch = pending;
          pending = [];
          timer = 0;
          if (stopped) return;
          /* Registered before the callback, because the app adds these rows to
             the playlist and starts playing the first one straight away. A row
             that arrives without a URL would be visible and unplayable. */
          await withUrls(batch);
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
