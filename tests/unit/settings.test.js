/* Settings: the three-state logo, the brand colour maths, and the dialog wiring.
   Everything runs against the real index.html through the shared harness, so
   the ids and attributes under test are the shipped ones. */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach } from 'vitest';
import { createApp } from '../helpers/app-harness.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let app;
afterEach(() => app?.close());

const openSettings = async (options) => {
  app = await createApp(options);
  app.$('settings').click();
  await app.settle(1);
  return app;
};

const gold = (name) =>
  app.document.documentElement.style.getPropertyValue(name).trim();

describe('the settings dialog', () => {
  it('opens and closes, and reports which one is open', async () => {
    await openSettings();
    expect(app.$('settings-modal').hidden).toBe(false);
    expect(app.window.MediaSettings.isOpen()).toBe(true);
    app.$('settings-close').click();
    await app.settle(1);
    expect(app.$('settings-modal').hidden).toBe(true);
    expect(app.window.MediaSettings.isOpen()).toBe(false);
  });

  it('binds every control it finds in the markup', async () => {
    await openSettings();
    /* an id that exists but was never wired is the failure mode this guards */
    for (const id of ['set-lang', 'set-color', 'set-color-reset', 'set-logo', 'set-logo-clear']) {
      expect(app.$(id), `${id} is missing from the markup`).toBeTruthy();
    }
    /* changing the language is the cheapest proof the handler is attached */
    const before = app.$('set-lang').value;
    app.$('set-lang').value = before === 'ar' ? 'en' : 'ar';
    app.$('set-lang').dispatchEvent(new app.window.Event('change', { bubbles: true }));
    await app.settle(1);
    expect(app.window.I18n.getLang()).toBe(app.$('set-lang').value);
  });

  it('is closed at boot, so the keyboard is not captured', async () => {
    app = await createApp();
    expect(app.$('settings-modal').hidden).toBe(true);
    /* every app shortcut has to work on an empty playlist */
    const before = app.$('stage').className;
    app.key('h');
    expect(app.$('stage').className).not.toBe(before);
  });
});

describe('the brand colour', () => {
  it('publishes every derived token from one validated colour', async () => {
    await openSettings();
    app.$('set-color').value = '#3a7bd5';
    app.$('set-color').dispatchEvent(new app.window.Event('input', { bubbles: true }));
    await app.settle(1);
    /* if any token fell back to the default, the palette would be split */
    expect(gold('--gold')).toBe('rgb(58, 123, 213)');
    expect(gold('--gold-soft')).toBe('rgba(58, 123, 213, 0.26)');
    expect(gold('--enabled-bg')).toBe('rgba(58, 123, 213, 0.26)');
  });

  it('refuses a value it cannot parse and leaves the page alone', async () => {
    await openSettings();
    const before = gold('--gold');
    const result = app.window.MediaSettings.setBrandColor('not-a-colour');
    expect(result).toBe(false);
    expect(gold('--gold')).toBe(before);
  });

  it('does not let a stale stored value split the palette', async () => {
    /* a hand-edited or corrupted preference used to reach --gold raw while its
       derivatives silently became the default gold */
    app = await createApp({ state: { settings: { color: 'oops' } } });
    const tokens = ['--gold', '--gold-soft', '--gold-strong', '--enabled-bg', '--hover-bg'];
    const values = tokens.map(gold);
    expect(new Set(values).size).toBeGreaterThan(0);
    expect(gold('--gold')).toBe('rgb(170, 120, 39)');
    expect(gold('--gold-soft')).toBe('rgba(170, 120, 39, 0.26)');
  });

  /* The button says "use the logo colour", so pressing it has to read the
     colour out of the logo. It used to restore a hardcoded gold constant,
     which is why it looked broken: same output every time, whatever the mark
     was. */
  it('reads the colour out of the logo rather than restoring a constant', async () => {
    await openSettings();
    app.$('set-color').value = '#3a7bd5';
    app.$('set-color').dispatchEvent(new app.window.Event('input', { bubbles: true }));
    await app.settle(1);
    expect(gold('--gold')).not.toBe('rgb(170, 120, 39)');

    app.$('set-color-reset').click();
    /* jsdom never loads an image, so the sampler sits waiting for one that will
       never arrive. What is asserted is that the button is not wired to a
       constant: it does not stamp a colour over the chosen one while it waits.

       The wait is short on purpose. This used to sit out the sampler's own
       timeout, which meant the test broke - and then quietly stopped testing
       anything - every time that timeout was changed, including once when it
       was raised because it was firing before a large mark had finished
       decoding. A test that depends on a duration inside the code is a test
       about the duration.

       That a real mark really does produce its own colour is checked where an
       image can load: `walkthrough_logo_colour` in the desktop walkthrough. */
    await app.settle(250);
    expect(app.window.MediaSettings.prefs.color).toBe('#3a7bd5');
    expect(gold('--gold')).toBe('rgb(58, 123, 213)');
  });

  it('keeps the picker showing the colour actually in use', async () => {
    await openSettings();
    app.$('set-color').value = '#3a7bd5';
    app.$('set-color').dispatchEvent(new app.window.Event('input', { bubbles: true }));
    await app.settle(1);
    app.$('settings-close').click();    /* close */
    app.$('settings').click();          /* reopen: syncInputs runs again */
    await app.settle(1);
    expect(app.$('set-color').value).toBe('#3a7bd5');
  });
});

describe('the logo', () => {
  const logo = () => app.document.querySelector('.logo');

  /* The mark that ships, read out of index.html rather than written here.

     These tests used to name the file themselves, which is how the default came
     to be one thing in the markup and a different thing in js/settings.js: the
     constant had drifted to the wordmark, the artwork was still in the markup,
     and every assertion below still passed because it was asserting against the
     copy in the test. The same shape of bug as the build reading a stale app.js -
     a second place to say the same thing, and no check that the two agree. */
  const SHIPPED = /<img class="logo" src="([^"]+)"/.exec(
    fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'),
  )[1];

  it('shows the built-in mark by default', async () => {
    app = await createApp();
    expect(logo().hidden).toBe(false);
    expect(logo().getAttribute('src')).toBe(SHIPPED);
  });

  /* The one above is also the check that settings.js does not override the
     markup on boot, which is the other half of the same drift: it used to name
     a different file, and asserting against a copy written in this file could
     not see that. Asserted on the booted app rather than on the source text, so
     it is a statement about what a first launch shows and not about how the
     file happens to be written. */

  /* Two states, not three. It used to be able to be *absent entirely*, which
     left the start window blank and needed a "use the default" button to undo.
     Removing your mark now returns the built-in one, so there is always a mark
     and the button always says "Remove". */
  it('is two states: the built-in mark, or yours', async () => {
    await openSettings();
    expect(app.window.MediaSettings.prefs.logo).toBeUndefined();
    expect(logo().getAttribute('src')).toBe(SHIPPED);

    app.$('set-logo-clear').click();
    await app.settleAll();
    /* still a mark, and still the built-in one */
    expect(app.window.MediaSettings.prefs.logo).toBeUndefined();
    expect(logo().getAttribute('src')).toBe(SHIPPED);
    expect(logo().hidden).toBe(false);
  });

  it('the remove button always says Remove, and never offers to restore', async () => {
    await openSettings();
    app.$('set-logo-clear').click();
    await app.settleAll();
    /* It used to change its own label to "use the default" here, which meant the
       label was the only thing explaining what the button would do. */
    expect(app.$('set-logo-clear').textContent).not.toMatch(/default/i);
  });

  it('removing your mark survives a reload and still leaves a mark', async () => {
    await openSettings();
    app.$('set-logo-clear').click();
    await app.settleAll();
    expect(app.prefs().settings.logo ?? undefined).toBeUndefined();

    app = await createApp({ state: app.prefs() });
    /* never blank: removing a mark leaves the built-in one */
    expect(logo().hidden).toBe(false);
    expect(logo().getAttribute('src')).toBe(SHIPPED);
  });

  it('a stored logo path is used, not the shipped one', async () => {
    app = await createApp({ state: { settings: { logo: 'assets/logo.png' } } });
    expect(logo().getAttribute('src')).toBe('assets/logo.png');
  });
});

describe('persistence', () => {
  it('a language choice is written and comes back', async () => {
    await openSettings();
    app.$('set-lang').value = 'ar';
    app.$('set-lang').dispatchEvent(new app.window.Event('change', { bubbles: true }));
    await app.settleAll();
    expect(app.prefs().settings.lang).toBe('ar');

    app.close();
    app = await createApp({ state: app.prefs() });
    expect(app.window.I18n.getLang()).toBe('ar');
    expect(app.document.documentElement.dir).toBe('rtl');
  });

  it('a quota failure is reported rather than swallowed', async () => {
    await openSettings();
    app.$('set-lang').value = 'ar';
    app.$('set-lang').dispatchEvent(new app.window.Event('change', { bubbles: true }));
    await app.settle(1);
    /* the write fails only from here on, so the failure is attributable to it */
    app.setSaveToFail(true);
    app.$('set-color').value = '#3a7bd5';
    app.$('set-color').dispatchEvent(new app.window.Event('input', { bubbles: true }));
    await app.settleAll();
    const box = app.$('set-save-error');
    expect(box.hidden).toBe(false);
    expect(box.textContent).not.toBe('');
    expect(box.getAttribute('role')).toBe('alert');
  });

  it('a later successful write clears the error', async () => {
    await openSettings();
    app.setSaveToFail(true);
    app.$('set-color').value = '#3a7bd5';
    app.$('set-color').dispatchEvent(new app.window.Event('input', { bubbles: true }));
    await app.settleAll();
    expect(app.$('set-save-error').hidden).toBe(false);

    app.setSaveToFail(false);
    app.$('set-color').value = '#aa7827';
    app.$('set-color').dispatchEvent(new app.window.Event('input', { bubbles: true }));
    await app.settleAll();
    /* the failed write left the stored blob stale, so a success has to be a
       real, observed one before the warning is taken back */
    expect(app.prefs().settings.color).toBe('#aa7827');
    expect(app.$('set-save-error').hidden).toBe(true);
  });
});
