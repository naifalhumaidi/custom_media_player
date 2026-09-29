/* Browser file source: no persistence, object URLs for playback.
   Classic script on purpose so the app also runs from file:// */

(() => {
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

  const EXT_TYPES = {
    mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', ogg: 'video/ogg',
    mov: 'video/mp4', mkv: 'video/webm', avi: 'video/x-msvideo',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/mp4', wav: 'audio/wav',
    oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', aiff: 'audio/aiff',
  };

  /* The MIME type is not optional: the player picks its provider from it, and
     some browsers report an empty type for local files. */
  function mimeOf(file) {
    if (file.type) return file.type;
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    return EXT_TYPES[ext] || 'video/mp4';
  }

  function kindOf(mime) {
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    return null;
  }

  function toItem(file) {
    const mime = mimeOf(file);
    return {
      name: file.name,
      mime,
      kind: kindOf(mime),
      path: null,
      size: file.size,
      file,
    };
  }

  window.MediaSourceWeb = {
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

    dropItems(event) {
      return Array.from(event?.dataTransfer?.files || []).map(toItem);
    },

    urlFor(item) {
      if (!item.url) item.url = URL.createObjectURL(item.file);
      return item.url;
    },

    release(item) {
      if (item.url) URL.revokeObjectURL(item.url);
      item.url = null;
      item.file = null;
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
      } catch {}
    },
  };
})();
