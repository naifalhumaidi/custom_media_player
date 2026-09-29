/* Browser file source: no persistence, object URLs for playback.

   The contract this implements (see js/source.js) is deliberately free of the
   DOM, so that a desktop adapter which receives plain paths over IPC can
   satisfy it without faking anything. Everything DOM-shaped - the file picker
   input, the DragEvent - lives here, in the adapter that actually has a DOM. */

(() => {
  const { mimeFor, kindOf } = window.MediaMime;

  const PREFS = 'mediatools.prefs';
  /* What survives a reload. `items` is deliberately absent: the playlist holds
     blob: URLs that cannot outlive the document. Everything else is a plain
     value, and `settings` (language / colour / logo) is a nested object. */
  const PERSISTED = ['index', 'position', 'fit', 'loop', 'volume', 'muted', 'ui', 'list', 'autoplay', 'settings'];

  let picker = null;

  function pickInput() {
    if (picker) return picker;
    picker = document.createElement('input');
    picker.type = 'file';
    picker.multiple = true;
    picker.accept = 'image/*,video/*,audio/*';
    picker.style.display = 'none';
    document.body.append(picker);
    return picker;
  }

  /* The MIME type is not optional: the player picks its provider from it, and
     some browsers report an empty type for local files. */
  function toItem(file) {
    const mime = mimeFor(file.name, file.type);
    return {
      name: file.name,
      mime,
      kind: kindOf(mime),
      path: null,
      size: file.size,
      file,
    };
  }

  window.MediaFileSourceWeb = {
    /* A browser tab has no durable handle on a dropped file: the blob: URL dies
       with the document, and the File itself is not something we may store. So
       the playlist cannot be restored, and saying so is what stops the app
       from rebuilding a list of rows that can never play. */
    canPersist: () => false,

    async openFiles() {
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
    dropItems(event) {
      return Array.from(event?.dataTransfer?.files || []).map(toItem);
    },

    urlFor(item) {
      /* A released item has no File any more. Failing with a clear message
         beats createObjectURL(undefined) throwing from inside the URL API. */
      if (!item.file && !item.url) {
        throw new Error('this item has been released and can no longer be played');
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
        return JSON.parse(localStorage.getItem(PREFS) || 'null');
      } catch {
        return null;
      }
    },

    async saveState(state) {
      const prefs = {};
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
})();
