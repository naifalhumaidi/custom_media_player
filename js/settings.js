/* Settings: language, brand colour and the start-window logo.
   Everything is derived from CSS custom properties, so a colour change is a
   single style write rather than a re-render of every control.

   Persistence rides on the same saveState/loadState blob the rest of the app
   already uses, so the desktop shell gets these for free. */

(() => {
  const { t, num, apply, getLang, setLang, onChange, DEFAULT_LOGO_GOLD } = window.I18n;

  /* Brand colour, derived once from the logo artwork and overridable by the
     user. Written as CSS custom properties on :root so both stylesheets pick
     it up without duplicating the value. */
  function setBrandColor(hex) {
    const root = document.documentElement;
    root.style.setProperty('--gold', hex);
    root.style.setProperty('--gold-soft', hexA(hex, 0.26));
    root.style.setProperty('--gold-strong', hexA(hex, 0.42));
    root.style.setProperty('--gold-text', mix(hex, '#ffffff', 0.55));
    root.style.setProperty('--gold-dim', hexA(hex, 0.5));
  }

  /* the colour that reads as "on" for a given brand colour: a translucent
     fill plus a lightened text tone, so it stays legible on dark */
  function setEnabledTokens(hex) {
    const root = document.documentElement;
    root.style.setProperty('--enabled-bg', hexA(hex, 0.26));
    root.style.setProperty('--enabled-fg', mix(hex, '#ffffff', 0.55));
    /* hover is the same tint, slightly stronger, so "hover" and "enabled" are
       the same family of colour as requested */
    root.style.setProperty('--hover-bg', hexA(hex, 0.2));
    root.style.setProperty('--hover-fg', mix(hex, '#ffffff', 0.45));
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

  function hexA(hex, alpha) {
    const { r, g, b } = parse(hex);
    return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + alpha + ')';
  }

  function mix(a, b, amount) {
    const A = parse(a);
    const B = parse(b);
    const ch = (x, y) => Math.round(x + (y - x) * amount);
    return 'rgb(' + ch(A.r, B.r) + ', ' + ch(A.g, B.g) + ', ' + ch(A.b, B.b) + ')';
  }

  function parse(hex) {
    let h = String(hex).trim().replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h, 16);
    if (Number.isNaN(n) || h.length !== 6) return { r: 170, g: 120, b: 39 };
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
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
    if (prefs.color) {
      setBrandColor(prefs.color);
      setEnabledTokens(prefs.color);
    }
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
      const current = getComputedStyle(document.documentElement).getPropertyValue('--gold').trim();
      color.value = /^#[0-9a-f]{6}$/i.test(current) ? current : DEFAULT_LOGO_GOLD;
    }
    if (reset) reset.textContent = t('settings.colorReset');
    if (logoClear) logoClear.textContent = t('settings.logoClear');
    if (logoClear) logoClear.disabled = prefs.logo === undefined || prefs.logo === null;

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
      setEnabledTokens(prefs.color);
      notifySave();
    });

    reset.addEventListener('click', () => {
      prefs.color = null;
      setBrandColor(DEFAULT_LOGO_GOLD);
      setEnabledTokens(DEFAULT_LOGO_GOLD);
      syncInputs();
      notifySave();
    });

    logo.addEventListener('change', () => {
      const file = logo.files && logo.files[0];
      if (!file) return;
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
      prefs.logo = null;
      setLogo(null);
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
    setEnabledTokens(DEFAULT_LOGO_GOLD);
  }

  window.MediaSettings = { load, save, open, close, toggle, isOpen, wire, applyAll, setBrandColor, setEnabledTokens, prefs };
})();
