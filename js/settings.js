"use strict";
var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
(() => {
  const { t, apply, getLang, setLang, onChange, DEFAULT_LOGO_GOLD } = window.I18n;
  function parse(value) {
    const text = String(value == null ? "" : value).trim();
    const rgb2 = text.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
    if (rgb2) {
      return {
        r: Math.round(Number(rgb2[1])),
        g: Math.round(Number(rgb2[2])),
        b: Math.round(Number(rgb2[3]))
      };
    }
    let h = text.replace("#", "");
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    if (!/^[0-9a-f]{6}$/i.test(h)) return null;
    const n = parseInt(h, 16);
    return { r: n >> 16 & 255, g: n >> 8 & 255, b: n & 255 };
  }
  __name(parse, "parse");
  const rgb = /* @__PURE__ */ __name((p) => "rgb(" + p.r + ", " + p.g + ", " + p.b + ")", "rgb");
  const toHex = /* @__PURE__ */ __name((value) => {
    const p = parse(value);
    if (p) return "#" + [p.r, p.g, p.b].map((c) => c.toString(16).padStart(2, "0")).join("");
    return DEFAULT_LOGO_GOLD;
  }, "toHex");
  const rgba = /* @__PURE__ */ __name((p, a) => "rgba(" + p.r + ", " + p.g + ", " + p.b + ", " + a + ")", "rgba");
  const toward = /* @__PURE__ */ __name((p, target, amount) => {
    const ch = /* @__PURE__ */ __name((x, y) => Math.round(x + (y - x) * amount), "ch");
    return { r: ch(p.r, target.r), g: ch(p.g, target.g), b: ch(p.b, target.b) };
  }, "toward");
  const WHITE = { r: 255, g: 255, b: 255 };
  function setBrandColor(hex) {
    const p = parse(hex);
    if (!p) {
      console.warn("[settings] ignoring an unusable brand colour:", hex);
      return false;
    }
    const root = document.documentElement;
    root.style.setProperty("--gold", rgb(p));
    root.style.setProperty("--gold-soft", rgba(p, 0.26));
    root.style.setProperty("--gold-strong", rgba(p, 0.42));
    root.style.setProperty("--gold-text", rgb(toward(p, WHITE, 0.55)));
    root.style.setProperty("--gold-dim", rgba(p, 0.5));
    root.style.setProperty("--enabled-bg", rgba(p, 0.26));
    root.style.setProperty("--enabled-fg", rgb(toward(p, WHITE, 0.55)));
    root.style.setProperty("--hover-bg", rgba(p, 0.2));
    root.style.setProperty("--hover-fg", rgb(toward(p, WHITE, 0.45)));
    return true;
  }
  __name(setBrandColor, "setBrandColor");
  const DEFAULT_MARK = "assets/logo-small.png";
  let defaultLogo = DEFAULT_MARK;
  function setLogo(url) {
    const img = document.querySelector(".logo");
    if (!img) return;
    const src = url === void 0 ? defaultLogo : url;
    if (src) {
      img.src = src;
      img.hidden = false;
    } else {
      img.removeAttribute("src");
      img.hidden = true;
    }
  }
  __name(setLogo, "setLogo");
  const modal = /* @__PURE__ */ __name(() => {
    const found = document.getElementById("settings-modal");
    if (!found) throw new Error("settings: #settings-modal is not in the page");
    return found;
  }, "modal");
  function open() {
    syncInputs();
    modal().hidden = false;
    const first = modal().querySelector("select, input, button");
    if (first && typeof first.focus === "function") first.focus();
  }
  __name(open, "open");
  function close() {
    modal().hidden = true;
    const btn = document.getElementById("settings");
    if (btn && typeof btn.focus === "function") btn.focus();
  }
  __name(close, "close");
  const isOpen = /* @__PURE__ */ __name(() => !modal().hidden, "isOpen");
  function notifySave() {
    document.dispatchEvent(new CustomEvent("mediatools:settings", { detail: { ...prefs } }));
  }
  __name(notifySave, "notifySave");
  function toggle() {
    if (isOpen()) close();
    else open();
  }
  __name(toggle, "toggle");
  const prefs = {
    lang: null,
    color: null,
    logo: void 0
    // undefined = the markup default; null = removed
  };
  function applyAll() {
    if (prefs.lang) setLang(prefs.lang);
    if (prefs.color) setBrandColor(prefs.color);
    setLogo(prefs.logo);
    apply();
  }
  __name(applyAll, "applyAll");
  function load(state) {
    const s = state && state.settings || {};
    const asText = /* @__PURE__ */ __name((value) => typeof value === "string" ? value : null, "asText");
    const asLogo = /* @__PURE__ */ __name((value) => value === null || typeof value === "string" ? value : void 0, "asLogo");
    prefs.lang = asText(s.lang);
    prefs.color = asText(s.color);
    prefs.logo = Object.prototype.hasOwnProperty.call(s, "logo") ? asLogo(s.logo) : void 0;
    if (!prefs.lang) prefs.lang = window.I18n.detect();
    applyAll();
  }
  __name(load, "load");
  const save = /* @__PURE__ */ __name(() => prefs, "save");
  function syncInputs() {
    const langSel = document.getElementById("set-lang");
    const color = document.getElementById("set-color");
    const reset = document.getElementById("set-color-reset");
    const logo = document.getElementById("set-logo");
    const logoClear = document.getElementById("set-logo-clear");
    const preview = document.getElementById("set-logo-preview");
    if (langSel) langSel.value = getLang();
    if (color) {
      color.value = toHex(getComputedStyle(document.documentElement).getPropertyValue("--gold").trim());
    }
    if (reset) reset.textContent = t("settings.colorReset");
    if (logoClear) {
      logoClear.textContent = t("settings.logoClear");
      logoClear.disabled = prefs.logo === void 0;
    }
    if (preview) {
      const src = currentMark();
      if (src) {
        preview.src = src;
        preview.hidden = false;
      } else {
        preview.removeAttribute("src");
        preview.hidden = true;
      }
    }
    if (logo) logo.value = "";
  }
  __name(syncInputs, "syncInputs");
  function dominantOf(canvas) {
    const w = 24;
    const h = Math.max(1, Math.round(canvas.height / canvas.width * w));
    const small = document.createElement("canvas");
    small.width = w;
    small.height = h;
    const sctx = small.getContext("2d");
    if (!sctx) return null;
    sctx.drawImage(canvas, 0, 0, w, h);
    let data;
    try {
      data = sctx.getImageData(0, 0, w, h).data;
    } catch {
      return null;
    }
    const buckets = /* @__PURE__ */ new Map();
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (a < 128) continue;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const light = (max + min) / 2;
      if (light < 24 || light > 236 || max - min < 18) continue;
      const key = `${r >> 4},${g >> 4},${b >> 4}`;
      const bucket2 = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
      bucket2.n += 1;
      bucket2.r += r;
      bucket2.g += g;
      bucket2.b += b;
      buckets.set(key, bucket2);
    }
    if (!buckets.size) return null;
    let best = "";
    let bestScore = -1;
    for (const [key, bucket2] of buckets) {
      const r = bucket2.r / bucket2.n;
      const g = bucket2.g / bucket2.n;
      const b = bucket2.b / bucket2.n;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const sat = max - min;
      const light = (max + min) / 2;
      const score = sat * (light > 200 ? 0.2 : 1);
      if (score > bestScore) {
        bestScore = score;
        best = key;
      }
    }
    const bucket = buckets.get(best);
    if (!bucket) return null;
    const hex = /* @__PURE__ */ __name((v) => Math.round(v / bucket.n).toString(16).padStart(2, "0"), "hex");
    return `#${hex(bucket.r)}${hex(bucket.g)}${hex(bucket.b)}`;
  }
  __name(dominantOf, "dominantOf");
  function colourFromImage(src) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = 64;
          canvas.height = Math.max(1, Math.round(img.naturalHeight / img.naturalWidth * 64));
          const ctx = canvas.getContext("2d");
          if (!ctx || !img.naturalWidth) return resolve(null);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(dominantOf(canvas));
        } catch {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      setTimeout(() => resolve(null), 2e3);
      img.src = src;
    });
  }
  __name(colourFromImage, "colourFromImage");
  async function useLogoColour(apply2) {
    const src = currentMark();
    if (!src) return null;
    const found = await colourFromImage(src);
    if (!found) return null;
    if (apply2) {
      prefs.color = found;
      setBrandColor(found);
      syncInputs();
      notifySave();
    }
    return found;
  }
  __name(useLogoColour, "useLogoColour");
  const currentMark = /* @__PURE__ */ __name(() => prefs.logo === void 0 ? defaultLogo : prefs.logo, "currentMark");
  async function shrinkImage(file) {
    try {
      const url = URL.createObjectURL(file);
      try {
        const img = new Image();
        img.src = url;
        await (img.decode ? img.decode() : new Promise((r, j) => {
          img.onload = r;
          img.onerror = j;
        }));
        const max = 1200;
        if (!img.naturalWidth) return null;
        const scale = Math.min(1, max / img.naturalWidth);
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const out = canvas.toDataURL("image/jpeg", 0.85);
        return out.length > 6e5 ? null : out;
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      console.warn("[settings] could not read the chosen logo:", err);
      return null;
    }
  }
  __name(shrinkImage, "shrinkImage");
  function showSaveError(message) {
    const box = document.getElementById("set-save-error");
    if (!box) return;
    box.textContent = message;
    box.hidden = false;
  }
  __name(showSaveError, "showSaveError");
  function clearSaveError() {
    const box = document.getElementById("set-save-error");
    if (box) box.hidden = true;
  }
  __name(clearSaveError, "clearSaveError");
  document.addEventListener("mediatools:save-error", (e) => {
    showSaveError(t("settings.saveFailed"));
    console.warn("[settings] the settings could not be persisted:", e.detail);
  });
  document.addEventListener("mediatools:saved", clearSaveError);
  function wire() {
    const langSel = document.getElementById("set-lang");
    const color = document.getElementById("set-color");
    const reset = document.getElementById("set-color-reset");
    const logo = document.getElementById("set-logo");
    const logoClear = document.getElementById("set-logo-clear");
    const closeBtn = document.getElementById("settings-close");
    const missing = [
      ["set-lang", langSel],
      ["set-color", color],
      ["set-color-reset", reset],
      ["set-logo", logo],
      ["set-logo-clear", logoClear],
      ["settings-close", closeBtn]
    ].filter(([, el]) => !el).map(([id]) => id);
    if (missing.length) {
      throw new Error("custom-media-player: settings markup not parsed yet, missing: " + missing.join(", "));
    }
    const langInput = langSel;
    const colorInput = color;
    const resetBtn = reset;
    const logoInput = logo;
    const logoClearBtn = logoClear;
    const closeButton = closeBtn;
    langInput.addEventListener("change", () => {
      prefs.lang = langInput.value;
      setLang(prefs.lang);
      syncInputs();
      notifySave();
    });
    colorInput.addEventListener("input", () => {
      prefs.color = colorInput.value;
      setBrandColor(prefs.color);
      notifySave();
    });
    resetBtn.addEventListener("click", () => {
      useLogoColour(true).then((found) => {
        if (found) return;
        prefs.color = null;
        setBrandColor(DEFAULT_LOGO_GOLD);
        syncInputs();
        notifySave();
      });
    });
    logoInput.addEventListener("change", async () => {
      const file = logoInput.files && logoInput.files[0];
      if (!file) return;
      if (file.size > 4e6) {
        const shrunk = await shrinkImage(file);
        if (!shrunk) {
          showSaveError(t("settings.saveFailed"));
          logoInput.value = "";
          return;
        }
        prefs.logo = shrunk;
        setLogo(prefs.logo);
        syncInputs();
        notifySave();
        await useLogoColour(true);
        return;
      }
      const reader = new FileReader();
      reader.onload = async () => {
        prefs.logo = String(reader.result);
        setLogo(prefs.logo);
        syncInputs();
        notifySave();
        await useLogoColour(true);
      };
      reader.readAsDataURL(file);
    });
    logoClearBtn.addEventListener("click", () => {
      prefs.logo = void 0;
      setLogo(prefs.logo);
      syncInputs();
      notifySave();
    });
    closeButton.addEventListener("click", close);
    const m = modal();
    m.addEventListener("pointerdown", (e) => {
      if (e.target === m) close();
    });
    const settingsButton = document.getElementById("settings");
    if (settingsButton) settingsButton.addEventListener("click", toggle);
    onChange(() => {
      apply();
      syncInputs();
    });
    setBrandColor(DEFAULT_LOGO_GOLD);
  }
  __name(wire, "wire");
  const api = {
    load,
    save,
    open,
    close,
    toggle,
    isOpen,
    wire,
    applyAll,
    setBrandColor,
    setLang: /* @__PURE__ */ __name((lang) => {
      prefs.lang = lang;
      setLang(lang);
      applyAll();
    }, "setLang"),
    setLogo: /* @__PURE__ */ __name((url) => {
      prefs.logo = url;
      applyAll();
    }, "setLogo"),
    prefs
  };
  window.MediaSettings = api;
})();
//# sourceMappingURL=settings.js.map
