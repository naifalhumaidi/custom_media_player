/* Electron file source: the same contract as the other two.

   The browser source gets a `File` and hands back a blob: URL it must revoke.
   This one gets a path and hands back a URL the shell serves. Nothing is
   copied, so there is no disk cost and no library folder to manage, and a file
   that is later moved leaves a visible hole rather than a silent one.

   Deliberately the same shape as js/source-tauri.js, so the two desktop shells
   differ only in how they are reached. Every decision that matters - which type
   a file is, whether it can play at all - comes from js/mime.js, so there is
   one answer to that question in the project rather than three.

   One difference from Tauri, and it is forced: Electron delivers a DOM
   DragEvent with real File objects rather than absolute paths on a shell event,
   so `dropItems` is implemented here instead of being an honest `[]`. */

import type { FileSource, FullscreenHook, MediaItem, SavedState } from '../types.js';

(() => {
  /* Not the desktop shell: register nothing and let the browser adapter win. */
  if (!window.MediaShell || window.MediaShell.shell !== 'electron') return;

  const mime = window.MediaMime;
  if (!mime) throw new Error('source-electron: js/mime.js must load first');
  const { mimeFor, kindOf, baseName, isPlayable } = mime;
  const shell = window.MediaShell;

  const PERSISTED = ['index', 'position', 'fit', 'loop', 'volume', 'muted', 'ui', 'list', 'autoplay', 'settings', 'items'] as const;

  function toItem(path: string): MediaItem {
    const name = baseName(path);
    const mime = mimeFor(name, '');
    return {
      name,
      mime,
      kind: kindOf(mime),
      path,
      size: 0,
      file: null,
      /* Cleared by `fileExists` when the file turns out to be gone. The row
         stays; the alternative is a playlist that quietly loses tracks. */
      missing: false,
    };
  }

  /* Registration happens when an item enters the playlist rather than when the
     player asks for it, so `urlFor` stays synchronous - which is the contract in
     js/source.js and what app.js relies on in three places, one of which would
     otherwise turn a rejected promise into an unhandled rejection. */
  async function withUrls(items: MediaItem[]): Promise<MediaItem[]> {
    await Promise.all(items.map(async (item) => {
      if (!item || !item.path) return;
      try {
        item.url = await shell.mediaUrl(item.path);
      } catch (err) {
        /* Left null on purpose: `urlFor` then refuses with a message that says
           the shell could not help, rather than handing back a URL that fails
           later with nothing to explain it.

           The reason is logged, because "the shell could not give this file a
           playable URL" is a symptom and was the only thing on screen. Swallowing
           the cause here cost an afternoon: the walkthrough reported a player
           that would not start, and nothing said the IPC call had thrown. */
        console.warn('[app] no playable URL for', item.path, err);
        item.url = null;
      }
    }));
    return items;
  }

  const source: FileSource = {
    /* The whole point of the desktop build: the playlist is written as paths
       and read back on the next launch. */
    canPersist: () => true,

    async openFiles() {
      const paths = await shell.pickFiles();
      return withUrls((paths || []).map(toItem));
    },

    async openFolder() {
      const dir = await shell.pickFolder();
      if (!dir) return [];
      const paths = await shell.listFolder(dir);
      /* Filtered here, with the shared table, so a folder full of documents does
         not produce a run of rows that cannot play. */
      return withUrls((paths || []).filter((p) => isPlayable(baseName(p))).map(toItem));
    },

    /* Real, unlike the Tauri's. Electron gives a DOM DragEvent carrying File
       objects, and the preload turns each into a path - the only way to get one
       on current Electron, where `File.path` no longer exists.

       A file with no path - a folder, a virtual item - is refused rather than
       added as a row that can never play. */
    /* A drop is the one route into the playlist that did not ask the shell for a
       URL for what it got.

       `openFiles` and `openFolder` both run their results through `withUrls`;
       this one returned the bare items, so a dropped file reached the playlist
       with `url` still null. The row appeared - which is why the bug looked like
       a player that would not start rather than a drop that did not work - and
       `urlFor` then refused it, every time, for as long as the row lived.

       The row survived a restart with the same hole, because the state is saved
       by path and re-resolved through this same function. */
    async dropItems(event) {
      const list = event && event.dataTransfer ? event.dataTransfer.files : null;
      if (!list || !list.length) return [];
      const items: MediaItem[] = [];
      for (const file of Array.from(list)) {
        const path = shell.pathForFile(file);
        if (path) items.push(toItem(path));
      }
      return withUrls(items);
    },

    urlFor(item) {
      if (!item.path) {
        throw new Error('this item has no path and can no longer be played');
      }
      if (!item.url) {
        throw new Error('the shell could not give this file a playable URL');
      }
      return item.url;
    },

    /* Nothing to give back, and nothing to clear. What the browser source
       releases is a blob: URL it created; this holds a URL naming a path the
       shell registered, valid for as long as the row is in the playlist. That is
       what lets a clear-undo bring the row straight back. */
    release() {},

    async fileExists(item) {
      if (!item || !item.path) return false;
      try {
        return await shell.fileExists(item.path);
      } catch {
        /* Not knowing is not the same as knowing it is gone, and a false "gone"
           would hide a file the user still has. */
        return true;
      }
    },

    async loadState() {
      try {
        const state = (await shell.loadState()) as SavedState | null;
        /* Re-register every restored row: a URL written by a previous launch
           names a port from a process that no longer exists. */
        if (state && Array.isArray(state.items)) await withUrls(state.items);
        return state;
      } catch (err) {
        console.warn('[electron] could not read the saved state:', err);
        return null;
      }
    },

    async saveState(state) {
      const prefs: Record<string, unknown> = {};
      for (const key of PERSISTED) prefs[key] = state[key];
      /* The loopback port and its token are per-process, so a saved URL is dead
         the moment the app closes. */
      if (Array.isArray(prefs.items)) {
        prefs.items = prefs.items.map((item) => {
          if (!item || typeof item !== 'object' || !('url' in item)) return item;
          const { url, ...rest } = item;
          return rest;
        });
      }
      try {
        await shell.saveState(prefs);
        document.dispatchEvent(new CustomEvent('mediatools:saved'));
      } catch (err) {
        /* Reported rather than swallowed: a failed write loses the playlist and
           every preference with no visible sign. */
        console.warn('[electron] could not write the saved state:', err);
        document.dispatchEvent(new CustomEvent('mediatools:save-error', { detail: err }));
      }
    },

    /* The desktop shell delivers a DOM drop, so the app's own listener handles
       it and there is nothing to subscribe to here. Returning an unsubscribe
       keeps the adapter interchangeable with the other two. */
    onExternalDrop(): () => void { return () => {}; },
  };

  window.MediaFileSourceElectron = source;

  /* ---- fullscreen, through the window -----------------------------------

     Electron's Chromium does have the HTML Fullscreen API, so this is not the
     necessity it is on WebKitGTK. It goes through the window anyway, for one
     reason: the two desktop shells then behave identically, and one of them has
     no alternative at all. A difference between shells that nobody can act on is
     a difference that costs a bug report. */
  let fullscreenActive = false;
  const listeners: Array<(active: boolean) => void> = [];

  const announce = () => {
    for (const fn of listeners) {
      try {
        fn(fullscreenActive);
      } catch (err) {
        console.warn('[electron] a fullscreen listener threw:', err);
      }
    }
  };

  const fullscreenHook: FullscreenHook = {
    get active() { return fullscreenActive; },
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
    onChange(fn) { listeners.push(fn); },
  };

  window.MediaFullscreen = fullscreenHook;

  shell.isFullscreen()
    .then((live) => { fullscreenActive = Boolean(live); })
    .catch(() => {});

  /* A window can leave fullscreen without the page asking - a window manager
     shortcut, or being dragged to another monitor - so the state follows the
     window rather than only the button. */
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('resize', () => {
      shell.isFullscreen()
        .then((live) => {
          const next = Boolean(live);
          if (next === fullscreenActive) return;
          fullscreenActive = next;
          announce();
        })
        /* Not knowing is not knowing it ended. Guessing would strand the button
           in the wrong state. */
        .catch(() => {});
    });
  }
})();