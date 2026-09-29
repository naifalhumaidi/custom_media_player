/* Deciding what a file IS, shared by every file source.

   The browser source gets a `File`; the desktop source gets a path string. The
   decision that matters - which media type, and therefore whether it can play
   at all - is identical for both, and it is the single most consequential
   mapping in the app: get it wrong and a track is added to the playlist that
   can never play.

   Three rules, each learned the hard way:

   - The EXTENSION wins over the type the OS reports. That type is frequently
     empty on Linux, and occasionally wrong: a `.ogg` is usually Vorbis audio,
     not Theora video, and a mis-declared type demotes a real track to the
     wrong player.
   - `mkv` is deliberately absent. Matroska is not WebM and no mainstream
     browser decodes it, so claiming it only produces a broken row.
   - An unknown extension is NOT assumed to be video. It used to default to
     `video/mp4`, which meant dropping a `.txt` or a `.heic` added a row that
     could never play. An unknown type yields `kind: null`, and the app drops it
     and tells the user how many it refused. */

(() => {
  const EXT_TYPES = {
    mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg',
    mov: 'video/mp4',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
    ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac',
    aiff: 'audio/aiff', aif: 'audio/aiff',
  };

  const extensionOf = (name) => String(name || '').split('.').pop().toLowerCase() || '';

  /* @param name    the file name or full path
     @param osType  what the OS claims, which may be '' or wrong */
  function mimeFor(name, osType) {
    const known = EXT_TYPES[extensionOf(name)];
    if (known) return known;
    if (osType) return osType;
    return 'application/octet-stream';
  }

  function kindOf(mime) {
    if (!mime) return null;
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    return null;
  }

  /* The last path segment, for either separator. A desktop source is handed
     whatever the OS produced, and on Windows that is a backslash path. */
  const baseName = (path) => String(path || '').split(/[\\/]/).pop() || String(path || '');

  window.MediaMime = {
    EXT_TYPES,
    extensionOf,
    mimeFor,
    kindOf,
    baseName,
    /* Everything the app knows how to play, in one predicate. The folder
       picker uses it to skip what it would refuse anyway. */
    isPlayable: (name) => kindOf(mimeFor(name, '')) !== null,
  };
})();
