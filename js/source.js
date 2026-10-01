"use strict";
(() => {
  const REQUIRED = ["canPersist", "openFiles", "urlFor", "release", "loadState", "saveState"];
  const tauri = window.__TAURI_INTERNALS__ ? window.MediaFileSourceTauri : void 0;
  const electron = window.MediaFileSourceElectron;
  const source = tauri || electron || window.MediaFileSourceWeb;
  if (!source) {
    throw new Error(
      "custom-media-player: no file source loaded (expected window.MediaFileSourceWeb, window.MediaFileSourceTauri or window.MediaFileSourceElectron)"
    );
  }
  const missing = REQUIRED.filter((name) => typeof source[name] !== "function");
  if (missing.length) {
    throw new Error(
      "custom-media-player: the file source is missing " + missing.join(", ") + " — see src/source/index.ts for the contract"
    );
  }
  window.MediaFileSource = source;
})();
//# sourceMappingURL=source.js.map
