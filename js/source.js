/* Picks the active file source. The desktop shell will register
   window.MediaSourceTauri and load it before this file. */

(() => {
  const tauri = window.__TAURI_INTERNALS__ && window.MediaSourceTauri;
  window.MediaSource = tauri || window.MediaSourceWeb;
  if (!window.MediaSource) throw new Error('media-tools: no file source loaded');
})();
