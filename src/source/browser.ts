/* Browser file source: no persistence, object URLs for playback.

   The contract this implements (see src/source/index.ts) is deliberately free of
   the DOM, so that a desktop adapter which receives plain paths over IPC can
   satisfy it without faking anything. Everything DOM-shaped - the file picker
   input, the DragEvent - lives here, in the adapter that actually has a DOM. */

import type { FileSource, MediaItem, SavedState } from '../types.js';

(() => {
  const mime = window.MediaMime;
  if (!mime) throw new Error('source-browser: js/mime.js must load first');
  const { mimeFor, kindOf } = mime;

  const PREFS = 'mediatools.prefs';
  /* What survives a reload. `items` is deliberately absent: the playlist holds
     blob: URLs that cannot outlive the document. Everything else is a plain
     value, and `settings` (language / colour / logo) is a nested object. */
  const PERSISTED = ['index', 'position', 'fit', 'loop', 'volume', 'muted', 'ui', 'list', 'autoplay', 'settings'];

  let picker: HTMLInputElement | null = null;

  function pickInput(): HTMLInputElement {
    if (picker) return picker;
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'image/*,video/*,audio/*';
    input.style.display = 'none';
    document.body.append(input);
    picker = input;
    return input;
  }

  /* The MIME type is not optional: the player picks its provider from it, and
     some browsers report an empty type for local files. */
  function toItem(file: File): MediaItem {
    const type = mimeFor(file.name, file.type);
    return {
      name: file.name,
      mime: type,
      kind: kindOf(type),
      path: null,
      size: file.size,
      file,
      missing: false,
    };
  }

  const source: FileSource = {
    /* A browser tab has no durable handle on a dropped file: the blob: URL dies
       with the document, and the File itself is not something we may store. So
       the playlist cannot be restored, and saying so is what stops the app
       from rebuilding a list of rows that can never play. */
    canPersist: () => false,

    openFiles(): Promise<MediaItem[]> {
      const input = pickInput();
      return new Promise((resolve) => {
        const done = () => {
          input.removeEventListener('change', done);
          const files = Array.from(input.files || []);
          input.value = '';
          resolve(files.map(toItem));
        };
        input.addEventListener('change', done);
        input.click();
      });
    },

    /* The one method that needs a DOM event. It is here, not in the contract,
       so the interface the app depends on stays implementable elsewhere. */
    dropItems(event: DragEvent): MediaItem[] {
      return Array.from(event?.dataTransfer?.files || []).map(toItem);
    },

    urlFor(item: MediaItem): string {
      /* A released item has no File any more. Failing with a clear message
         beats createObjectURL(undefined) throwing from inside the URL API. */
      if (!item.file && !item.url) {
        throw new Error('this item has been released and can no longer be played');
      }
      if (!item.url) item.url = URL.createObjectURL(item.file as File);
      return item.url;
    },

    /* Idempotent, and it keeps the File. The File belongs to the app, not to
       the adapter, and clearing it made a released item permanently unusable -
       a trap for the next caller. Only the URL is the adapter's to give back. */
    release(item: MediaItem): void {
      if (!item) return;
      if (item.url) {
        URL.revokeObjectURL(item.url);
        item.url = null;
      }
    },

    async loadState(): Promise<SavedState | null> {
      try {
        const raw = localStorage.getItem(PREFS);
        return raw ? (JSON.parse(raw) as SavedState) : null;
      } catch {
        return null;
      }
    },

    async saveState(state: Record<string, unknown>): Promise<void> {
      const prefs: Record<string, unknown> = {};
      for (const key of PERSISTED) prefs[key] = state[key];
      try {
        localStorage.setItem(PREFS, JSON.stringify(prefs));
        document.dispatchEvent(new CustomEvent('mediatools:saved'));
      } catch (err) {
        /* A swallowed write here loses the language, the colour, the volume and
           the position with no visible sign, so it is reported upward. */
        console.warn('[prefs] could not be saved:', err);
        document.dispatchEvent(new CustomEvent('mediatools:save-error', { detail: err }));
      }
    },
  };

  window.MediaFileSourceWeb = source;
})();