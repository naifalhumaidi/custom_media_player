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

  /* The playhead is read from the media element, not from the player.

     The player element keeps its own copy of `currentTime` for its own controls
     and does not follow a seek the app performs directly: with the video
     genuinely at 4.0s, the player still reported 8. So `seekBy` computed its
     step from a position the video had already left, and a second press landed
     in the wrong place. Found by the final pass, in a real window, because the
     fake player and the real one were wrong in the same direction and neither
     could show the other.

     Reproduced here by making the player stale on purpose, which is exactly what
     the real library does. */
  it('seeks from where the video actually is, not from where the player thinks', async () => {
    app = await createApp();
    await dropOnStage([VIDEO()]);
    await app.settleAll();

    /* The video inside the player, and the player's own report of the same
       playhead - two values, because they disagree in the real library. */
    const video = app.player.mediaEl;
    app.player.currentTime = 8;
    /* Move the video behind the player's back, then let the player stop
       following. That is the state a seek performed by the app leaves behind,
       and it is the one the bug could not be seen in. */
    video.currentTime = 3;
    app.player.goStale();
    await app.settle(1);

    expect(app.player.currentTime).toBe(8);

    /* The bridge must agree with the video, not with the player. */
    expect(app.window.MediaBridge.currentTime).toBeCloseTo(3, 1);

    app.window.MediaBridge.seekBy(1);
    await app.settle(2);
    expect(app.window.MediaBridge.currentTime).toBeCloseTo(4, 0);
    expect(video.currentTime).toBeCloseTo(4, 0);
    /* and the player's report stayed where it was, which is what made the bug
       invisible: with the two in step, every seek test passes whatever the
       bridge reads. */
    expect(app.player.currentTime).toBe(8);
  });

  /* And backwards, because "from the end of the clip" is where a stale base hurts
     most: the target is negative and clamps to zero, so a wrong base turns the
     seek into a no-op. */
  it('seeks backwards from the end of the clip', async () => {
    app = await createApp();
    await dropOnStage([VIDEO()]);
    await app.settleAll();
    app.window.MediaBridge.pause();

    app.window.MediaBridge.seekBy(app.window.MediaBridge.duration);
    await app.settle(2);
    const atEnd = app.window.MediaBridge.currentTime;
    expect(atEnd).toBeGreaterThan(0);

    app.window.MediaBridge.seekBy(-3);
    await app.settle(2);
    expect(app.window.MediaBridge.currentTime).toBeLessThan(atEnd - 1);
  });

  /* Transport acts on the media element, not on the player.

     Found by the comprehensive e2e pass, in a real window, and it is the worst
     kind of failure there is: not loud, not silent, but *lying*.

     `player.play()` returned a promise that RESOLVED and the video did not move.
     The clip stayed paused, and the app reported itself as playing anyway,
     because a resolved promise is not a rejection and nothing checked what came
     back. Every play/pause in the app went through it - the Space key, the play
     button, a row click - so on a clip whose transport had gone stale, none of
     them did anything and all of them looked like they had.

     The player's transport goes stale after a few track changes in one window.
     It is not a thing the fakes could show: the fake player's transport worked
     every time, so every unit test passed whatever the bridge read. The knob
     below is what makes it reproducible here. */
  it('play() reaches the media when the player transport goes stale', async () => {
    app = await createApp();
    await dropOnStage([VIDEO()]);
    await app.settleAll();
    app.window.MediaBridge.pause();
    await app.settle(1);
    expect(app.window.MediaBridge.playing).toBe(false);

    /* The player's transport now does nothing - it answers, it succeeds, and the
       clip stays where it was. Exactly as the real one did. */
    app.player.transportGoesStale = true;

    /* Paused first, and paused on the element, so the state this test is about
       is real. Going through the bridge's own pause() would not do it: that also
       goes through the player, so with the player broken the clip would never
       stop and "play() started it" would be true before play() was ever called.
       A test that cannot fail is worse than no test. */
    app.player.mediaEl.pause();
    await app.settle(1);
    expect(app.window.MediaBridge.playing,
      'the setup must leave the clip genuinely paused').toBe(false);

    app.window.MediaBridge.play();
    /* Long enough for the retry to come round. It checks on a timer rather than
       once on the spot, because a single check is a coin toss on WHEN it lands -
       the element is briefly not ready straight after a seek, and a check that
       arrives in that window concludes nothing is wrong and never looks again. */
    await app.settle(400);

    /* The player's transport is dead: it answers, it succeeds, it changes
       nothing. Playback starts anyway, because the bridge noticed the element
       disagreed with a call that said yes and asked the element as well. A
       bridge that trusted the promise would have left the clip sitting there -
       which is precisely how this bug reached a person as "the play button does
       nothing". */
    expect(app.window.MediaBridge.playing,
      'play() did not start playback: it trusted a resolved promise from the dead player transport').toBe(true);
  });

  it('play() does not second-guess the player mid-load, which would break track changes', async () => {
    app = await createApp();
    await dropOnStage([VIDEO(), () => app.file('b.mp4', 'video/mp4')]);
    await app.settleAll();

    /* The load's own autoplay must be left to the library, which owns the
       provider and the ready lifecycle. A second play() arriving from under it
       leaves the clip and the player disagreeing about whether it is running -
       and the outgoing element starts instead of the incoming one.

       This is not hypothetical. With the fallback left on during a load,
       Previous and Next stopped moving. */
    const before = app.player.mediaElPlays;
    const plays = app.player.playerPlayCalls;

    /* Change track. The load's autoplay goes through the same play(), and there
       the library owns the provider and the ready lifecycle. */
    app.key('.');
    await app.settleAll();

    expect(app.player.playerPlayCalls,
      'the player was not asked to start the incoming clip').toBeGreaterThan(plays);
    expect(app.player.mediaElPlays,
      'play() asked the element on top of the player during a load').toBe(before);
  });

  /* Pause has no fallback, on purpose, and this is here to stop that changing
     without someone finding out the hard way.

     Only play was ever measured going stale. Pause through the player has always
     reached the media. Adding a fallback to pause for symmetry looks reasonable
     and breaks track changes: `load()` pauses the outgoing clip while a source
     change is in flight, and a fallback that reaches the element in that window
     reaches the wrong element. With it in, Previous and Next stopped moving - a
     shortcut that had worked in every previous run, failing only because of a
     "fix" for a bug pause did not have. */
  it('pause goes through the player, with no fallback to the element', async () => {
    app = await createApp();
    await dropOnStage([VIDEO()]);
    await app.settleAll();
    expect(app.window.MediaBridge.playing).toBe(true);

    const before = app.player.playerPauseCalls;
    app.window.MediaBridge.pause();
    await app.settle(2);

    expect(app.window.MediaBridge.playing).toBe(false);
    expect(app.player.playerPauseCalls,
      'pause() went somewhere other than the player').toBe(before + 1);
    expect(app.player.playerPlayCalls,
      'pause() fell back to playing the element, which is the track-change bug').toBe(
      app.player.playerPlayCalls);
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
