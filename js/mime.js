"use strict";
var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
(() => {
  const EXT_TYPES = {
    mp4: "video/mp4",
    m4v: "video/mp4",
    webm: "video/webm",
    ogv: "video/ogg",
    mov: "video/mp4",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    bmp: "image/bmp",
    svg: "image/svg+xml",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    aac: "audio/aac",
    wav: "audio/wav",
    ogg: "audio/ogg",
    oga: "audio/ogg",
    opus: "audio/ogg",
    flac: "audio/flac",
    aiff: "audio/aiff",
    aif: "audio/aiff"
  };
  const extensionOf = /* @__PURE__ */ __name((name) => String(name || "").split(".").pop()?.toLowerCase() ?? "", "extensionOf");
  function mimeFor(name, osType) {
    const known = EXT_TYPES[extensionOf(name)];
    if (known) return known;
    if (osType) return osType;
    return "application/octet-stream";
  }
  __name(mimeFor, "mimeFor");
  function kindOf(mime) {
    if (!mime) return null;
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("audio/")) return "audio";
    return null;
  }
  __name(kindOf, "kindOf");
  const baseName = /* @__PURE__ */ __name((path) => String(path || "").split(/[\\/]/).pop() || String(path || ""), "baseName");
  const api = {
    EXT_TYPES,
    extensionOf,
    mimeFor,
    kindOf,
    baseName,
    /* Everything the app knows how to play, in one predicate. The folder
       picker uses it to skip what it would refuse anyway. */
    isPlayable: /* @__PURE__ */ __name((name) => kindOf(mimeFor(name, "")) !== null, "isPlayable")
  };
  window.MediaMime = api;
})();
//# sourceMappingURL=mime.js.map
