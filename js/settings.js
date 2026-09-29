/* Settings: language, brand colour and the start-window logo.
   Everything is derived from CSS custom properties, so a colour change is a
   single style write rather than a re-render of every control.

   Persistence rides on the same saveState/loadState blob the rest of the app
   already uses, so the desktop shell gets these for free. */

(() => {
  const { t, num, apply, getLang, setLang, onChange, DEFAULT_LOGO_GOLD } = window.I18n;

  /* Brand colour, derived once from the logo artwork and overridable by the
     user. Written as CSS custom properties on :root so both stylesheets pick
     it up without duplicating the value.

     Parsed once per change and reused, so every derived token is guaranteed to
     come from the same colour. Returns null for anything unusable, and the
     caller then writes nothing at all - previously an invalid value reached
     `--gold` while its derivatives silently fell back to the default, which
     split the palette in two. */
  function parse(hex) {
    let h = String(hex).trim().replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (!/^[0-9a-f]{6}$/i.test(h)) return null;
    const n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  const rgb = (p) => 'rgb(' + p.r + ', ' + p.g + ', ' + p.b + ')';
  /* the picker only accepts #rrggbb, while the setter publishes rgb() */
  const toHex = (value) => {
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

  function setBrandColor(hex) {
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
  let defaultLogo = null;

  function setLogo(url) {
    const img = document.querySelector('.logo');
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

  const modal = () => document.getElementById('settings-modal');

  function open() {
    syncInputs();
    modal().hidden = false;
    const first = modal().querySelector('select, input, button');
    if (first && typeof first.focus === 'function') first.focus();
  }

  function close() {
    modal().hidden = true;
    const btn = document.getElementById('settings');
    if (btn && typeof btn.focus === 'function') btn.focus();
  }

  const isOpen = () => !modal().hidden;

  /* The app owns the (debounced) save, so a settings change announces itself
     rather than reaching into the persistence layer. Without this a choice was
     only ever written if something else happened to save first. */
  function notifySave() {
    document.dispatchEvent(new CustomEvent('mediatools:settings', { detail: { ...prefs } }));
  }

  function toggle() {
    if (isOpen()) close();
    else open();
  }

  /* ---------------- state ---------------- */

  const prefs = {
    lang: null,
    color: null,
    logo: undefined,   // undefined = the markup default; null = removed
  };

  function applyAll() {
    if (prefs.lang) setLang(prefs.lang);
    if (prefs.color) setBrandColor(prefs.color);
    setLogo(prefs.logo);
    /* re-render the strings that depend on the language */
    apply();
  }

  function load(state) {
    const s = (state && state.settings) || {};
    prefs.lang = s.lang || null;
    prefs.color = s.color || null;
    /* an absent key means "never customised", which is different from an
       explicit null (the user pressed Remove) */
    prefs.logo = Object.prototype.hasOwnProperty.call(s, 'logo') ? s.logo : undefined;
    if (!prefs.lang) prefs.lang = window.I18n.detect();
    applyAll();
  }

  const save = () => prefs;

  function syncInputs() {
    const langSel = document.getElementById('set-lang');
    const color = document.getElementById('set-color');
    const reset = document.getElementById('set-color-reset');
    const logo = document.getElementById('set-logo');
    const logoClear = document.getElementById('set-logo-clear');
    const preview = document.getElementById('set-logo-preview');

    if (langSel) langSel.value = getLang();
    if (color) {
      /* the picker needs a #rrggbb value, so fall back to the default gold */
      color.value = toHex(getComputedStyle(document.documentElement).getPropertyValue('--gold').trim());
    }
    if (reset) reset.textContent = t('settings.colorReset');
    /* One button, two jobs: with a logo chosen it removes, without one it puts
       the shipped mark back, so "removed" is never a dead end. */
    if (logoClear) {
      const hasNone = prefs.logo === undefined || prefs.logo === null;
      logoClear.textContent = hasNone ? t('settings.logoUseDefault') : t('settings.logoClear');
      logoClear.disabled = hasNone && !defaultLogo;
    }

    if (preview) {
      const src = prefs.logo === undefined ? defaultLogo : prefs.logo;
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
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
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
    console.warn('[settings] the settings could not be persisted:', e.detail);
  });

  function wire() {
    const shipped = document.querySelector('.logo');
    if (shipped) defaultLogo = shipped.getAttribute('src') || null;

    const langSel = document.getElementById('set-lang');
    const color = document.getElementById('set-color');
    const reset = document.getElementById('set-color-reset');
    const logo = document.getElementById('set-logo');
    const logoClear = document.getElementById('set-logo-clear');
    const closeBtn = document.getElementById('settings-close');

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

    langSel.addEventListener('change', () => {
      prefs.lang = langSel.value;
      setLang(prefs.lang);
      syncInputs();
      notifySave();
    });

    color.addEventListener('input', () => {
      prefs.color = color.value;
      setBrandColor(prefs.color);
      notifySave();
    });

    reset.addEventListener('click', () => {
      prefs.color = null;
      setBrandColor(DEFAULT_LOGO_GOLD);
      syncInputs();
      notifySave();
    });

    logo.addEventListener('change', async () => {
      const file = logo.files && logo.files[0];
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
          logo.value = '';
          return;
        }
        prefs.logo = shrunk;
        setLogo(prefs.logo);
        syncInputs();
        notifySave();
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        prefs.logo = String(reader.result);
        setLogo(prefs.logo);
        syncInputs();
        notifySave();
      };
      reader.readAsDataURL(file);
    });

    logoClear.addEventListener('click', () => {
      const hasNone = prefs.logo === undefined || prefs.logo === null;
      prefs.logo = hasNone ? defaultLogo : null;
      setLogo(prefs.logo);
      syncInputs();
      notifySave();
    });

    closeBtn.addEventListener('click', close);

    const m = modal();
    m.addEventListener('pointerdown', (e) => {
      if (e.target === m) close();
    });

    document.getElementById('settings').addEventListener('click', toggle);

    /* a language change must refresh the settings dialog's own labels */
    onChange(() => {
      apply();
      syncInputs();
    });

    /* start from the logo gold until the user picks something else */
    setBrandColor(DEFAULT_LOGO_GOLD);
  }

  window.MediaSettings = { load, save, open, close, toggle, isOpen, wire, applyAll, setBrandColor, prefs };
})();
