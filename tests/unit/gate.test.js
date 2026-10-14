/* The password pop-up.
 *
 * These are the ways a gate can look like it works and not hold the app: a
 * wrong word that gets in, Escape that dismisses it, or - the one that was
 * actually broken - a page that is correctly inert and click-blocked but still
 * reacts to a key that lands on `document`. `inert` does not stop that key, so
 * the app itself has to refuse, and that is the second test below.
 *
 * The gate is installed by the app, so every one of these boots the real page
 * from the real index.html with the real scripts and types into the real field. */

import { describe, it, expect, afterEach } from 'vitest';
import { createApp } from '../helpers/app-harness.js';

let app;
afterEach(() => app?.close());

const PASSWORD = '4254251';

/* The gate covers the whole window with a form; the app lives behind it. */
const bootLocked = () => createApp({ gate: false });

const typeInto = (app, value) => {
  const input = app.$('gate-input');
  input.value = value;
  app.$('gate-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
};

describe('the password gate', () => {
  it('is on screen when the app opens, with the app inert behind it', async () => {
    app = await bootLocked();
    const $ = app.$;

    const gate = $('gate');
    expect(gate, 'the gate is in the page').toBeTruthy();
    expect(getComputedStyle(gate).display, 'it is a visible overlay, not a hidden element').not.toBe('none');
    expect($('stage').hasAttribute('inert'), 'the app cannot be reached while it is up').toBe(true);
    expect(app.window.document.querySelectorAll('[inert]').length, 'the whole page, not one panel').toBeGreaterThan(1);
  });

  it('keeps the app locked when the word is wrong, and says so', async () => {
    app = await bootLocked();
    typeInto(app, '1111111');

    expect(app.$('gate'), 'still covering the app').toBeTruthy();
    expect(app.$('gate-error').hidden, 'the error is shown').toBe(false);
    expect(app.$('gate-input').value, 'the field is cleared so it can be retyped').toBe('');
    expect(app.$('stage').hasAttribute('inert'), 'still inert').toBe(true);
  });

  it('lets the app open when the word is right', async () => {
    app = await bootLocked();
    typeInto(app, PASSWORD);
    await app.settleAll();

    expect(app.$('gate'), 'the gate is gone').toBeFalsy();
    expect(app.window.document.querySelectorAll('[inert]').length, 'nothing is left inert').toBe(0);
  });

  it('cannot be dismissed with Escape', async () => {
    app = await bootLocked();
    app.window.document.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

    expect(app.$('gate'), 'Escape is not a way out of a password').toBeTruthy();
  });

  it('refuses app shortcuts while it is up, even the one that hides the app', async () => {
    app = await bootLocked();
    app.$('stage').classList.add('list');

    /* F goes through `stage.requestFullscreen()` in a browser build, and jsdom
       has no Fullscreen API - so the call disappears into `?.()` and leaves no
       trace. Recording it turns "F went fullscreen" into something observable,
       and the control at the end proves the recorder works rather than sitting
       there never called. */
    let fullscreenAsks = 0;
    const stage = app.$('stage');
    stage.requestFullscreen = () => { fullscreenAsks++; return Promise.resolve(); };

    app.window.document.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'f', bubbles: true, cancelable: true }));
    await app.settle(2);
    expect(fullscreenAsks, 'F is the key that hides the app; a gate that lets it through is not a gate').toBe(0);
    expect(app.$('gate'), 'and the gate is still there').toBeTruthy();

    /* The control: once the word is right the same key does go through. */
    typeInto(app, PASSWORD);
    await app.settleAll();
    app.window.document.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'f', bubbles: true, cancelable: true }));
    await app.settle(2);
    expect(fullscreenAsks, 'the same key works once the gate is gone').toBe(1);
  });
});
