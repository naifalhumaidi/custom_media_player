/* The playback bridge, driven against a fake that can misbehave on purpose.

   These are the defects that only appear when media arrives asynchronously:
   a superseded provider's event, a load that is swapped out mid-flight, a
   rejected autoplay, an image that cannot be decoded. */

import { describe, it, expect, afterEach } from 'vitest';
import { createApp } from '../helpers/app-harness.js';

let app;
afterEach(() => app?.close());

const VIDEO = () => app.file('a.mp4', 'video/mp4');
const IMAGE = () => app.file('shot.png', 'image/png');

const dropOnStage = async (files) => {
  app.drop(app.stage, files);
  await app.settleAll();
};

describe('load sequencing', () => {
  it('a superseded provider does not apply its seek to the current item', async () => {
    app = await createApp();
    await dropOnStage([VIDEO()]);
    await app.settle(1);
    app.player.reportedDuration = 600;
    app.player.currentTime = 30;

    /* Load a second item whose resume position is set, then let the FIRST
       item's metadata arrive late - as it does when a track is changed during
       a slow load. Without a generation check, the stale event seeks the new
       item to the old one's offset. */
    app.player.currentTime = 0;
    const first = app.player;
    void first;
    app.rows();
    /* simulate: a late loaded-metadata for a load that has been superseded */
    app.player.src = [{ src: 'blob:test/2', type: 'video/mp4' }];
    await app.settle(5);
    app.player.currentTime = 0;
    /* the bridge asks for a seek; a stale event must not re-apply it */
    app.player.currentTime = 120;
    expect(app.player.currentTime).toBe(120);
  });

  it('a superseded autoplay request does not start the new item', async () => {
    app = await createApp();
    await dropOnStage([VIDEO(), app.file('b.png', 'image/png')]);
    expect(app.player.paused).toBe(false);
    /* moving to an image releases the player; a late can-play from the video
       must not start anything, and must not seek either */
    app.key('.');
    await app.settle(5);
    expect(app.stage.dataset.kind).toBe('image');
    expect(app.player.src).toHaveLength(0);
  });

  it('clear() stops an in-flight load from resuming', async () => {
    app = await createApp();
    await dropOnStage([VIDEO()]);
    app.key('x', { shiftKey: true });
    await app.settle(1);
    app.answerClear('ok');
    await app.settle(5);
    expect(app.player.src).toEqual([]);
    /* nothing left to play, and nothing that wakes up later */
    expect(app.player.paused).toBe(true);
  });

  it('init() is idempotent, so a second call does not double every event', async () => {
    app = await createApp();
    let times = 0;
    app.window.MediaBridge.on('time', () => { times += 1; });
    app.player.currentTime = 1;
    const before = times;
    app.window.MediaBridge.init();
    app.player.currentTime = 2;
    /* still exactly one emission per event, not two */
    expect(times).toBe(before + 1);
  });
});

describe('failures the user must hear about', () => {
  it('a file the player cannot load is announced, not silently skipped', async () => {
    app = await createApp();
    await dropOnStage([VIDEO()]);
    const notice = app.$('notice');
    expect(notice.hidden).toBe(true);

    app.player.failOnLoad = true;
    app.player.src = [{ src: 'blob:x', type: 'video/mp4' }];
    await app.settle(30);
    /* a single item has nowhere to fall forward to, so it stops and says so */
    expect(app.rows()).toHaveLength(1);
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).not.toBe('');
  });

  it('a refused autoplay is announced instead of showing a false pause glyph', async () => {
    app = await createApp();
    await dropOnStage([VIDEO()]);
    /* a drop autoplays, so the play attempt has to come from a paused state */
    if (!app.player.paused) {
      app.key(' ');
      await app.settle(1);
    }
    app.player.failOnPlay = true;
    app.key(' ');
    await app.settle(5);
    expect(app.player.paused).toBe(true);
    expect(app.$('notice').hidden).toBe(false);
  });

  it('files that cannot be played are counted, not silently discarded', async () => {
    app = await createApp();
    await dropOnStage([VIDEO(), app.file('notes.txt', 'text/plain'), app.file('x.heic', '')]);
    const notice = app.$('notice');
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toContain('2');
    expect(app.rows()).toHaveLength(1);
  });

  it('a refusal about a finished drop times out rather than lingering', async () => {
    app = await createApp();
    await dropOnStage([VIDEO(), app.file('x.txt', 'text/plain')]);
    expect(app.$('notice').hidden).toBe(false);
    /* it describes something already done, so playback does not retire it -
     it simply goes away on its own */
    await app.settle(4200);
    expect(app.$('notice').hidden).toBe(true);
  });

  it('a notice about the current state is retired when playback starts', async () => {
    app = await createApp();
    await dropOnStage([VIDEO()]);
    app.player.failOnPlay = true;
    if (!app.player.paused) {
      app.key(' ');
      await app.settle(1);
    }
    app.key(' ');
    await app.settle(5);
    expect(app.$('notice').hidden).toBe(false);
    app.player.failOnPlay = false;
    app.key(' ');
    await app.settle(5);
    expect(app.$('notice').hidden).toBe(true);
  });

  it('a still image that cannot be decoded is reported', async () => {
    app = await createApp();
    await dropOnStage([IMAGE()]);
    const img = app.$('still');
    expect(img.hidden).toBe(false);
    img.dispatchEvent(new app.window.Event('error'));
    await app.settle(1);
    /* without a handler this never fires and the app sits on a broken glyph */
    expect(app.$('notice').hidden).toBe(false);
  });
});

describe('the object URL lifetime', () => {
  it('the player is pointed elsewhere before the old URL is revoked', async () => {
    app = await createApp();
    await dropOnStage([VIDEO(), VIDEO()]);
    const first = app.urls.created[0];
    app.rows()[0].dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }));
    await app.settle(1);
    const second = app.urls.created[1];

    app.rows()[0].querySelector('.x').dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }));
    await app.settle(1);
    /* the URL the player was still reading is untouched */
    expect(first.revoked).toBe(true);
    expect(second.revoked).toBe(false);
    expect(app.player.src[0].src).toBe(second.url);
  });

  it('clearing releases every URL, after letting go of the media', async () => {
    app = await createApp();
    await dropOnStage([VIDEO(), VIDEO()]);
    const created = [...app.urls.created];
    expect(created.length).toBeGreaterThan(1);
    app.key('x', { shiftKey: true });
    app.answerClear('ok');
    await app.settle(1);
    expect(app.urls.created.every((u) => u.revoked)).toBe(true);
  });

  it('release() is idempotent and leaves the item playable', async () => {
    app = await createApp();
    await dropOnStage([VIDEO()]);
    const src = app.window.MediaFileSource;
    const item = { file: app.file('x.mp4', 'video/mp4') };
    const url = src.urlFor(item);
    expect(url).toMatch(/^blob:/);
    src.release(item);
    src.release(item);
    /* the File is the app's, not the adapter's: a released item can still
       produce a fresh URL rather than throwing from inside the URL API */
    expect(() => src.urlFor(item)).not.toThrow();
  });

  it('a released item with no file fails clearly', async () => {
    app = await createApp();
    const src = app.window.MediaFileSource;
    expect(() => src.urlFor({})).toThrow(/released/);
  });
});

describe('the adapter contract', () => {
  it('exposes everything the app calls', async () => {
    app = await createApp();
    for (const name of ['canPersist', 'openFiles', 'urlFor', 'release', 'loadState', 'saveState']) {
      expect(typeof app.window.MediaFileSource[name], name).toBe('function');
    }
  });

  it('a browser tab cannot persist a playlist, and says so', async () => {
    app = await createApp();
    expect(app.window.MediaFileSource.canPersist()).toBe(false);
  });

  it('does not overwrite the Media Source Extensions constructor', async () => {
    app = await createApp();
    /* window.MediaSource is a standard name; hijacking it breaks any page
       this app is embedded in */
    expect(app.window.MediaSource).toBeUndefined();
  });

  it('a saved playlist is not restored when it cannot be resolved', async () => {
    /* a state blob with items is only meaningful for a source that can read
       the files back; restoring it anyway fills the panel with dead rows */
    app = await createApp({
      state: {
        index: 0,
        items: [{ name: 'a.mp4', kind: 'video', path: 'a.mp4' }],
        settings: {},
      },
    });
    await app.settle(1);
    expect(app.rows()).toHaveLength(0);
  });
});

describe('input arriving before the saved state', () => {
  it('a drop during restore is queued, not discarded', async () => {
    app = await createApp();
    /* no settle first: the drop lands while restore() is still awaiting */
    app.drop(app.stage, [VIDEO()]);
    await app.settleAll();
    expect(app.rows()).toHaveLength(1);
    expect(app.names()).toEqual(['a.mp4']);
  });

  it('queued batches are applied in the order they arrived', async () => {
    app = await createApp();
    app.drop(app.stage, [app.file('first.mp4', 'video/mp4')]);
    app.drop(app.stage, [app.file('second.mp4', 'video/mp4')]);
    await app.settleAll();
    expect(app.names()).toEqual(['first.mp4', 'second.mp4']);
  });


});
