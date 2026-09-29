/* Picks the active file source, and documents the contract the app relies on.

   The interface, as app.js consumes it:

     canPersist()            -> boolean
         Whether a playlist can be written and read back across launches. The
         browser answers false, which is what stops restore() from rebuilding a
         list of rows it can never play.

     openFiles()             -> Promise<Item[]>
         Show the file picker. Items carry `kind: null` when the file is not
         media, so the app can say how many it refused instead of silently
         dropping them.

     dropItems(dragEvent)    -> Item[] | Promise<Item[]>
         Read a drag-and-drop. This is the ONLY method that needs a DOM event,
         and it lives in the browser adapter. A desktop shell delivers paths
         through a different route, which is why it is not in the contract
         below - see the note at the bottom of this file.

     urlFor(item)            -> string
         A URL the player can load. Called more than once per item, and may be
         called long after the item was added.

     release(item)           -> void
         Give back what urlFor took. Must be idempotent, and must leave the
         item's own data alone so it can still be resolved afterwards.

     loadState() / saveState(state) -> Promise<state> / void
         Preferences. saveState reports a failed write rather than swallowing
         it: a silent failure loses the language, the colour and the position
         with no visible sign.

   To add the desktop shell: register window.MediaFileSourceTauri before this
   file runs. Nothing in app.js needs to change. */

(() => {
  const REQUIRED = ['canPersist', 'openFiles', 'urlFor', 'release', 'loadState', 'saveState'];

  const tauri = window.__TAURI_INTERNALS__ && window.MediaFileSourceTauri;
  const source = tauri || window.MediaFileSourceWeb;

  if (!source) {
    throw new Error('custom-media-player: no file source loaded (expected window.MediaFileSourceWeb)');
  }

  /* Fail here, at load, rather than halfway through a playlist operation: a
     missing method surfaces as a TypeError deep inside an event handler,
     which is far harder to trace back to the adapter. */
  const missing = REQUIRED.filter((name) => typeof source[name] !== 'function');
  if (missing.length) {
    throw new Error(
      'custom-media-player: the file source is missing ' + missing.join(', ') +
      ' — see js/source.js for the contract',
    );
  }

  /* Deliberately NOT window.MediaSource: that is the Media Source Extensions
     constructor, and overwriting it breaks any code that legitimately uses
     MediaSource in a page this app is embedded in. */
  window.MediaFileSource = source;
})();
