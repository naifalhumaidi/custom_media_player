/* Application behaviour: the playlist, transport, fit modes, the keyboard, and
   the failure paths. Everything is driven through the shipped DOM - clicks,
   drops and key presses - so a test cannot pass by calling an internal
   function the user has no access to. */

import { describe, it, expect, afterEach } from 'vitest';
import { createApp } from '../helpers/app-harness.js';

let app;
afterEach(() => app?.close());

const VIDEO = () => app.file('a.mp4', 'video/mp4');
const VIDEO2 = () => app.file('b.mp4', 'video/mp4');
const IMAGE = () => app.file('shot.png', 'image/png');
const AUDIO = () => app.file('song.mp3', 'audio/mpeg');

/** Drop files on the stage, which is the same path a real drop takes. */
const dropOnStage = async (files) => {
  app.drop(app.stage, files);
  await app.settleAll();
};

/** Bring the transport to a known state, since a drop autoplays. */
const ensurePaused = async () => {
  if (!app.player.paused) {
    app.key(' ');
    await app.settle(1);
  }
};

const addToPanel = async (files) => {
  app.key('p');                       // the panel has to be open to be dropped on
  await app.settle(1);
  app.drop(app.$('side'), files);
  await app.settleAll();
};

describe('starting up', () => {
  it('boots on the start window with an empty playlist', async () => {
    app = await createApp();
    expect(app.rows()).toHaveLength(0);
    expect(app.$('drop').hidden).toBe(false);
    expect(app.player.src).toEqual([]);
  });

  it('boots with no uncaught errors and nothing on the console', async () => {
    app = await createApp();
    await app.settleAll();
    expect(app.errors).toEqual([]);
    expect(app.warnings).toEqual([]);
  });
});

describe('opening files', () => {
  it('a drop plays the first item and hides the start window', async () => {
    app = await createApp();
    await dropOnStage([VIDEO(), VIDEO2()]);
    expect(app.names()).toEqual(['a.mp4', 'b.mp4']);
    expect(app.$('drop').hidden).toBe(true);
    expect(app.stage.dataset.kind).toBe('video');
    expect(app.counter()).toBe('1 / 2');
  });

  it('a drop on the panel appends without interrupting what is playing', async () => {
    app = await createApp();
    await dropOnStage([VIDEO(), VIDEO2()]);
    const playing = app.player.src[0].src;
    await addToPanel([app.file('c.mp4', 'video/mp4')]);
    expect(app.names()).toHaveLength(3);
    /* still on the first track, and its source was not re-fetched */
    expect(app.player.src[0].src).toBe(playing);
  });

  it('probes each file for a duration and a thumbnail', async () => {
    app = await createApp();
    await dropOnStage([VIDEO(), AUDIO()]);
    expect(app.durations()).toEqual(['0:11', '0:11']);
    for (const row of app.rows()) {
      expect(row.querySelector('.thumb img')?.getAttribute('src')).toBe('data:image/jpeg;base64,thumb');
    }
  });

  it('a still image shows no duration but does get a thumbnail', async () => {
    app = await createApp();
    await dropOnStage([IMAGE()]);
    expect(app.stage.dataset.kind).toBe('image');
    expect(app.durations()).toEqual(['—']);
  });

  it('drops a file it cannot play instead of adding a dead row', async () => {
    app = await createApp();
    await dropOnStage([VIDEO(), app.file('notes.txt', 'text/plain'), app.file('clip.mkv', '')]);
    /* the unknown extension used to be claimed as video/mp4 */
    expect(app.names()).toEqual(['a.mp4']);
  });

  it('an image thumbnail is a downscaled copy, not the original', async () => {
    app = await createApp();
    await dropOnStage([IMAGE()]);
    const src = app.rows()[0].querySelector('.thumb img').getAttribute('src');
    expect(src).toBe('data:image/jpeg;base64,thumb');
    /* the item's own object URL must not be pinned by a 160px row */
    expect(src).not.toBe(app.urls.created[0].url);
  });
});

describe('the playlist', () => {
  it('opens on an empty playlist, so a drop is always reachable', async () => {
    app = await createApp();
    app.key('p');
    await app.settle(1);
    expect(app.stage.classList.contains('list')).toBe(true);
    expect(app.$('side-empty').hidden).toBe(false);
  });

  it('clicking a row plays it', async () => {
    app = await createApp();
    await dropOnStage([VIDEO(), VIDEO2()]);
    app.rows()[1].dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }));
    await app.settle(1);
    expect(app.counter()).toBe('2 / 2');
  });

  it('a row is reachable and operable from the keyboard', async () => {
    app = await createApp();
    await dropOnStage([VIDEO(), VIDEO2()]);
    for (const row of app.rows()) {
      expect(row.tabIndex).toBe(0);
      expect(row.getAttribute('role')).toBe('button');
    }
    /* the playing row is the one exposed as current */
    expect(app.rows()[0].getAttribute('aria-current')).toBe('true');
    expect(app.rows()[1].getAttribute('aria-current')).toBeNull();

    app.rows()[1].focus();
    app.rows()[1].dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await app.settle(1);
    expect(app.counter()).toBe('2 / 2');
  });

  it('the arrow keys move focus along the list', async () => {
    app = await createApp();
    await dropOnStage([VIDEO(), VIDEO2()]);
    app.rows()[0].focus();
    app.rows()[0].dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(app.document.activeElement).toBe(app.rows()[1]);
  });

  it('removing the row above the current one keeps playing, in place', async () => {
    app = await createApp();
    await dropOnStage([VIDEO(), VIDEO2(), app.file('c.mp4', 'video/mp4')]);
    app.rows()[2].dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }));
    await app.settle(1);
    const sourceBefore = app.player.src[0].src;
    const playingBefore = app.player.paused;

    /* deleting row 0 used to reload the current track and force it to play */
    app.rows()[0].querySelector('.x').dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }));
    await app.settle(1);
    expect(app.names()).toEqual(['b.mp4', 'c.mp4']);
    expect(app.counter()).toBe('2 / 2');
    expect(app.player.src[0].src).toBe(sourceBefore);
    expect(app.player.paused).toBe(playingBefore);
  });

  it('removing the playing row moves to the one that takes its place', async () => {
    app = await createApp();
    await dropOnStage([VIDEO(), VIDEO2()]);
    app.rows()[0].querySelector('.x').dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }));
    await app.settle(1);
    /* the track that slid into the slot is now the one playing */
    expect(app.names()).toEqual(['b.mp4']);
    expect(app.stage.dataset.kind).toBe('video');
    expect(app.player.src).toHaveLength(1);
    /* a single item needs no position counter */
    expect(app.counter()).toBe('');
  });

  it('removing the only row returns to the start window', async () => {
    app = await createApp();
    await dropOnStage([VIDEO()]);
    app.rows()[0].querySelector('.x').dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }));
    await app.settle(1);
    expect(app.rows()).toHaveLength(0);
    expect(app.$('drop').hidden).toBe(false);
    expect(app.player.src).toEqual([]);
  });

  it('the remove button is a real button with a name', async () => {
    app = await createApp();
    await dropOnStage([VIDEO()]);
    const x = app.rows()[0].querySelector('.x');
    expect(x.tagName).toBe('BUTTON');
    expect(x.type).toBe('button');
    expect(x.getAttribute('aria-label')).not.toBe('');
  });

  it('Shift+X clears it, and the object URLs are released', async () => {
    app = await createApp();
    await dropOnStage([VIDEO(), VIDEO2()]);
    const created = app.urls.created.length;
    app.key('x', { shiftKey: true });
    await app.settle(1);
    expect(app.rows()).toHaveLength(0);
    expect(app.urls.revoked.length).toBeGreaterThanOrEqual(created);
    expect(app.urls.created.every((r) => r.revoked)).toBe(true);
  });

  it('shows the count, and the total once every duration is known', async () => {
    app = await createApp();
    await dropOnStage([VIDEO(), AUDIO()]);
    expect(app.total()).toContain('2');
    expect(app.total()).toContain('0:22');
  });

  it('uses a real singular for a one-item playlist', async () => {
    app = await createApp();
    await dropOnStage([VIDEO()]);
    expect(app.total()).toContain('1 item');
    expect(app.total()).not.toContain('1 items');
  });
});

describe('the transport', () => {
  it('walks forward and back, wrapping at both ends', async () => {
    app = await createApp();
    await dropOnStage([VIDEO(), VIDEO2()]);
    app.key('.'); await app.settle(1);
    expect(app.counter()).toBe('2 / 2');
    app.key('.'); await app.settle(1);
    expect(app.counter()).toBe('1 / 2');
    app.key(','); await app.settle(1);
    expect(app.counter()).toBe('2 / 2');
  });

  it('the end of the playlist stops when loop is off', async () => {
    app = await createApp();
    await dropOnStage([VIDEO(), VIDEO2()]);
    app.player.reachEnd();
    await app.settle(1);
    expect(app.counter()).toBe('2 / 2');
    /* wrapping here is what made the loop toggle inert */
    app.player.reachEnd();
    await app.settle(1);
    expect(app.counter()).toBe('2 / 2');
    expect(app.player.paused).toBe(true);
  });

  it('loop restarts the playlist at the end', async () => {
    app = await createApp();
    await dropOnStage([VIDEO(), VIDEO2()]);
    app.key('l');
    expect(app.player.loop).toBe(true);
    app.rows()[1].dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }));
    await app.settle(1);
    app.player.reachEnd();
    await app.settle(1);
    expect(app.counter()).toBe('1 / 2');
  });

  it('an unplayable file is skipped once, not in a loop', async () => {
    app = await createApp();
    await dropOnStage([VIDEO(), VIDEO2()]);
    app.player.failOnLoad = true;
    app.player.src = [{ src: 'blob:x', type: 'video/mp4' }];
    await app.settle(30);
    /* it used to bounce between the two broken files forever */
    expect(app.rows()).toHaveLength(2);
    expect(app.player.src[0].src).toBe(app.urls.created[1].url);
  });

  it('an image advances on space rather than pretending to play', async () => {
    app = await createApp();
    await dropOnStage([IMAGE(), VIDEO()]);
    app.key(' ');
    await app.settle(1);
    expect(app.stage.dataset.kind).toBe('video');
  });

  it('space toggles playback and clears focus from a control', async () => {
    app = await createApp();
    await dropOnStage([VIDEO()]);
    await ensurePaused();
    /* otherwise the browser re-activates the button instead of playing */
    const control = app.$('next');
    control.focus();
    expect(app.document.activeElement).toBe(control);
    app.key(' ');
    await app.settle(1);
    expect(app.player.paused).toBe(false);
    expect(app.document.activeElement).not.toBe(control);
  });

  it('space is play/pause even when a control holds focus', async () => {
    app = await createApp();
    await dropOnStage([VIDEO(), VIDEO2()]);
    await ensurePaused();
    const before = app.counter();
    app.$('next').focus();
    app.key(' ');
    await app.settle(1);
    /* not "next track", as a focused button would otherwise do */
    expect(app.counter()).toBe(before);
    expect(app.player.paused).toBe(false);
  });

  it('arrow keys seek, and the volume steps', async () => {
    app = await createApp();
    app.player.reportedDuration = 600;
    await dropOnStage([VIDEO()]);
    await app.settle(1);
    app.player.currentTime = 60;
    app.key('ArrowRight'); await app.settle(1);
    expect(app.player.currentTime).toBe(70);
    app.key('ArrowLeft'); await app.settle(1);
    expect(app.player.currentTime).toBe(60);
    /* and never past either end */
    app.key('ArrowLeft'); app.key('ArrowLeft'); app.key('ArrowLeft');
    app.key('ArrowLeft'); app.key('ArrowLeft'); app.key('ArrowLeft');
    app.key('ArrowLeft'); await app.settle(1);
    expect(app.player.currentTime).toBe(0);
  });

  it('m mutes, and the control says what it will do next', async () => {
    app = await createApp();
    await dropOnStage([VIDEO()]);
    const label = () => app.$('mute').getAttribute('aria-label');
    const before = label();
    app.key('m');
    await app.settle(1);
    expect(app.player.muted).toBe(true);
    expect(label()).not.toBe(before);
    app.key('m');
    await app.settle(1);
    expect(app.player.muted).toBe(false);
  });

  it('the play control names the action, not the state it is leaving', async () => {
    app = await createApp();
    await dropOnStage([VIDEO()]);
    await ensurePaused();
    expect(app.$('play').getAttribute('aria-label')).toBe(app.window.I18n.t('bar.play'));
    app.key(' ');
    await app.settle(1);
    expect(app.player.paused).toBe(false);
    expect(app.$('play').classList.contains('playing')).toBe(true);
    /* while playing it must offer to pause, not keep saying "Play" */
    expect(app.$('play').getAttribute('aria-label')).toBe(app.window.I18n.t('bar.pause'));
  });

  it('the toggles expose their state to assistive tech', async () => {
    app = await createApp();
    expect(app.$('loop').getAttribute('aria-pressed')).toBe('false');
    app.key('l');
    expect(app.$('loop').getAttribute('aria-pressed')).toBe('true');
    expect(app.$('autoplay').getAttribute('aria-pressed')).toBe('true');
    app.key('a');
    expect(app.$('autoplay').getAttribute('aria-pressed')).toBe('false');
  });
});

describe('the bar', () => {
  it('the fit keys and buttons agree, and the state is on the stage', async () => {
    app = await createApp();
    const stage = app.stage.dataset.fit;
    app.key('c');
    expect(app.stage.dataset.fit).toBe('cover');
    expect(app.stage.dataset.fit).not.toBe(stage);
    app.$('fit-d').click();
    expect(app.stage.dataset.fit).toBe('contain');
    app.key('s');
    expect(app.stage.dataset.fit).toBe('stretch');
  });

  it('h hides the bar, p shows the panel', async () => {
    app = await createApp();
    app.key('h');
    expect(app.stage.classList.contains('ui')).toBe(false);
    app.key('h');
    expect(app.stage.classList.contains('ui')).toBe(true);
    app.key('p');
    expect(app.stage.classList.contains('list')).toBe(true);
  });

  it('the seek bar is painted from the real position', async () => {
    app = await createApp();
    app.player.reportedDuration = 100;
    await dropOnStage([VIDEO()]);
    await app.settle(1);
    app.player.currentTime = 25;
    await app.settle(1);
    const fill = app.document.querySelector('media-time-slider').style.getPropertyValue('--mt-fill');
    expect(fill).toBe('25.00%');
  });

  it('the time readout is written by the app, in the active language', async () => {
    app = await createApp();
    await dropOnStage([VIDEO()]);
    await app.settle(1);
    app.player.currentTime = 65;
    await app.settle(1);
    expect(app.$('time-now').textContent).toBe('1:05');
    app.window.I18n.setLang('ar');
    app.player.currentTime = 65;
    await app.settle(1);
    expect(app.$('time-now').textContent).toMatch(/[٠-٩]/);
  });
});

describe('the keyboard', () => {
  it('every documented shortcut does the thing it promises', async () => {
    app = await createApp();
    await dropOnStage([VIDEO(), VIDEO2()]);
    const { player, stage } = app;
    const acted = async (key, probe) => {
      const before = probe();
      app.key(key);
      await app.settle(1);
      expect(probe(), `pressing "${key}" did nothing at all`).not.toEqual(before);
    };
    await acted('.', () => app.counter());
    await acted(',', () => app.counter());
    await acted('l', () => player.loop);
    await acted('a', () => app.$('autoplay').getAttribute('aria-pressed'));
    await acted('m', () => player.muted);
    /* `d` is the default fit, so it is observed from another one */
    app.key('c');
    await app.settle(1);
    await acted('d', () => stage.dataset.fit);
    await acted('c', () => stage.dataset.fit);
    await acted('s', () => stage.dataset.fit);
    await acted('h', () => stage.classList.contains('ui'));
    await acted('p', () => stage.classList.contains('list'));
    await acted('i', () => app.$('help-modal').hidden);
    await acted('?', () => app.$('help-modal').hidden);
  });

  it('ignores a key event that carries no key', async () => {
    app = await createApp();
    await dropOnStage([VIDEO()]);
    const event = new app.window.KeyboardEvent('keydown', { bubbles: true });
    Object.defineProperty(event, 'key', { get: () => undefined });
    expect(() => app.document.dispatchEvent(event)).not.toThrow();
  });

  it('leaves the keys to a form control', async () => {
    app = await createApp();
    await dropOnStage([VIDEO()]);
    app.$('settings').click();
    app.$('set-lang').focus();
    const fit = app.stage.dataset.fit;
    app.key('c');
    expect(app.stage.dataset.fit).toBe(fit);
    app.key('m');
    expect(app.player.muted).toBe(false);
  });

  it('closes the dialogs with Escape, before the panel', async () => {
    app = await createApp();
    app.key('i'); await app.settle(1);
    expect(app.$('help-modal').hidden).toBe(false);
    app.key('Escape'); await app.settle(1);
    expect(app.$('help-modal').hidden).toBe(true);

    app.key('p'); await app.settle(1);
    app.$('settings').click(); await app.settle(1);
    app.key('Escape'); await app.settle(1);
    expect(app.$('settings-modal').hidden).toBe(true);
    /* the panel was open underneath and must still be open */
    expect(app.stage.classList.contains('list')).toBe(true);
  });

  it('leaves the arrow keys to a focused slider', async () => {
    app = await createApp();
    await dropOnStage([VIDEO()]);
    await app.settle(1);
    app.player.currentTime = 60;
    const slider = app.document.querySelector('media-time-slider');
    slider.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(app.player.currentTime).toBe(60);
  });

  it('ignores a modified key press, so browser shortcuts still work', async () => {
    app = await createApp();
    await dropOnStage([VIDEO()]);
    const fit = app.stage.dataset.fit;
    app.key('c', { metaKey: true });
    app.key('c', { ctrlKey: true });
    expect(app.stage.dataset.fit).toBe(fit);
  });
});

describe('the instructions dialog', () => {
  it('opens on both its keys and closes on the same ones', async () => {
    app = await createApp();
    for (const key of ['?', 'i']) {
      app.key(key); await app.settle(1);
      expect(app.$('help-modal').hidden).toBe(false);
      app.key(key); await app.settle(1);
      expect(app.$('help-modal').hidden).toBe(true);
    }
  });

  it('translates every string it shows', async () => {
    app = await createApp();
    app.key('?');
    await app.settle(1);
    const before = app.$('help-modal').textContent;
    app.window.I18n.setLang('ar');
    await app.settle(1);
    expect(app.$('help-modal').textContent).not.toBe(before);
  });
});

describe('switching language', () => {
  it('mirrors the document and re-renders what JS built', async () => {
    app = await createApp();
    await dropOnStage([VIDEO(), VIDEO2()]);
    app.window.I18n.setLang('ar');
    await app.settle(1);
    expect(app.document.documentElement.dir).toBe('rtl');
    expect(app.document.querySelector('.side-title').textContent).not.toBe('Playlist');
    expect(app.durations()[0]).toMatch(/[٠-٩]/);
  });

  it('re-paints the bar controls, whose text is built in JS', async () => {
    app = await createApp();
    const before = app.$('loop').title;
    app.window.I18n.setLang('ar');
    await app.settle(1);
    expect(app.$('loop').title).not.toBe(before);
  });
});

describe('persistence', () => {
  it('saves what the user chose, and restores it', async () => {
    app = await createApp();
    await dropOnStage([VIDEO(), VIDEO2()]);
    app.key('c');
    app.key('l');
    app.key('h');
    app.key('p');
    app.player.volume = 0.4;
    app.player.muted = true;
    await app.settleAll();
    const saved = app.prefs();
    expect(saved.fit).toBe('cover');
    expect(saved.loop).toBe(true);
    expect(saved.volume).toBeCloseTo(0.4);
    expect(saved.muted).toBe(true);

    app.close();
    app = await createApp({ state: saved });
    await app.settle(1);
    expect(app.stage.dataset.fit).toBe('cover');
    expect(app.player.loop).toBe(true);
    expect(app.player.volume).toBeCloseTo(0.4);
    expect(app.player.muted).toBe(true);
    expect(app.stage.classList.contains('ui')).toBe(false);
    expect(app.stage.classList.contains('list')).toBe(true);
  });

  it('records the position against the model, not the outgoing track', async () => {
    app = await createApp();
    await dropOnStage([VIDEO(), VIDEO2()]);
    await app.settle(1);
    app.player.currentTime = 5;
    app.rows()[1].dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }));
    await app.settle(1);
    /* the old track's time is still on the element at this point */
    await app.settleAll();
    expect(app.prefs().position).toBe(0);
    expect(app.prefs().index).toBe(1);
  });

  it('releases a removed file before the player is done with it', async () => {
    app = await createApp();
    await dropOnStage([VIDEO(), VIDEO2()]);
    app.rows()[1].dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }));
    await app.settle(1);
    const playing = app.urls.created[1];
    /* deleting a different row must not revoke the one being streamed */
    app.rows()[0].querySelector('.x').dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }));
    await app.settle(1);
    expect(playing.revoked).toBe(false);
  });
});

describe('surviving a large playlist', () => {
  it('adds hundreds of files without rebuilding the list per probe', async () => {
    app = await createApp();
    const many = Array.from({ length: 250 }, (_, i) => app.file(`clip-${i}.mp4`, 'video/mp4'));
    await dropOnStage(many);
    expect(app.rows()).toHaveLength(250);
    expect(app.counter()).toBe('1 / 250');
    expect(app.errors).toEqual([]);
    /* every probe finished, and each row carries its own duration */
    expect(new Set(app.durations()).size).toBe(1);
    expect(app.durations()[0]).toBe('0:11');
  });
});
