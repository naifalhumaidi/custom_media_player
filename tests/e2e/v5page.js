/* Page script for v5: everything this round added, measured in a real browser.
   Assigns {steps: [[key, value], ...]} to window.__RESULT. */
window.__DONE = (async () => {
  const out = { steps: [] };
  const S = (k, v) => out.steps.push([k, v]);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (id) => document.getElementById(id);
  const stage = $('stage');
  const list = $('list');
  const key = (k) => (document.activeElement || document).dispatchEvent(
    new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

  try {
    /* fetch real files rather than synthesising them, which is both smaller to
       inject and closer to how the app is actually used. This script is itself
       served by the fixture server, so its own origin is where the files are. */
    const MEDIA = new URL(document.currentScript.src).origin;
    const drop = async (manifest) => {
      const d = new DataTransfer();
      for (const [src, name, type] of manifest) {
        const blob = await (await fetch(`${MEDIA}/${src}`)).blob();
        d.items.add(new File([blob], name, { type }));
      }
      stage.dispatchEvent(new DragEvent('drop', { dataTransfer: d, bubbles: true, cancelable: true }));
      await wait(1600);
    };

    /* ---- 1. p opens the panel on an EMPTY playlist ---- */
    S('empty: rows at boot', list.children.length);
    S('empty: panel hidden', stage.classList.contains('list'));
    key('p'); await wait(400);
    S('empty: p opens the panel', stage.classList.contains('list'));
    S('empty: panel display', getComputedStyle($('side')).display);
    S('empty: panel above the start overlay',
      +getComputedStyle($('side')).zIndex > +getComputedStyle($('drop')).zIndex);
    S('empty: empty message shown', $('side-empty').hidden === false);
    S('empty: list hidden', list.hidden === true);
    S('empty: panel is the hit target there',
      !!(document.elementFromPoint(100, 300) || {}).closest &&
      !!document.elementFromPoint(100, 300).closest('#side'));
    S('empty: bar still reachable', !!(document.elementFromPoint(window.innerWidth - 30, window.innerHeight - 30) || {}).closest);
    key('p'); await wait(300);
    S('empty: p closes it again', stage.classList.contains('list') === false);

    /* Every icon button must paint a glyph of a real size. A class-name clash
       once shrank the panel icons to a 4px dot and nothing else noticed.
       The bar starts hidden, so show it for the measurement. */
    stage.classList.add('ui', 'list');
    await wait(300);
    const iconSizes = [...document.querySelectorAll('.btn.ic, media-play-button.btn, media-mute-button.btn, media-seek-button.btn')]
      .filter((b) => b.offsetParent !== null)
      .map((b) => {
        const svg = b.querySelector('svg');
        return (b.id || '?') + ':' + Math.round(svg ? svg.getBoundingClientRect().width : 0);
      });
    S('icons: rendered sizes', iconSizes.join(' '));
    S('icons: none collapsed', iconSizes.filter((s) => +s.split(':')[1] < 12).join(',') || 'none');

    const logoEl = document.querySelector('.logo');
    S('logo: present at boot', !!logoEl && !logoEl.hidden);
    S('logo: loaded at boot', logoEl.complete && logoEl.naturalWidth > 0);
    S('logo: uses the shipped artwork', (logoEl.getAttribute('src') || '') === 'assets/logo-small.png');
    S('time: placeholder localised', document.querySelector('media-time').textContent);

    /* ---- 3. logical button order ---- */
    const order = [...stage.querySelectorAll('.row .btn, .row media-mute-button, .row media-play-button, .row media-seek-button, .row media-volume-slider')]
      .map((e) => e.id || e.className.split(' ')[0]);
    S('bar: order', order.join(' '));

    /* ---- 2. hover uses the same colour family as an enabled control ---- */
    const loop = $('loop');
    loop.classList.add('on'); await wait(80);
    const on = getComputedStyle(loop);
    S('hover: enabled background', on.backgroundColor);
    S('hover: enabled text', on.color);
    loop.classList.remove('on'); await wait(80);
    S('hover: row hover background',
      getComputedStyle(document.documentElement).getPropertyValue('--hover-bg').trim());
    S('hover: enabled token',
      getComputedStyle(document.documentElement).getPropertyValue('--enabled-bg').trim());
    S('hover: tokens differ only in strength',
      getComputedStyle(document.documentElement).getPropertyValue('--hover-fg').trim());

    /* ---- 4. brand colour on the two labels ---- */
    S('brand: panel title colour', getComputedStyle(document.querySelector('.side-title')).color);
    S('brand: filename colour', getComputedStyle($('title')).color);
    S('brand: --gold', getComputedStyle(document.documentElement).getPropertyValue('--gold').trim());

    /* ---- 5. dialogs are centred and sized ---- */
    const box = (sel) => {
      const r = document.querySelector(sel).getBoundingClientRect();
      return 'dx=' + Math.round((r.left + r.right) / 2 - window.innerWidth / 2)
        + ' dy=' + Math.round((r.top + r.bottom) / 2 - window.innerHeight / 2)
        + ' ' + Math.round(r.width) + 'x' + Math.round(r.height)
        + ' inside=' + (r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth);
    };
    $('help').click(); await wait(400);
    S('help: opens', $('help-modal').hidden === false);
    S('help: card', box('.modal-card'));
    $('help-close').click(); await wait(250);

    $('settings').click(); await wait(400);
    S('settings: opens', $('settings-modal').hidden === false);
    S('settings: card', box('#settings-modal .modal-card'));
    S('settings: language select', !!$('set-lang'));
    S('settings: colour input', !!$('set-color'));
    S('settings: logo input', !!$('set-logo'));
    S('settings: reset button', !!$('set-color-reset'));
    S('settings: languages', [...$('set-lang').options].map((o) => o.value).join(','));
    S('settings: colour default', $('set-color').value);

    $('set-color').value = '#3a7bd5';
    $('set-color').dispatchEvent(new Event('input', { bubbles: true }));
    await wait(250);
    /* the setter validates and publishes rgb(), not the raw picker hex */
    S('settings: --gold after pick',
      getComputedStyle(document.documentElement).getPropertyValue('--gold').trim());
    S('settings: picker value', $('set-color').value);
    S('settings: --enabled-bg after pick',
      getComputedStyle(document.documentElement).getPropertyValue('--enabled-bg').trim());
    S('settings: title label colour follows',
      getComputedStyle(document.querySelector('.side-title')).color);
    $('set-color-reset').click(); await wait(250);
    S('settings: reset restores the logo gold',
      getComputedStyle(document.documentElement).getPropertyValue('--gold').trim());

    /* logo: feed the file input a real File, exactly as the picker would */
    const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    const picked = await (await fetch(PIXEL)).blob();
    const dt = new DataTransfer();
    dt.items.add(new File([picked], 'logo.gif', { type: 'image/gif' }));
    $('set-logo').files = dt.files;
    $('set-logo').dispatchEvent(new Event('change', { bubbles: true }));
    await wait(500);
    S('settings: logo preview shown', $('set-logo-preview').hidden === false);
    S('settings: logo applied to the start window', document.querySelector('.logo').src.startsWith('data:image/gif'));
    S('settings: clear is enabled', $('set-logo-clear').disabled === false);
    S('settings: button offers the default back', $('set-logo-clear').textContent);
    $('set-logo-clear').click();
    await wait(300);
    S('settings: clear hides the start logo', document.querySelector('.logo').hidden === true);
    S('settings: button becomes restore', $('set-logo-clear').textContent);
    $('set-logo-clear').click();
    await wait(300);
    S('settings: restore brings the mark back', document.querySelector('.logo').hidden === false);
    S('settings: restored src', document.querySelector('.logo').getAttribute('src'));
    // put the real logo back for the rest of the run
    document.querySelector('.logo').src = 'assets/logo-small.png';
    document.querySelector('.logo').hidden = false;

    /* ---- 7. switch to Arabic ---- */
    $('set-lang').value = 'ar';
    $('set-lang').dispatchEvent(new Event('change', { bubbles: true }));
    await wait(500);
    S('ar: html dir', document.documentElement.dir);
    S('ar: html lang', document.documentElement.lang);
    S('ar: settings title', $('settings-title').textContent);
    S('ar: close tooltip', $('settings-close').title);
    S('ar: loop tooltip', $('loop').title);
    S('ar: fs tooltip', $('fs').title);
    S('ar: play tooltip', $('play').title);
    S('ar: panel title', document.querySelector('.side-title').textContent);
    S('ar: side hint', document.querySelector('.side-hint').textContent);
    S('ar: language label', document.querySelector('label[for="set-lang"]').textContent);
    S('ar: colour label', [...document.querySelectorAll('#settings-modal .field label')].map((l) => l.textContent).join(' | '));
    S('ar: select options', [...$('set-lang').options].map((o) => o.textContent).join('/'));
    S('ar: empty message', $('side-empty').textContent);

    $('settings-close').click(); await wait(250);
    S('ar: settings closed', $('settings-modal').hidden);
    $('help').click(); await wait(400);
    S('ar: help title', $('help-title').textContent);
    S('ar: help table is arabic', document.querySelector('.keys').textContent.includes('ملء الشاشة'));
    S('ar: help groups', [...document.querySelectorAll('.keys th')].map((t) => t.textContent).join('|'));
    $('help-close').click(); await wait(250);

    $('settings').click(); await wait(300);
    $('set-lang').value = 'en';
    $('set-lang').dispatchEvent(new Event('change', { bubbles: true }));
    await wait(400);
    $('settings-close').click(); await wait(250);
    S('en: dir back to ltr', document.documentElement.dir);

    /* ---- runtime strings with media loaded ---- */
    await drop([
      ['clip.mp4', 'a.mp4', 'video/mp4'],
      ['still.png', 'b.png', 'image/png'],
      ['tone.mp3', 'c.mp3', 'audio/mpeg'],
      ['long.mp4', 'd.mp4', 'video/mp4'],
    ]);
    stage.classList.add('ui');
    await wait(600);
    S('en: rows', list.children.length);
    // wait for every duration to be probed, otherwise the total line omits it
    for (let i = 0; i < 30 && list.querySelectorAll('.dur').length < list.children.length; i++) await wait(200);
    await wait(1200);
    S('en: counter', $('counter').textContent);
    S('en: total', $('total').textContent);
    key('l'); await wait(300);
    S('en: loop tooltip when on', $('loop').title);
    key('l'); await wait(200);
    S('en: row remove tooltip', list.querySelector('.x').title);
    S('en: first duration', list.querySelector('.dur').textContent);

    I18n.setLang('ar');
    await wait(600);
    S('ar: counter', $('counter').textContent);
    S('ar: total', $('total').textContent);
    S('ar: row remove tooltip', list.querySelector('.x').title);
    S('ar: duration digits', list.querySelector('.dur').textContent);
    S('ar: title tooltip on fs', $('fs').title);
    S('ar: dir with media', document.documentElement.dir);
    I18n.setLang('en');
    await wait(500);
    S('back: counter is latin again', $('counter').textContent);
    S('back: total is latin again', $('total').textContent);
  } catch (err) {
    out.steps.push(['THREW', err.message + ' @ ' + String(err.stack || '').split('\n')[1]]);
  }
  window.__RESULT = out;
  return out;
})();
