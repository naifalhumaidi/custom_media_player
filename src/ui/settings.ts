type Rgb = { r: number; g: number; b: number };

import type { I18nModule, SavedState, SettingsModule } from '../types.js';

/* Settings: language, brand colour and the start-window logo.
   Everything is derived from CSS custom properties, so a colour change is a
   single style write rather than a re-render of every control.

   Persistence rides on the same saveState/loadState blob the rest of the app
   already uses, so the desktop shell gets these for free. */

(() => {
  const { t, apply, getLang, setLang, onChange, DEFAULT_LOGO_GOLD } = window.I18n as I18nModule;

  /* Brand colour, derived once from the logo artwork and overridable by the
     user. Written as CSS custom properties on :root so both stylesheets pick
     it up without duplicating the value.

     Parsed once per change and reused, so every derived token is guaranteed to
     come from the same colour. Returns null for anything unusable, and the
     caller then writes nothing at all - previously an invalid value reached
     `--gold` while its derivatives silently fell back to the default, which
     split the palette in two. */
  /* Accepts #rgb, #rrggbb, and the rgb()/rgba() forms a computed style comes
     back as. Handling all three matters because the value is read back out of
     the style, where it is always functional notation. */
  function parse(value: string | null): Rgb | null {
    const text = String(value == null ? '' : value).trim();
    const rgb = text.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
    if (rgb) {
      return {
        r: Math.round(Number(rgb[1])),
        g: Math.round(Number(rgb[2])),
        b: Math.round(Number(rgb[3])),
      };
    }
    let h = text.replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (!/^[0-9a-f]{6}$/i.test(h)) return null;
    const n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  const rgb = (p: Rgb): string => 'rgb(' + p.r + ', ' + p.g + ', ' + p.b + ')';
  /* the picker only accepts #rrggbb, while the setter publishes rgb() */
  const toHex = (value: string | null): string => {
    const p = parse(value);
    if (p) return '#' + [p.r, p.g, p.b].map((c) => c.toString(16).padStart(2, '0')).join('');
    return DEFAULT_LOGO_GOLD;
  };
  const rgba = (p, a) => 'rgba(' + p.r + ', ' + p.g + ', ' + p.b + ', ' + a + ')';
  const toward = (p, target, amount) => {
    const ch = (x, y) => Math.round(x + (y - x) * amount);
    return { r: ch(p.r, target.r), g: ch(p.g, target.g), b: ch(p.b, target.b) };
  };
  const WHITE = { r: 255, g: 255, b: 255 };

  function setBrandColor(hex: string): boolean {
    const p = parse(hex);
    if (!p) {
      console.warn('[settings] ignoring an unusable brand colour:', hex);
      return false;
    }
    const root = document.documentElement;
    root.style.setProperty('--gold', rgb(p));
    root.style.setProperty('--gold-soft', rgba(p, 0.26));
    root.style.setProperty('--gold-strong', rgba(p, 0.42));
    root.style.setProperty('--gold-text', rgb(toward(p, WHITE, 0.55)));
    root.style.setProperty('--gold-dim', rgba(p, 0.5));
    /* "on" and "hover" are one colour family by design, so a control that is
       on and a control under the pointer read the same */
    root.style.setProperty('--enabled-bg', rgba(p, 0.26));
    root.style.setProperty('--enabled-fg', rgb(toward(p, WHITE, 0.55)));
    root.style.setProperty('--hover-bg', rgba(p, 0.2));
    root.style.setProperty('--hover-fg', rgb(toward(p, WHITE, 0.45)));
    return true;
  }

  /* The logo shipped in the markup is the default. `undefined` means "use it",
     `null` means the user removed it, a string is a chosen file. Collapsing
     those two cases wiped the default logo on every boot. */
  /* The built-in mark. Always shown when there is no logo of the user's, so the
     start window is never blank and there is no "use the default" button to
     explain. */
  const DEFAULT_MARK = 'assets/logo-default.svg';
  let defaultLogo: string | null = DEFAULT_MARK;

  /* Three states, and the distinction is the whole feature: `undefined` means
     never customised, so the shipped mark shows; `null` means the user removed
     it; a string means the one they chose. Collapsing the first into the second
     makes "removed" the default, which is what a `?? null` here did. */
  function setLogo(url: string | null | undefined): void {
    const img = document.querySelector<HTMLImageElement>('.logo');
    if (!img) return;
    const src = url === undefined ? defaultLogo : url;
    if (src) {
      img.src = src;
      img.hidden = false;
    } else {
      img.removeAttribute('src');
      img.hidden = true;
    }
  }




  /* ---------------- dialog ---------------- */

  /* Both are in index.html. Asserted once here rather than null-checked at
     every use: a missing one means the page and this file disagree, which is a
     build that is wrong rather than a state to recover from. */
  const modal = (): HTMLElement => {
    const found = document.getElementById('settings-modal');
    if (!found) throw new Error('settings: #settings-modal is not in the page');
    return found;
  };

  function open(): void {
    syncInputs();
    modal().hidden = false;
    const first = modal().querySelector<HTMLElement>('select, input, button');
    if (first && typeof first.focus === 'function') first.focus();
  }

  function close(): void {
    modal().hidden = true;
    const btn = document.getElementById('settings') as HTMLElement | null;
    if (btn && typeof btn.focus === 'function') btn.focus();
  }

  const isOpen = () => !modal().hidden;

  /* The app owns the (debounced) save, so a settings change announces itself
     rather than reaching into the persistence layer. Without this a choice was
     only ever written if something else happened to save first. */
  function notifySave(): void {
    document.dispatchEvent(new CustomEvent('mediatools:settings', { detail: { ...prefs } }));
  }

  function toggle(): void {
    if (isOpen()) close();
    else open();
  }

  /* ---------------- state ---------------- */

  const prefs: { lang: string | null; color: string | null; logo?: string | null } = {
    lang: null,
    color: null,
    logo: undefined,   // undefined = the markup default; null = removed
  };

  function applyAll(): void {
    if (prefs.lang) setLang(prefs.lang);
    if (prefs.color) setBrandColor(prefs.color);
    setLogo(prefs.logo);
    /* re-render the strings that depend on the language */
    apply();
  }

  function load(state?: SavedState | null): void {
    /* A settings bag from an older build can hold anything, so every field is
       read through a check rather than trusted: a stored value is a file on
       disk that this version did not write. */
    const s = (state && (state.settings as Record<string, unknown>)) || {};
    const asText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
    const asLogo = (value: unknown): string | null | undefined =>
      (value === null || typeof value === 'string' ? value : undefined);
    prefs.lang = asText(s.lang);
    prefs.color = asText(s.color);
    /* an absent key means "never customised", which is different from an
       explicit null (the user pressed Remove) */
    prefs.logo = Object.prototype.hasOwnProperty.call(s, 'logo') ? asLogo(s.logo) : undefined;
    if (!prefs.lang) prefs.lang = (window.I18n as I18nModule).detect();
    applyAll();
  }

  const save = () => prefs;

  function syncInputs() {
    const langSel = document.getElementById('set-lang') as HTMLSelectElement | null;
    const color = document.getElementById('set-color') as HTMLInputElement | null;
    const reset = document.getElementById('set-color-reset');
    const logo = document.getElementById('set-logo') as HTMLInputElement | null;
    const logoClear = document.getElementById('set-logo-clear') as HTMLButtonElement | null;
    const preview = document.getElementById('set-logo-preview') as HTMLImageElement | null;

    if (langSel) langSel.value = getLang();
    if (color) {
      /* the picker needs a #rrggbb value, so fall back to the default gold */
      color.value = toHex(getComputedStyle(document.documentElement).getPropertyValue('--gold').trim());
    }
    if (reset) reset.textContent = t('settings.colorReset');
    /* One job: remove your own mark. It used to double as "put the default
       back", which meant the button changed its own label depending on state -
       and the label was the only thing explaining what pressing it would do. */
    if (logoClear) {
      logoClear.textContent = t('settings.logoClear');
      logoClear.disabled = prefs.logo === undefined;
    }

    if (preview) {
      const src = currentMark();
      if (src) {
        preview.src = src;
        preview.hidden = false;
      } else {
        preview.removeAttribute('src');
        preview.hidden = true;
      }
    }
    if (logo) logo.value = '';
  }

  /* Downscale anything larger than a modest mark, so the stored data URL stays
     well inside the storage quota. */
  /* The dominant colour of an image, as #rrggbb.

     Scored by saturation and by how far from the mid grey it sits, because a
     logo is usually one strong colour on a flat background and picking the
     "average" of it produces mud. Buckets the pixels rather than averaging
     them, so one bright pixel among a dark background wins - which is what the
     eye reads as the colour of a logo.

     Averages the bucket rather than taking a sample from it, so an edge or an
     anti-aliased pixel cannot set the brand colour on its own. */
  function dominantOf(canvas: HTMLCanvasElement): string | null {
    const w = 24;
    const h = Math.max(1, Math.round((canvas.height / canvas.width) * w));
    const small = document.createElement('canvas');
    small.width = w;
    small.height = h;
    const sctx = small.getContext('2d');
    if (!sctx) return null;
    sctx.drawImage(canvas, 0, 0, w, h);

    let data: Uint8ClampedArray;
    try {
      data = sctx.getImageData(0, 0, w, h).data;
    } catch {
      /* A cross-origin image taints the canvas. Nothing to do here: the caller
         falls back rather than guessing. */
      return null;
    }

    const buckets = new Map<string, { n: number; r: number; g: number; b: number }>();
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (a < 128) continue;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const light = (max + min) / 2;
      /* near-black, near-white and near-grey carry no brand information */
      if (light < 24 || light > 236 || max - min < 18) continue;
      const key = `${r >> 4},${g >> 4},${b >> 4}`;
      const bucket = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
      bucket.n += 1;
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
      buckets.set(key, bucket);
    }
    if (!buckets.size) return null;

    let best = '';
    let bestScore = -1;
    for (const [key, bucket] of buckets) {
      const r = bucket.r / bucket.n;
      const g = bucket.g / bucket.n;
      const b = bucket.b / bucket.n;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const sat = max - min;
      const light = (max + min) / 2;
      /* vivid, and not so light it disappears against the dark chrome */
      const score = sat * (light > 200 ? 0.2 : 1);
      if (score > bestScore) {
        bestScore = score;
        best = key;
      }
    }
    const bucket = buckets.get(best);
    if (!bucket) return null;
    const hex = (v: number) => Math.round(v / bucket.n).toString(16).padStart(2, '0');
    return `#${hex(bucket.r)}${hex(bucket.g)}${hex(bucket.b)}`;
  }

  /* Loads an image and returns its dominant colour, or null. */
  function colourFromImage(src: string): Promise<string | null> {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          /* 64px is plenty to find a colour and keeps a huge logo cheap. */
          canvas.width = 64;
          canvas.height = Math.max(1, Math.round((img.naturalHeight / img.naturalWidth) * 64));
          const ctx = canvas.getContext('2d');
          if (!ctx || !img.naturalWidth) return resolve(null);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(dominantOf(canvas));
        } catch {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      /* A ceiling, so this always settles. Without it a mark that cannot load
         leaves the promise pending and the button simply does nothing. */
      setTimeout(() => resolve(null), 2000);
      img.src = src;
    });
  }

  /* The colour button, and picking a new mark, both go through here.

     It used to restore a hardcoded gold, which is why pressing it looked broken:
     the button said "use the logo colour" and produced a constant. */
  async function useLogoColour(apply: boolean): Promise<string | null> {
    const src = currentMark();
    if (!src) return null;
    const found = await colourFromImage(src);
    if (!found) return null;
    if (apply) {
      prefs.color = found;
      setBrandColor(found);
      syncInputs();
      notifySave();
    }
    return found;
  }

  /* Which mark is showing right now: the user's, or the built-in one. */
  const currentMark = (): string | null => (prefs.logo === undefined ? defaultLogo : prefs.logo);

  async function shrinkImage(file) {
    try {
      const url = URL.createObjectURL(file);
      try {
        const img = new Image();
        img.src = url;
        await (img.decode ? img.decode() : new Promise((r, j) => { img.onload = r; img.onerror = j; }));
        const max = 1200;
        if (!img.naturalWidth) return null;
        const scale = Math.min(1, max / img.naturalWidth);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        const ctx = canvas.getContext('2d');
        /* A null context means the browser refused, which happens under memory
           pressure; the shipped logo stays rather than vanishing. */
        if (!ctx) return null;
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const out = canvas.toDataURL('image/jpeg', 0.85);
        return out.length > 600_000 ? null : out;
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      console.warn('[settings] could not read the chosen logo:', err);
      return null;
    }
  }

  /* The persistence layer reports a failed write; without this the user is
     never told their settings are not being kept. */
  function showSaveError(message) {
    const box = document.getElementById('set-save-error');
    if (!box) return;
    box.textContent = message;
    box.hidden = false;
  }
  function clearSaveError() {
    const box = document.getElementById('set-save-error');
    if (box) box.hidden = true;
  }
  document.addEventListener('mediatools:save-error', (e) => {
    showSaveError(t('settings.saveFailed'));
    console.warn('[settings] the settings could not be persisted:', (e as CustomEvent).detail);
  });
  /* A write that got through retires the warning: the user has done something
     about it, and leaving the red box up would misreport the current state. */
  document.addEventListener('mediatools:saved', clearSaveError);

  function wire(): void {
    const langSel = document.getElementById('set-lang') as HTMLSelectElement | null;
    const color = document.getElementById('set-color') as HTMLInputElement | null;
    const reset = document.getElementById('set-color-reset') as HTMLButtonElement | null;
    const logo = document.getElementById('set-logo') as HTMLInputElement | null;
    const logoClear = document.getElementById('set-logo-clear') as HTMLButtonElement | null;
    const closeBtn = document.getElementById('settings-close') as HTMLButtonElement | null;

    /* Deliberately loud: silently skipping a missing control leaves a dead
       button with no explanation, and the usual cause is this module running
       before the dialog markup has been parsed. */
    const missing = [
      ['set-lang', langSel], ['set-color', color], ['set-color-reset', reset],
      ['set-logo', logo], ['set-logo-clear', logoClear], ['settings-close', closeBtn],
    ].filter(([, el]) => !el).map(([id]) => id);
    if (missing.length) {
      throw new Error('custom-media-player: settings markup not parsed yet, missing: ' + missing.join(', '));
    }

    /* Everything above is non-null from here on - the list has just said so -
       but a compiler cannot see through a `filter`, so it is said once here
       rather than with `!` at twenty use sites. */
    const langInput = langSel as HTMLSelectElement;
    const colorInput = color as HTMLInputElement;
    const resetBtn = reset as HTMLButtonElement;
    const logoInput = logo as HTMLInputElement;
    const logoClearBtn = logoClear as HTMLButtonElement;
    const closeButton = closeBtn as HTMLButtonElement;

    langInput.addEventListener('change', () => {
      prefs.lang = langInput.value;
      setLang(prefs.lang);
      syncInputs();
      notifySave();
    });

    colorInput.addEventListener('input', () => {
      prefs.color = colorInput.value;
      setBrandColor(prefs.color);
      notifySave();
    });

    resetBtn.addEventListener('click', () => {
      /* Falls back to the built-in gold only when there is nothing to read a
         colour from, which is not a state the app can normally be in. */
      useLogoColour(true).then((found) => {
        if (found) return;
        prefs.color = null;
        setBrandColor(DEFAULT_LOGO_GOLD);
        syncInputs();
        notifySave();
      });
    });

    logoInput.addEventListener('change', async () => {
      const file = logoInput.files && logoInput.files[0];
      if (!file) return;
      /* The logo is stored as a base64 data URL inside the same blob as the
         language, the colour and the playback position. A big image overruns
         the storage quota, and the whole write then fails silently - the app
         looks configured right up until a reload throws it all away. So the
         image is downscaled to a sane size first. */
      if (file.size > 4_000_000) {
        const shrunk = await shrinkImage(file);
        if (!shrunk) {
          showSaveError(t('settings.saveFailed'));
          logoInput.value = '';
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
        /* A new mark and a brand colour that disagrees with it look like a bug
           in one of the two, so the colour follows the mark without being
           asked. */
        await useLogoColour(true);
      };
      reader.readAsDataURL(file);
    });

    logoClearBtn.addEventListener('click', () => {
      /* Removes your mark and nothing else. It used to toggle between "gone"
         and "shipped", which meant a state where the window had no mark at all
         - and then a button offering to bring back what was already showing. */
      prefs.logo = undefined;
      setLogo(prefs.logo);
      syncInputs();
      notifySave();
    });

    closeButton.addEventListener('click', close);

    const m = modal();
    m.addEventListener('pointerdown', (e) => {
      if (e.target === m) close();
    });

    const settingsButton = document.getElementById('settings');
    if (settingsButton) settingsButton.addEventListener('click', toggle);

    /* a language change must refresh the settings dialog's own labels */
    onChange(() => {
      apply();
      syncInputs();
    });

    /* start from the logo gold until the user picks something else */
    setBrandColor(DEFAULT_LOGO_GOLD);
  }

  const api: SettingsModule = {
    load, save, open, close, toggle, isOpen, wire, applyAll, setBrandColor,
    setLang: (lang: string) => { prefs.lang = lang; setLang(lang); applyAll(); },
    setLogo: (url: string | null) => { prefs.logo = url; applyAll(); },
    prefs,
  };

  window.MediaSettings = api;
})();
