/* Chooses the file source, and holds every source to the contract.

   The app talks to whichever source is selected here and to nothing else. That
   is what lets one page run as a website and as two desktop applications: app.js
   contains no `if (isTauri)` anywhere, and none of the three sources knows the
   other two exist.

   A desktop adapter registers itself only when its shell is really present -
   js/source-tauri.js checks for the Tauri bridge, js/source-electron.js for the
   preload - so whichever is found first is one that can actually reach a
   filesystem. Falling through to the browser source is what makes the same page
   work everywhere.

   The contract, for adapters:

     canPersist()            -> boolean
         True when a playlist can outlive the session. A browser tab cannot keep
         one, and the app uses this to decide whether restoring a saved list is
         even meaningful.

     openFiles()             -> Promise<Item[]>
         Ask the user for files. One level of "open" - the app decides what to do
         with what comes back.

     openFolder?()           -> Promise<Item[]>
         Optional. Only a source that can name a folder implements it.

     dropItems?(event)       -> Item[]
         Optional. Only a source with a DOM DragEvent implements it.

     urlFor(item)            -> string
         Give back what the player can load. SYNCHRONOUS: app.js uses it in a
         plain assignment as well as inside try/catch, and a promise in the
         first place would be silently wrong rather than visibly broken.
         Must throw, not return nothing, for an item it cannot resolve.

     release(item)           -> void
         Give back what urlFor took. Must be idempotent, and must leave the row
         usable, because a clear-undo puts it straight back.

     loadState()             -> Promise<unknown | null>
         Read what saveState wrote, or null when there is none.

     saveState(state)        -> Promise<void>
         Report a failed write rather than swallowing it: a silent failure loses
         the language, the colour and the position with no visible sign.

   js/source.js checks the required half at load rather than letting a missing
   method surface as a TypeError deep inside an event handler, where it is far
   harder to trace back. Since the port this is a TypeScript interface, and the
   check below catches the rest: a source that is present but does not satisfy
   the shape, which types cannot see across three separately compiled files. */

import type { FileSource } from '../types.js';

(() => {
  const REQUIRED = ['canPersist', 'openFiles', 'urlFor', 'release', 'loadState', 'saveState'] as const;

  const tauri = window.__TAURI_INTERNALS__ ? window.MediaFileSourceTauri : undefined;
  const electron = window.MediaFileSourceElectron;
  const source: FileSource | undefined = tauri || electron || window.MediaFileSourceWeb;

  if (!source) {
    throw new Error(
      'custom-media-player: no file source loaded (expected window.MediaFileSourceWeb, ' +
      'window.MediaFileSourceTauri or window.MediaFileSourceElectron)',
    );
  }

  /* Fail here, at load, rather than halfway through a playlist operation. */
  const missing = REQUIRED.filter((name) => typeof source[name] !== 'function');
  if (missing.length) {
    throw new Error(
      'custom-media-player: the file source is missing ' + missing.join(', ') +
      ' — see src/source/index.ts for the contract',
    );
  }

  /* Deliberately NOT window.MediaSource: that is the Media Source Extensions
     constructor, and overwriting it breaks any code that legitimately uses
     MediaSource in a page this app is embedded in. */
  window.MediaFileSource = source;
})();