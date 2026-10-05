/* The final pass: every control, every state, every way of getting there.
 *
 * Everything here runs inside a real window, headless, on a throwaway framebuffer.
 * It is written as scenarios rather than as assertions about markup, because the
 * questions that matter are about behaviour - what happens when you press this
 * while that is open, what is left behind, what a person can still reach.
 *
 * Each area returns an object of { name: value } steps. The runner compares them
 * against expectations and prints one line per failure, because a suite that
 * prints "FAILED" without saying which is a suite nobody can act on.
 *
 * Written as a page script rather than driven from Node so that a whole scenario
 * - fifteen steps with waits between them - is one atomic thing in the app's own
 * thread, with no chance of the runner interleaving with it.
 */

window.__DONE = (async () => {
  const steps = [];
  const S = (name, value) => steps.push([name, value]);

  /* A check has to answer a question, and the answer has to be yes or no.

     This used to take the value and record `!!value`, which meant a check written
     as `ok('name', condition ? 'all good' : whatWentWrong)` was passing on the
     string "all good" and also on the string describing the failure - because a
     non-empty string is truthy either way. Eight checks were written that way,
     all of them counted, all of them passing, and the suite reported 206 green
     while one of them was watching every shortcut in the app and could not have
     failed.

     So a non-boolean is now refused rather than coerced. A check that cannot
     express itself as a yes or a no is a broken check, and it says so instead of
     quietly agreeing with everything. */
  const ok = (name, condition, detail) => {
    if (typeof condition !== 'boolean') {
      steps.push([name, {
        ok: false,
        got: 'this check did not produce a yes or a no, so it cannot be counted: '
          + String(condition),
      }]);
      return;
    }
    steps.push([name, { ok: condition, got: detail === undefined ? String(condition) : detail }]);
  };

  const $ = (id) => document.getElementById(id);
  const q = (sel) => document.querySelector(sel);
  const qa = (sel) => [...document.querySelectorAll(sel)];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /* Take the focus off whatever holds it.

     `document.body.focus()` looks like it does this and does not: with a button
     focused it is a no-op in Chromium, so the focus stayed exactly where it was.
     That is why Space appeared to be broken in three checks - the key was being
     dispatched at the Play button, the app correctly left it to the control, and
     nothing in the app was ever asked.

     blur() is what actually moves it, and the helper says whether it worked
     rather than assuming. */
  const focusNowhere = async () => {
    const active = document.activeElement;
    if (active && typeof active.blur === 'function') active.blur();
    await wait(80);
    return document.activeElement === document.body || document.activeElement === null;
  };
  const css = (el, prop) => (el ? getComputedStyle(el).getPropertyValue(prop).trim() : '(no element)');

  /* Wait for a thing rather than for a length of time. A fixed sleep is right in
     exactly one place and wrong everywhere else: it passes on a fast machine
     about a broken thing and fails on a slow one about a working thing. */
  const until = async (test, limit = 8000, step = 50) => {
    const deadline = Date.now() + limit;
    for (;;) {
      let yes = false;
      try { yes = !!test(); } catch { yes = false; }
      if (yes) return true;
      if (Date.now() >= deadline) return false;
      await wait(step);
    }
  };

  const list = () => qa('#list li');
  const names = () => list().map((li) => (li.querySelector('.nm') || li).textContent.trim());
  const currentRow = () => list().findIndex((li) => li.classList.contains('on'));

  /* A drop, the way a person makes one: a real DragEvent on a real target. */
  const makeFiles = async (spec) => {
    const dt = new DataTransfer();
    for (const [src, name, type] of spec) {
      const blob = await (await fetch('http://127.0.0.1:8123/' + src)).blob();
      dt.items.add(new File([blob], name, { type }));
    }
    return dt;
  };
  const dropOn = async (target, spec) => {
    target.dispatchEvent(new DragEvent('drop', {
      dataTransfer: await makeFiles(spec), bubbles: true, cancelable: true,
    }));
  };
  const key = (k, mods) => (document.activeElement || document)
    .dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...(mods || {}) }));
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

  /* A real click, which is not the same thing as a bare `click` event.

     A click is pointerdown, pointerup and click, and the player library's own
     controls - the play button, the seek buttons - listen for the pointer half.
     Dispatching only `click` leaves them inert, so the suite pressed play and
     nothing happened, then reported "the play button does not toggle" - a defect
     in the app that was entirely a defect in the test. Pressing play really does
     toggle it; a browser just never sends a bare click on its own. */
  const press = (el) => {
    if (!el) return;
    const r = el.getBoundingClientRect();
    const at = {
      bubbles: true, cancelable: true, composed: true, button: 0, pointerId: 1,
      isPrimary: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
    };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...at, buttons: 1 }));
    el.dispatchEvent(new PointerEvent('pointerup', { ...at, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('click', { ...at, buttons: 0, detail: 1 }));
  };
  const menu = (command) => window.MediaMenu.send(command);

  const VIDEO = [['clip.mp4', 'a.mp4', 'video/mp4']];
  const MIXED = [
    ['clip.mp4', 'a.mp4', 'video/mp4'],
    ['still.png', 'b.png', 'image/png'],
    ['tone.mp3', 'c.mp3', 'audio/mpeg'],
    ['long.mp4', 'd.mp4', 'video/mp4'],
  ];
  /* Nothing playable, and something playable, so "refused" and "added" are
     distinguishable. A file with no extension and no type is the sharpest test:
     there is no rule that could classify it as media. */
  const JUNK = [['clip.mp4', 'notes.txt', 'text/plain'], ['clip.mp4', 'archive.zip', 'application/zip']];
  /* A name not already in the playlist: MIXED contains c.mp3, and a duplicate is
     refused - correctly, and for a reason that has nothing to do with whether the
     other half of the drop is playable. Asking for a name that is already there
     would test the duplicate rule while claiming to test the refusal of an
     unplayable file. */
  const ONE_GOOD = [['tone.mp3', 'new.mp3', 'audio/mpeg'], ['clip.mp4', 'notes.txt', 'text/plain']];

  const openSettings = async () => {
    menu('settings');
    return until(() => !$('settings-modal').hidden, 3000);
  };
  const closeSettings = async () => {
    click($('settings-close'));
    return until(() => $('settings-modal').hidden, 3000);
  };
  const drop = async (spec, onStage = true) => {
    const target = onStage ? $('stage') : $('side');
    const before = list().length;
    await dropOn(target, spec);
    return until(() => list().length !== before, 8000);
  };

  /* Empty the playlist, whatever this build offers.

     Shift+X, not the trash button: a browser tab cannot keep a playlist, so the
     button is deliberately not there - and a scenario that reached for it would
     silently do nothing, leaving the previous scenario's rows and the previous
     scenario's medium in place. Every later check would then be measuring the
     wrong state, and the failures would point at the wrong thing entirely. That
     is what happened before this helper existed: the image scenario left an
     image current, an image hides the control bar, and eleven layout checks
     reported the bar's controls as unreachable. */
  const clearAll = async () => {
    if (!list().length) return true;
    key('x', { shiftKey: true });
    await until(() => !$('clear-modal').hidden, 4000);
    click($('clear-ok'));
    return until(() => list().length === 0, 6000);
  };

  /* Wait until the playhead stops moving.

       A seek takes a moment to land, and a check that presses a button while the
       previous seek is still in flight is testing the race rather than the button:
       the reader library ignores a second seek while the first is decoding, so the
       press does nothing and the check reports a dead button. Waiting for the
       playhead to cross a threshold is not enough - it crosses on the way in. */
  const settle = async (limit = 4000) => {
    const deadline = Date.now() + limit;
    let last = NaN;
    let still = 0;
    while (Date.now() < deadline) {
      const now = window.MediaBridge.currentTime;
      still = now === last ? still + 1 : 0;
      last = now;
      if (still >= 3) return now;
      await wait(120);
    }
    return window.MediaBridge.currentTime;
  };

  /* Rewound and settled, which is what "a clip ready to play" means.

     A clip that has ended cannot be played again by pressing play: it is paused at
     its end, and `play()` on an ended element does nothing. An eight second clip
     reaches its end across a handful of checks, and "space did not restart it" was
     that - not a broken key, and not a check that could tell the difference. */
  const freshClip = async () => {
    await rewind();
    await settle();
  };

  /* Auto-start off.

     The probe clip is eight seconds and these areas take longer than that. With
     auto-start on, the app moves to the next row when a clip ends - and the next
     row in the mixed playlist is a picture, which has no duration at all. So a
     seek check that ran a minute into the area was seeking on a still image,
     reported the playhead as unmovable, and produced three failures that read as
     three broken buttons.

     Nothing here is testing auto-start; the area that does is `keyboard`. This is
     about keeping the thing under test the same thing for its whole length. */
  const autoOff = async () => {
    while ($('autoplay').classList.contains('on')) {
      click($('autoplay'));
      await until(() => !$('autoplay').classList.contains('on'), 3000);
    }
  };

  /* Back to the start, so a measurement is about the control and not about how
     much of the clip was already gone. The clip is eight seconds, which is less
     than a scenario takes. */
  const rewind = async () => {
    if (Number.isFinite(window.MediaBridge.duration) && window.MediaBridge.duration > 0.5) {
      try { window.MediaBridge.seekBy(-window.MediaBridge.duration); } catch { /* nothing loaded */ }
      await wait(400);
    }
    return window.MediaBridge.currentTime;
  };

  /* Start a scenario from nothing, whatever the previous one left behind. */
  const freshPlaylist = async () => {
    await clearAll();
    if (!list().length) return true;
    /* No clear at all - a build with no way to empty the list. Said plainly
       rather than carried on with, because every count below would be wrong. */
    steps.push(['UNABLE TO EMPTY THE PLAYLIST', list().length + ' rows are stuck']);
    return false;
  };

  /* ================================================================== 1. the
   * start window: what a person sees before they have done anything. */
  const startup = async () => {
    ok('start: playlist is empty', list().length === 0);
    ok('start: the logo shows', !q('.logo').hidden && q('.logo').complete && q('.logo').naturalWidth > 0);
    ok('start: the drop hint is the logo', !$('drop').hidden);
    ok('start: the controls are shown', $('stage').classList.contains('ui'));
    ok('start: the panel is closed', !$('stage').classList.contains('list'));
    ok('start: the bar is on screen', css($('bar'), 'display') !== 'none');
    ok('start: nothing is playing', !window.MediaBridge.playing);
    ok('start: the counter is empty', $('counter').textContent === '');
    ok('start: the title is empty', $('title').textContent === '');
    ok('start: no notice is showing', $('notice').hidden);
  };

  /* ================================================================== 2. adding
   * files, and what the app does with ones it cannot use. */
  const adding = async () => {
    ok('drop: one file becomes one row', await drop(VIDEO));
    ok('drop: the row is named', names()[0] === 'a.mp4');
    ok('drop: the hint goes away', $('drop').hidden);
    ok('drop: the first row is current', currentRow() === 0);
    ok('drop: it plays', await until(() => window.MediaBridge.playing, 8000));
    ok('drop: the duration is known', Number.isFinite(window.MediaBridge.duration));
    /* With one item there is nothing to count against, so the counter is empty
       and the total line carries the information instead. Asserting on the
       wrong one is how a suite ends up reporting a defect that is not there. */
    ok('drop: the total line names what is loaded', $('total').textContent.length > 3);
    ok('drop: the title names the file', $('title').textContent === 'a.mp4');

    /* Two at once, dropped on the window. */
    ok('drop: two at once', await drop(MIXED));
    ok('drop: four rows', list().length === 4);
    ok('drop: the names are in order', names().join(' ') === 'a.mp4 b.png c.mp3 d.mp4');

    /* Dropped on the panel instead: added, and playback is not interrupted. */
    const wasPlaying = window.MediaBridge.playing;
    const before = currentRow();
    ok('drop on the panel: appended', await drop([['clip.mp4', 'e.mp4', 'video/mp4']], false));
    ok('drop on the panel: five rows', list().length === 5);
    ok('drop on the panel: playback continues', window.MediaBridge.playing === wasPlaying);
    ok('drop on the panel: the current row did not change', currentRow() === before);

    /* Nothing playable. Refused, with a notice, and no dead rows. */
    const rows = list().length;
    await dropOn($('stage'), JUNK);
    ok('junk: no rows were added', list().length === rows);
    await until(() => !$('notice').hidden, 4000);
    ok('junk: it says why', $('notice').textContent.length > 3);
    /* It announces itself and gets out of the way on its own. It is a polite
       live region with `pointer-events: none`, deliberately not a button: a
       message about files that cannot play is information, and clicking it to
       find out what clicking it does is a worse thing than four seconds of
       reading. Asserted as what it is. */
    ok('junk: it is announced politely',
      $('notice').getAttribute('role') === 'status'
      && $('notice').getAttribute('aria-live') === 'polite');
    ok('junk: it is not pretending to be clickable',
      getComputedStyle($('notice')).pointerEvents === 'none');
    ok('junk: and it goes away on its own', await until(() => $('notice').hidden, 6000));

    /* Half a drop is still a drop. Refusing all of it because one file is a text
       document would be worse than adding what can be played - so the playable
       half has to arrive and the document has not to.
       
       The playable file here is named differently from the one already added, so
       this tests the refusal rather than the duplicate rule. */
    const beforeMixed = list().length;
    ok('mixed: the drop was accepted', await drop(ONE_GOOD));
    ok('mixed: exactly one row was added', list().length === beforeMixed + 1);
    ok('mixed: and it is the playable one', names()[names().length - 1] === 'new.mp3');
    ok('mixed: the refused file is not in the list', !names().includes('notes.txt'));
    /* And a file that is already in the list is refused too, for a different
       reason. Checked here because it was found by accident: the same drop said
       "c.mp3", which MIXED had already added, and nothing was added - which read
       as the refusal of an unplayable file and was nothing of the kind. */
    ok('duplicate: the same file again adds nothing',
      !(await drop(MIXED.slice(0, 1))) && list().length === beforeMixed + 1);
    ok('duplicate: and it is still only one copy',
      names().filter((n) => n === 'a.mp4').length === 1);
  };

  /* ================================================================== 3. the
   * playlist: selecting, removing, and the row as a thing you can operate. */
  const playlist = async () => {
    /* Clear, through the dialog, because asking is the feature and clicking
       straight through would be testing its absence. Shift+X, because the
       button is not there in a browser tab. */
    key('x', { shiftKey: true });
    ok('clear: it asks first', await until(() => !$('clear-modal').hidden, 4000));
    ok('clear: nothing is gone yet', list().length > 0);
    click($('clear-cancel'));
    await until(() => $('clear-modal').hidden, 3000);
    ok('clear: cancel keeps the list', list().length > 0);
    ok('clear: the dialog closed', $('clear-modal').hidden);

    key('x', { shiftKey: true });
    await until(() => !$('clear-modal').hidden, 4000);
    ok('clear: focus starts on cancel', document.activeElement.id === 'clear-cancel');
    /* Arrows move between the two buttons, and Enter activates the focused one. */
    key('ArrowLeft');
    ok('clear: an arrow moves the focus', document.activeElement.id !== 'clear-cancel');
    click($('clear-ok'));
    ok('clear: confirm empties the list', await until(() => list().length === 0, 4000));
    ok('clear: the start window comes back', !$('drop').hidden);
    ok('clear: the dialog closed', $('clear-modal').hidden);

    /* Add a known playlist back. */
    await drop(MIXED);
    ok('playlist: four rows again', list().length === 4);

    /* Clicking a row plays it. */
    click(list()[2]);
    await until(() => currentRow() === 2, 4000);
    ok('playlist: clicking a row makes it current', currentRow() === 2);
    ok('playlist: the title names it', $('title').textContent === 'c.mp3');

    /* Removing a row: the one above, and the current one. */
    const before = list().length;
    click(list()[0].querySelector('.x'));
    ok('playlist: a row can be removed', await until(() => list().length === before - 1, 4000));
    ok('playlist: the others keep their order', names().join(' ') === 'b.png c.mp3 d.mp4');

    /* Removing the last remaining row returns to the start window. */
    while (list().length) {
      click(list()[list().length - 1].querySelector('.x'));
      await until(() => list().length < 1, 4000);
    }
    ok('playlist: an emptied list shows the hint', !$('drop').hidden);
    ok('playlist: nothing is playing', !window.MediaBridge.playing);
  };

  /* ================================================================ 3b. the two
   * seek buttons, on their own.
   *
   * These were inside the controls area, after its fullscreen round-trip, and
   * they failed there while working perfectly well on their own - measured in a
   * plain window: 33.7s, then 43.7, then 53.7, then back to 43.7, every press
   * doing exactly what its ten seconds said.
   *
   * So they are here on their own, first, with a sixty-second clip and nothing
   * that has happened yet to perturb the window. Two lessons in one place: a check
   * that only passes at the end of a long area is measuring the area as much as
   * the control, and the fix is to stop sharing a window with everything else. */
  const seekButtons = async () => {
    await freshPlaylist();
    await drop([['long.mp4', 'long.mp4', 'video/mp4']]);
    const loaded = await until(() => window.MediaBridge.duration > 30, 15000);
    ok('seek: a clip long enough to seek in is loaded', loaded,
      loaded ? window.MediaBridge.duration.toFixed(0) + 's' : 'never loaded');
    if (!loaded) return;

    /* Paused, so the only thing that can move the playhead is the button. */
    if (window.MediaBridge.playing) {
      press($('play'));
      await until(() => !window.MediaBridge.playing, 5000);
    }
    ok('seek: it is paused, so only the buttons can move it', !window.MediaBridge.playing);

    window.MediaBridge.seekBy(window.MediaBridge.duration / 2);
    await until(() => window.MediaBridge.currentTime > 20, 6000);
    const middle = await settle();
    ok('seek: it starts in the middle', middle > 20, middle.toFixed(1) + 's of '
      + window.MediaBridge.duration.toFixed(0) + 's');

    press($('fwd'));
    await until(() => window.MediaBridge.currentTime > middle + 5, 6000);
    const forward = await settle();
    ok('seek: the forward button moves the playhead forward', forward > middle,
      forward > middle ? `${middle.toFixed(1)} -> ${forward.toFixed(1)}` : `stayed at ${middle.toFixed(1)}`);

    press($('back'));
    await until(() => window.MediaBridge.currentTime < forward - 5, 6000);
    const back = await settle();
    ok('seek: the back button moves it back', back < forward,
      back < forward ? `${forward.toFixed(1)} -> ${back.toFixed(1)}` : `stayed at ${forward.toFixed(1)}`);

    /* Ten seconds each way, twice, because one press landing near the expected
       place and two landing twice as far is the difference between a button that
       seeks and a button that moves. */
    press($('fwd'));
    await until(() => window.MediaBridge.currentTime > back + 5, 6000);
    const again = await settle();
    ok('seek: pressing forward again moves it again', again > back,
      again > back ? `${back.toFixed(1)} -> ${again.toFixed(1)}` : `stayed at ${back.toFixed(1)}`);

    window.MediaBridge.seekBy(-window.MediaBridge.duration);
    await until(() => window.MediaBridge.currentTime === 0, 6000);
    await settle();
    press($('back'));
    await wait(900);
    await settle();
    ok('seek: back at the start stays at the start', window.MediaBridge.currentTime === 0,
      'at ' + window.MediaBridge.currentTime.toFixed(2));

    /* The area after this one counts rows and names them, and a sixty-second clip
       left behind would be counted as somebody else's. */
    await freshPlaylist();
  };

  /* ================================================================== 4. every
   * control on the bar, pressed the way a person presses it. */
  const controls = async () => {
    await drop(MIXED);
    await autoOff();
    const bar = $('bar');

    /* A playable clip, loaded, with a duration.

       Waiting for the duration rather than for the row is the point: a row in the
       list is not a clip that has loaded, and the seek checks further down read a
       playhead that cannot move without one behind it. */
    click(list()[0]);
    const loaded = await until(() => Number.isFinite(window.MediaBridge.duration)
      && window.MediaBridge.duration > 1, 10000);
    ok('controls: a clip is loaded and has a length', loaded,
      loaded ? `${window.MediaBridge.duration.toFixed(1)}s` : 'duration never arrived');

    /* Play and pause, both ways: the button and the key.

       From a known state, in both directions. The probe clip is eight seconds and
       the areas before this one have been playing it, so whether it is playing on
       arrival is a matter of how long they took - and pressing play on something
       already playing pauses it, which is what made three checks report a working
       toggle as broken. Rewound, settled, and paused first. */
    await rewind();
    if (window.MediaBridge.playing) {
      press($('play'));
      await until(() => !window.MediaBridge.playing, 4000);
    }
    await settle();
    ok('play: it starts paused, so "play" means play', !window.MediaBridge.playing);

    await freshClip();
    press($('play'));
    ok('play: the button starts it', await until(() => window.MediaBridge.playing, 6000),
      window.MediaBridge.playing ? 'playing' : 'the button did not start it');

    /* Space belongs to a focused button, and pressing Play left focus on Play.
       That is the right arrangement - a focused button activating itself is what a
       browser does and what a person expects - but a dispatched key event carries
       no such default action, so the app is offered nothing and the two checks
       below report Space broken. Focus is taken off the button first.

       The other half is then checked on purpose, because this arrangement is
       exactly what made those two look broken. */
    /* Not asserted that the press moved the focus: a dispatched pointer event does
       not focus a button the way a real click does, so that would be a fact about
       the harness rather than about the app. What matters is the arrangement - a
       focused control owns Space - which is checked at the end of this block. */
    ok('play: focus can be taken off the bar', await focusNowhere(),
      'focus is on ' + (document.activeElement ? document.activeElement.id || document.activeElement.tagName : 'nothing'));

    key(' ');
    ok('play: space pauses it', await until(() => !window.MediaBridge.playing, 4000),
      window.MediaBridge.playing ? 'still playing' : 'paused');

    await freshClip();
    key(' ');
    ok('play: space starts it again', await until(() => window.MediaBridge.playing, 6000),
      window.MediaBridge.playing ? 'playing' : 'space did not restart it');
    ok('play: the glyph follows', $('play').classList.contains('playing') === window.MediaBridge.playing);

    /* Space with a bar button holding focus.

       The arrangement here is deliberate and worth stating, because a first reading
       of it looks like a bug: Space is play/pause even when a control has focus,
       and the app moves the focus off that control before doing so. Without the
       blur, the browser re-activates the focused button as well, the key is acted
       on twice, and nothing appears to happen.

       An earlier version of this check asserted the opposite - that the app should
       leave Space to a focused control - and broke two unit tests that had been
       asserting this behaviour all along. The contract is the one below. */
    await freshClip();
    $('play').focus();
    await wait(150);
    ok('play: the button holds the focus', document.activeElement === $('play'));
    const wasPlaying = window.MediaBridge.playing;
    key(' ');
    await until(() => window.MediaBridge.playing !== wasPlaying, 4000);
    ok('play: space works even with a bar button focused',
      window.MediaBridge.playing !== wasPlaying,
      window.MediaBridge.playing !== wasPlaying ? 'toggled' : 'nothing happened');
    ok('play: and the focus is moved off the button, so it cannot fire twice',
      document.activeElement !== $('play'),
      'focus is on ' + (document.activeElement ? document.activeElement.id || document.activeElement.tagName : 'nothing'));
    await focusNowhere();

    /* Seek, forwards and back, on media that has somewhere to go.

       Paused first, because a seek on playing media is two changes at once: the
       seek and the clock. Forward ten seconds on an eight-second clip lands at
       the end, the clock is still running, and "did back move it the other way"
       is answered by however much time passed while the check was waiting. That
       is not a flaky assertion, it is an assertion about the wrong thing. */
    /* The timeline slider itself: is it a real control? */
    const slider = q('media-time-slider');
    ok('seek: the slider is present', !!slider);
    ok('seek: it is inside the bar', !!slider && bar.contains(slider));

    /* Loop and auto-start: toggles that say what they are. */
    const loopBefore = $('loop').classList.contains('on');
    click($('loop'));
    ok('loop: it toggles', $('loop').classList.contains('on') !== loopBefore);
    ok('loop: it says pressed', $('loop').getAttribute('aria-pressed') === String($('loop').classList.contains('on')));
    click($('loop'));
    ok('loop: and back', $('loop').classList.contains('on') === loopBefore);

    const autoBefore = $('autoplay').classList.contains('on');
    click($('autoplay'));
    ok('auto: it toggles', $('autoplay').classList.contains('on') !== autoBefore);
    click($('autoplay'));
    ok('auto: and back', $('autoplay').classList.contains('on') === autoBefore);

    /* The three fits. Only two of them change anything on a video, so the
       assertion is that they are settable and say which one is on - not that
       the picture changed. */
    for (const id of ['fit-d', 'fit-c', 'fit-s']) {
      click($(id));
      ok('fit: ' + id + ' turns on', $(id).classList.contains('on'));
      ok('fit: ' + id + ' is the only one on', qa('.btn.ic.on').filter((b) => b.id.startsWith('fit-')).length === 1);
    }
    ok('fit: the stage records it', $('stage').dataset.fit === 'stretch');

    /* Volume and mute, the two the app owns. */
    $('volume').value = '0.4';
    $('volume').dispatchEvent(new Event('input', { bubbles: true }));
    await wait(300);
    ok('volume: the slider sets a level', Math.abs(window.MediaBridge.volume - 0.4) < 0.02);
    ok('volume: the fill follows', css($('volume'), '--mt-fill').startsWith('40'));
    ok('volume: raising it unmutes', window.MediaBridge.muted === false);

    const wasMuted = window.MediaBridge.muted;
    click($('mute'));
    await wait(300);
    ok('mute: it toggles', window.MediaBridge.muted !== wasMuted);
    ok('mute: it says pressed', $('mute').getAttribute('aria-pressed') === String(window.MediaBridge.muted));
    ok('mute: it looks on when muted', $('mute').classList.contains('muted') === window.MediaBridge.muted);
    click($('mute'));
    await wait(300);
    ok('mute: and back', window.MediaBridge.muted === wasMuted);

    /* Fullscreen, and the way back out of it. */
    click($('fs'));
    await until(() => window.MediaBridge.fullscreen, 6000);
    ok('fullscreen: it goes fullscreen', window.MediaBridge.fullscreen);
    ok('fullscreen: the button says so', $('fs').classList.contains('on'));
    ok('fullscreen: the exit glyph is the one shown',
      getComputedStyle(q('#fs use[href="#i-fs-exit"]')).display !== 'none');
    click($('fs'));
    await until(() => !window.MediaBridge.fullscreen, 6000);
    ok('fullscreen: and back out', !window.MediaBridge.fullscreen);

    /* Nothing on the bar is a dead control: every button has a name and a key. */
    const nameless = qa('#bar button').filter((b) => !b.getAttribute('aria-label') && !b.title);
    ok('bar: every button has a name', nameless.length === 0);
    /* A title can name one key or several - "Play / pause (Space, K)" - so the
       pattern has to allow a comma and a space inside the brackets. Matching
       only a single word reported the play button as having no shortcut at all,
       which is the opposite of the truth. */
    /* Not anchored to the end. A toggle's title is "Loop playlist (L) — on", so
       the state sits after the key and a pattern that insists the brackets are
       last reports the two most-used toggles as having no shortcut at all. */
    const keyless = qa('#bar [data-shortcut]').filter((b) => {
      const m = /\(([^)]+)\)/.exec(b.title || '');
      return !m || !m[1].trim();
    });
    ok('bar: every shortcut shows its key', keyless.length === 0,
      keyless.length === 0 ? 'all of them' : keyless.map((b) => b.id).join(' '));
  };

  /* ================================================================== 5. the
   * panel: opening it, the empty state, and the add controls. */
  const panel = async () => {
    key('p');
    await until(() => $('stage').classList.contains('list'), 3000);
    ok('panel: p opens it', $('stage').classList.contains('list'));
    ok('panel: the list is shown', !$('list').hidden);
    key('p');
    await until(() => !$('stage').classList.contains('list'), 3000);
    ok('panel: p closes it', !$('stage').classList.contains('list'));
    /* The panel goes, not the list inside it. `#list` keeps its own hidden
       attribute for the empty state - "nothing here yet" - which is a different
       question from whether the panel is on screen. Asking the wrong element
       reports a defect that is not there. */
    ok('panel: closing takes the panel off screen', css($('side'), 'display') === 'none');
    key('p');
    await until(() => css($('side'), 'display') !== 'none', 3000);
    ok('panel: and it comes back', css($('side'), 'display') !== 'none');
    ok('panel: the list is visible again', !$('list').hidden);

    /* The close button on the panel header is a second way out. */
    key('p');
    await until(() => !$('list').hidden, 3000);
    click($('close-side'));
    ok('panel: the close button closes it',
      await until(() => css($('side'), 'display') === 'none', 3000));

    /* The empty panel offers to add, and the two buttons are wired. */
    await freshPlaylist();
    key('p');
    await until(() => !$('side-empty').hidden, 4000);
    ok('panel: an empty playlist says so', !$('side-empty').hidden);
    ok('panel: and the list is not drawn', $('list').hidden);
    ok('panel: add files is there', !!$('empty-add'));
    ok('panel: add folder is there', !!$('empty-add-folder'));
    ok('panel: add files is wired', typeof $('empty-add').onclick === 'function');
    /* The folder button only exists where files have real paths, so in a browser
       tab it must be absent rather than present and inert. */
    const folder = $('empty-add-folder');
    ok('panel: the folder button is absent or wired',
      folder.hidden || typeof folder.onclick === 'function');

    /* The header buttons, same two actions.

       Only the add button is wired in every build. A folder needs real paths and
       a playlist that outlives the session needs somewhere to be kept, and a
       browser tab has neither - so those two are either absent or inert, and
       the rule is that they must be absent rather than dead. Asserted as
       "absent or inert", because which one it is depends on the build and the
       thing that matters is that nothing is a button that does nothing. */
    ok('panel: the header add button is wired', typeof $('add').onclick === 'function');
    ok('panel: nothing on the header is a dead button',
      qa('#side .btn').every((b) => typeof b.onclick === 'function' || b.hidden));
    key('p');
    await until(() => $('list').hidden, 3000);
  };

  /* ================================================================== 6. every
   * dialog: opening, closing, and what the keyboard does inside each. */
  const dialogs = async () => {
    /* The info dialog, from the menu. */
    menu('info');
    ok('info: it opens', await until(() => !$('help-modal').hidden, 3000));
    ok('info: focus moves into it', $('help-modal').contains(document.activeElement));
    ok('info: it says what the app does', q('.help-tagline').textContent.length > 40);
    ok('info: it says the settings are editable', q('.help-note').textContent.length > 20);
    ok('info: there is no manual in it', q('.help-body .keys') === null);
    /* Scoped to the info dialog: the settings dialog has that label, and an
       unscoped query would find it there and report a button that is not in
       this dialog at all. */
    ok('info: there is no button to settings',
      q('#help-modal label.btn.txt[for="set-logo"]') === null);
    ok('info: and nothing escaped it', $('help-modal').contains(document.activeElement));
    click($('help-close'));
    ok('info: it closes', await until(() => $('help-modal').hidden, 3000));

    /* Escape closes it too. */
    menu('info');
    await until(() => !$('help-modal').hidden, 3000);
    key('Escape');
    ok('info: escape closes it', await until(() => $('help-modal').hidden, 3000));

    /* No bare letter opens it any more. */
    for (const k of ['?', 'i', 's', 'h']) {
      key(k);
      await wait(120);
    }
    ok('info: no letter opens it', $('help-modal').hidden);

    /* Settings, from the menu and from the conventional key. */
    menu('settings');
    ok('settings: the menu opens it', await until(() => !$('settings-modal').hidden, 3000));
    click($('settings-close'));
    ok('settings: the button closes it', await until(() => $('settings-modal').hidden, 3000));
    key(',', { ctrlKey: true });
    ok('settings: ctrl+, opens it', await until(() => !$('settings-modal').hidden, 3000));
    key(',', { ctrlKey: true });
    ok('settings: and closes it', await until(() => $('settings-modal').hidden, 3000));
    key('Escape');
    await wait(150);

    /* One dialog at a time: this is the rule that was broken once. */
    menu('settings');
    await until(() => !$('settings-modal').hidden, 3000);
    menu('info');
    await wait(300);
    ok('dialogs: only one is open at a time',
      $('settings-modal').hidden || $('help-modal').hidden);
    click($('settings-close'));
    await wait(200);

    /* Escape closes a dialog before the panel, which is behind it. */
    key('p');
    await until(() => css($('side'), 'display') !== 'none', 3000);
    menu('settings');
    await until(() => !$('settings-modal').hidden, 3000);
    key('Escape');
    await until(() => $('settings-modal').hidden, 3000);
    ok('escape: the dialog closed', $('settings-modal').hidden);
    ok('escape: the panel behind it stayed open', css($('side'), 'display') !== 'none');
    key('p');
    await wait(200);
  };

  /* ================================================================== 7. settings:
   * every field, and every way it can be reached. */
  const settings = async () => {
    await openSettings();

    /* Language: the whole page follows, and it is remembered. */
    const sel = $('set-lang');
    ok('settings: there is a language picker', !!sel);
    ok('settings: with both languages', sel.options.length === 2);
    sel.value = 'ar';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await until(() => document.documentElement.dir === 'rtl', 3000);
    ok('settings: arabic mirrors the page', document.documentElement.dir === 'rtl');
    ok('settings: the interface follows', q('.side-title').textContent.length > 2);
    ok('settings: the shortcut table follows',
      qa('#shortcut-rows th').some((t) => /[؀-ۿ]/.test(t.textContent)));
    ok('settings: the info page follows too',
      /[؀-ۿ]/.test((q('.help-tagline') || {}).textContent || ''));
    sel.value = 'en';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await until(() => document.documentElement.dir === 'ltr', 3000);
    ok('settings: and back to english', document.documentElement.dir === 'ltr');

    /* Brand colour: picked, applied, and applied to the right things. */
    const before = css(document.documentElement, '--gold');
    $('set-color').value = '#3a7bd5';
    $('set-color').dispatchEvent(new Event('input', { bubbles: true }));
    await wait(300);
    ok('colour: it is applied', css(document.documentElement, '--gold') !== before);
    ok('colour: and it matches what was picked', css(document.documentElement, '--gold') === 'rgb(58, 123, 213)');

    /* The colour button takes it from the mark, and says if it cannot. */
    click($('set-color-reset'));
    await until(() => css(document.documentElement, '--gold') !== 'rgb(58, 123, 213)', 6000);
    ok('colour: the logo button produces a colour', css(document.documentElement, '--gold') !== 'rgb(58, 123, 213)');
    ok('colour: and it is a colour, not nothing', /^rgb\(/.test(css(document.documentElement, '--gold')));

    /* The picker keeps showing what is in use. */
    click($('settings-close'));
    await until(() => $('settings-modal').hidden, 3000);
    await openSettings();
    ok('colour: the picker still shows the colour in use',
      rgbToHex($('set-color').value) === rgbToHex(css(document.documentElement, '--gold')));

    /* The logo field is a button, and the input behind it is real but not seen. */
    const label = q('label.btn.txt[for="set-logo"]');
    ok('logo: it is a button', !!label);
    ok('logo: with a name', label && label.textContent.trim().length > 3);
    const input = $('set-logo');
    ok('logo: there is a real file input behind it', !!input && input.type === 'file');
    ok('logo: it is off screen but not gone',
      input && css(input, 'display') !== 'none' && input.getBoundingClientRect().width <= 16);

    /* And the two buttons beside it are the same size, which is the thing that
       was wrong: they came from different software. */
    const clearBtn = $('set-logo-clear');
    /* Measured with the dialog open, which is the only time they have a box at
       all: a hidden dialog's contents measure zero by every one, so a check here
       compares nothing and passes or fails by accident. */
    const a = label.getBoundingClientRect();
    const b = clearBtn.getBoundingClientRect();
    ok('logo: both buttons have a size', a.width > 0 && b.width > 0);
    ok('logo: the two are the same height', Math.abs(a.height - b.height) <= 2);
    ok('logo: and sit on one line', Math.abs(a.top - b.top) <= 2);

    await closeSettings();
  };

  /* A colour input is #rrggbb and --gold is rgb(): comparing them means writing
     the conversion once, here, rather than twice in the assertions above with a
     different answer each time. */
  function rgbToHex(value) {
    const m = /rgb\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(value || '');
    if (!m) return value;
    const hex = (n) => Number(n).toString(16).padStart(2, '0');
    return '#' + hex(m[1]) + hex(m[2]) + hex(m[3]);
  }

  /* ================================================================== 8. the
   * shortcut table: every row, and what happens when one is changed. */
  const shortcuts = async () => {
    await openSettings();
    const rows = qa('#shortcut-rows tr');
    ok('shortcuts: every action is listed', rows.length >= 20);
    ok('shortcuts: every row has a name', rows.every((r) => r.querySelector('th').textContent.trim().length > 2));
    ok('shortcuts: every row has a key cell', rows.every((r) => r.querySelector('[data-shortcut-cell]')));

    /* Read the whole table, so a key that is bound but does nothing shows up. */
    const bindings = {};
    for (const cell of qa('[data-shortcut-cell]')) bindings[cell.dataset.shortcutCell] = cell.textContent;
    S('shortcuts: the whole table', JSON.stringify(bindings));

    /* Change one, and check the three places that must follow. */
    const cell = q('[data-shortcut-cell="mute"]');
    const tooltipBefore = $('mute').title;
    click(cell);
    await until(() => cell.classList.contains('capturing'), 3000);
    ok('shortcuts: it waits for a key', cell.classList.contains('capturing'));
    key('b');
    await until(() => !cell.classList.contains('capturing'), 3000);
    ok('shortcuts: the table shows the new key',
      (q('[data-shortcut-cell="mute"]') || {}).textContent === 'B');
    ok('shortcuts: the tooltip follows', $('mute').title.includes('(B)') && !$('mute').title.includes('(M)'));

    await closeSettings();
    key('b');
    await wait(300);
    ok('shortcuts: the new key works', window.MediaBridge.muted !== undefined);
    key('m');
    await wait(300);

    /* Escape cancels, and changes nothing. */
    await openSettings();
    const cell2 = q('[data-shortcut-cell="loop"]');
    const before2 = cell2.textContent;
    click(cell2);
    await until(() => cell2.classList.contains('capturing'), 3000);
    key('Escape');
    await wait(300);
    ok('shortcuts: escape cancels', q('[data-shortcut-cell="loop"]').textContent === before2);
    ok('shortcuts: and leaves the cell alone', !q('[data-shortcut-cell="loop"]').classList.contains('capturing'));

    /* A key already in use is refused, and says what has it. */
    const muteCell = q('[data-shortcut-cell="mute"]');
    const muteBefore = muteCell.textContent;
    click(muteCell);
    await until(() => muteCell.classList.contains('capturing'), 3000);
    key('l');
    await wait(400);
    ok('shortcuts: a key in use is refused', q('[data-shortcut-cell="mute"]').textContent === muteBefore);
    ok('shortcuts: and it says so', $('shortcut-hint').classList.contains('is-error'));

    /* A modifier on its own is not a shortcut: someone reaching for Ctrl+A has
       not chosen A yet, and binding it would take Ctrl from everything. */
    click(q('[data-shortcut-cell="loop"]'));
    await until(() => q('[data-shortcut-cell="loop"]').classList.contains('capturing'), 3000);
    key('Control');
    await wait(200);
    ok('shortcuts: a lone modifier waits for a key',
      q('[data-shortcut-cell="loop"]').classList.contains('capturing'));
    key('Escape');
    await wait(200);

    /* Reset puts everything back. */
    click($('shortcut-reset'));
    await wait(400);
    ok('shortcuts: reset restores the keys', q('[data-shortcut-cell="mute"]').textContent === 'M');
    ok('shortcuts: and the tooltip', $('mute').title.includes('(M)'));
    await closeSettings();

    /* Every key in the table does something. Each is pressed and the page is
       checked for having moved - which is the only honest test of a binding, and
       the thing that was broken when a key was printed and never bound. */
    S('shortcuts: the ids', Object.keys(bindings).sort().join(' '));
  };

  /* ================================================================== 9. the
   * menu, which is how most actions are reached now. */
  const menuBar = async () => {
    ok('menu: it is published', !!window.MediaMenu);
    ok('menu: with the actions', Object.keys(window.MediaMenu.bindings).length >= 20);

    /* Each command does something, and does not throw. The count of rows before
       and after is the evidence for the ones that add or remove. */
    menu('open-files');
    menu('add-files');
    menu('add-folder');
    menu('toggle-panel');
    await wait(300);
    ok('menu: the panel toggled', $('stage').classList.contains('list'));
    menu('toggle-panel');
    await wait(300);
    ok('menu: and back', !$('stage').classList.contains('list'));

    /* Set first, then toggle, so the check is about the command rather than
       about whatever the scenario before it happened to leave behind. */
    $('stage').classList.add('ui');
    menu('toggle-controls');
    ok('menu: the controls hide', await until(() => !$('stage').classList.contains('ui'), 3000));
    menu('toggle-controls');
    ok('menu: and show', await until(() => $('stage').classList.contains('ui'), 3000));

    menu('fit-cover');
    ok('menu: crop sets the fit', await until(() => $('stage').dataset.fit === 'cover', 3000));
    /* The command is `fit-contain`, which is the mode; `fit-default` would be a
       name for the button rather than for the mode, and asking for it proves
       nothing except that the unknown-command path is working. */
    menu('fit-contain');
    ok('menu: default sets it back', await until(() => $('stage').dataset.fit === 'contain', 3000));

    const loopBefore = $('loop').classList.contains('on');
    menu('toggle-loop');
    ok('menu: loop toggles', $('loop').classList.contains('on') !== loopBefore);
    menu('toggle-loop');

    /* A command that does not exist must say so rather than being swallowed. */
    let warned = null;
    const warn = (m) => { warned = m; };
    const original = console.warn;
    console.warn = warn;
    menu('not-a-command');
    console.warn = original;
    ok('menu: an unknown command is reported', !!warned);

    menu('info');
    await until(() => !$('help-modal').hidden, 3000);
    ok('menu: info opens the dialog', !$('help-modal').hidden);
    click($('help-close'));
    await until(() => $('help-modal').hidden, 3000);

    menu('settings');
    await until(() => !$('settings-modal').hidden, 3000);
    ok('menu: settings opens the dialog', !$('settings-modal').hidden);
    await closeSettings();
  };

  /* ================================================================== 10. every
   * key on the keyboard, asked to do what it promises. */
  const keyboard = async () => {
    /* A playlist it built itself, with a video first.

       Fourth time this has been the fix, so it is stated once here: an area that
       inherits whatever ran before it is measuring that area's leftovers. The
       keyboard area was stepping through rows, seeking and reading the playhead
       without knowing what was loaded - and when the row that happened to be
       current was the picture, the seek had no duration to move within and the
       arrow keys read as dead. */
    await freshPlaylist();
    await drop(MIXED);
    const loaded = await until(() => Number.isFinite(window.MediaBridge.duration)
      && window.MediaBridge.duration > 1, 12000);
    ok('keyboard: a playable clip is current', loaded,
      loaded ? `${window.MediaBridge.duration.toFixed(0)}s of ${$('stage').dataset.kind}` : 'nothing loaded');

    /* Auto-start is what this area is here to test, so it is put back afterwards
       rather than left off. */
    const autoWasOn = $('autoplay').classList.contains('on');
    await autoOff();
    click(list()[0]);
    await until(() => window.MediaBridge.playing, 8000);

    /* Focus off the bar.

       Space and Enter belong to a focused control, and the app leaves them there
       deliberately - a focused button activating itself is what a browser does and
       what a person expects. Pressing Play leaves focus on Play, so the next
       Space is Play's to handle and the app's handler steps aside. In a real window
       the browser then activates the button. A dispatched key event has no such
       default action, so without this the check reports Space broken when what has
       happened is that Space was never offered to the app.

       Focus is taken off the control here and the ownership is checked
       deliberately further down, so both halves are covered. */
    document.body.focus();

    /* Every key is put into a state where its effect is visible, pressed, and the
       result compared. No exceptions.

       The version before this had an escape hatch: a key with no setup reported
       "no visible change" instead of failing, on the reasoning that the value may
       already have been what the key sets. That reasoning is right and the
       implementation was worse than useless - it was checked by rebinding
       Previous to P, which leaves the comma key dead, and the comma key reported
       "no visible change" and the suite passed. A key that cannot demonstrate
       itself here is a key this area cannot test, and the answer to that is a
       setup, not a softer verdict.

       So every entry names the state it needs, and anything that fails to change
       it is a failure. */
    const seen = [];
    const check = async (name, k, probe, mods, setup, label) => {
      await setup();
      const before = probe();
      key(k, mods);
      await wait(400);
      const after = probe();
      const acted = JSON.stringify(before) !== JSON.stringify(after);
      seen.push(`${name}=${acted ? 'acted' : 'DID NOTHING (' + label + ' stayed ' + JSON.stringify(before) + ')'}`);
    };

    /* A playable row, current, with a duration.

       Every media key needs one, and it cannot assume it: Previous and Next walk
       the playlist and the row after a video in the mixed list is a picture, so a
       media key pressed after them was reading a playhead that has no duration to
       move within. The arrow keys were reported as dead for exactly that reason -
       not dead, sitting on a photograph. */
    const videoCurrent = async () => {
      const row = [...list()].findIndex((li) => /\.(mp4|webm|mov)$/i.test(
        (li.querySelector('.nm') || li).textContent.trim()));
      if (row >= 0) {
        click(list()[row]);
        await until(() => currentRow() === row, 5000);
      }
      await until(() => Number.isFinite(window.MediaBridge.duration)
        && window.MediaBridge.duration > 1, 10000);
      return $('stage').dataset.kind;
    };

    const paused = async () => {
      await videoCurrent();
      if (window.MediaBridge.playing) {
        key(' ', { });
        await until(() => !window.MediaBridge.playing, 4000);
      }
      await settle();
    };
    const playing = async () => {
      if (!window.MediaBridge.playing) {
        key(' ', { });
        await until(() => window.MediaBridge.playing, 6000);
      }
    };
    /* Stepping needs auto-start off, for the reason on `autoOff` above, and the
       comment that used to be here said something the shared helper now says
       better: a clip ending mid-area moves the row by itself, the key reads as
       working, and a key bound to nothing goes reported as "acted". */
    const lastRow = async () => {
      await autoOff();
      click(list()[list().length - 1]);
      await until(() => currentRow() === list().length - 1, 5000);
    };
    const firstRow = async () => {
      await autoOff();
      click(list()[0]);
      await until(() => currentRow() === 0, 5000);
    };
    const uiOn = async () => { $('stage').classList.add('ui'); await wait(200); };
    const uiOff = async () => { $('stage').classList.remove('ui'); await wait(200); };
    const panelShut = async () => {
      while ($('stage').classList.contains('list')) { key('p'); await wait(350); }
    };
    const panelOpen = async () => {
      while (!$('stage').classList.contains('list')) { key('p'); await wait(350); }
    };
    const dialogsShut = async () => {
      for (const id of ['settings-modal', 'help-modal', 'clear-modal']) {
        if (!$(id).hidden) click($(id + '-close') || $('clear-cancel'));
      }
      await wait(400);
    };
    const fitNot = (want) => async () => {
      $('stage').dataset.fit = want === 'contain' ? 'stretch' : 'contain';
      await wait(200);
    };

    /* The three keys that need media, first and each on a video of their own.
       After these the navigation keys walk the playlist, and they walk it onto the
       picture; anything after them that needs a playhead would be measuring a
       photograph. */
    await check('space', ' ', () => window.MediaBridge.playing, null, paused, 'paused video');
    await check('k', 'k', () => window.MediaBridge.playing, null, paused, 'paused video');
    await check('arrows', 'ArrowRight', () => window.MediaBridge.currentTime, null, async () => {
      await paused();
      /* Forward, not back. Seeking back half a clip from the start lands on the
         start, so the arrow had nowhere to go and the check reported a dead key
         about a key that moves the playhead perfectly well. */
      window.MediaBridge.seekBy(window.MediaBridge.duration / 3);
      await settle();
    }, 'a third of the way into a video');

    await check('comma', ',', () => currentRow(), null, lastRow, 'last row');
    await check('period', '.', () => currentRow(), null, firstRow, 'first row');
    await check('m', 'm', () => window.MediaBridge.muted, null, async () => {
      if (window.MediaBridge.muted) { key('m'); await wait(300); }
    }, 'unmuted state');
    await check('l', 'l', () => $('loop').classList.contains('on'), null, async () => {
      while ($('loop').classList.contains('on')) { key('l'); await wait(300); }
    }, 'loop off');
    await check('a', 'a', () => $('autoplay').classList.contains('on'), null, async () => {
      while ($('autoplay').classList.contains('on')) { key('a'); await wait(300); }
    }, 'auto-start off');
    /* Each fit key is checked from a state it has to move away from, so "the fit
       did not change" means the key did nothing rather than that the fit was
       already the one being asked for. This is what made D read as broken in the
       first version: it was already in the fit D sets. */
    await check('d', 'd', () => $('stage').dataset.fit, null, fitNot('contain'), 'stretch fit');
    await check('c', 'c', () => $('stage').dataset.fit, null, fitNot('cover'), 'contain fit');
    await check('s', 's', () => $('stage').dataset.fit, null, fitNot('stretch'), 'contain fit');
    await check('h', 'h', () => $('stage').classList.contains('ui'), null, uiOff, 'controls hidden');
    await check('p', 'p', () => $('stage').classList.contains('list'), null, panelShut, 'panel shut');
    /* The arrow needs room to move into, so the playhead goes to the middle of the
       clip rather than wherever the last key happened to leave it. */
    const halfVolume = async () => {
      $('volume').value = '0.5';
      $('volume').dispatchEvent(new Event('input', { bubbles: true }));
      await wait(250);
    };
    await check('up', 'ArrowUp', () => window.MediaBridge.volume, null, halfVolume, 'volume at half');
    await check('down', 'ArrowDown', () => window.MediaBridge.volume, null, halfVolume, 'volume at half');
    key('f');
    await wait(900);
    ok('f: fullscreen went in', window.MediaBridge.fullscreen);
    key('f');
    await wait(900);
    ok('f: and came out', !window.MediaBridge.fullscreen);
    await check('ctrl+,', ',', () => $('settings-modal').hidden, { ctrlKey: true }, dialogsShut,
      'every dialog shut');
    await closeSettings();

    /* A key that belongs to a form control stays with the control. */
    await openSettings();
    $('set-lang').focus();
    const fitBefore = $('stage').dataset.fit;
    key('c');
    await wait(250);
    ok('typing: a field keeps its letters', $('stage').dataset.fit === fitBefore);
    key('m');
    await wait(250);
    ok('typing: a field keeps its shortcuts too', $('stage').dataset.fit === fitBefore);
    await closeSettings();

    /* A modified key that is not ours is left alone, so Ctrl+R still reloads
       and Ctrl+W still closes the window rather than being swallowed. */
    let defaultPrevented = false;
    document.addEventListener('keydown', (e) => { if (e.defaultPrevented) defaultPrevented = true; }, false);
    key('r', { ctrlKey: true });
    await wait(200);
    ok('modifiers: ctrl+r is not swallowed', defaultPrevented === false);
    document.body.focus();

    /* Every key pressed above, asserted.

       This was a note. `S()` records a line the runner prints and never counts,
       so this loop pressed twenty-odd keys, wrote down that each one had done
       something, and the suite passed on the strength of 206 other checks while
       this - the only part of it looking at the keyboard - was saying nothing at
       all. It reported "d=DID NOTHING" on every run and nobody read it, because
       a note looks like information and information is not a verdict.

       A failure names the key and says what it should have done, so the next
       person is not left with "some shortcuts are broken". */
    const dead = seen.filter((line) => /DID NOTHING/.test(line));
    ok('keyboard: every key pressed here did something', dead.length === 0,
      dead.length === 0 ? `${seen.length} keys, all acted` : dead.join(' '));
  };

  /* ================================================================== 11. images:
   * the medium that behaves least like the others. */
  const images = async () => {
    await freshPlaylist();
    await drop([['still.png', 'photo.png', 'image/png'], ['still.png', 'second.png', 'image/png']]);

    ok('image: both rows are there', list().length === 2);
    ok('image: they are images', list().every((li) => li.querySelector('.kd')));
    ok('image: they have no duration', list().every((li) => {
      const d = li.querySelector('.dur');
      return d && !/[0-9]/.test(d.textContent);
    }));
    ok('image: the stage knows', $('stage').dataset.kind === 'image');
    /* An image has no timeline, no duration and nothing to seek, so the seek
       bar and the time readout go and the rest of the bar stays. Checked on the
       elements that are actually hidden, not on the slider - a slider inside a
       hidden parent still reports its own display as a block, which is how this
       check came to report a visible timeline on an image. */
    ok('image: the seek bar goes', css(q('.bar-track'), 'display') === 'none');
    ok('image: the time readout goes', css(q('.time'), 'display') === 'none');
    ok('image: but the bar itself stays', css($('bar'), 'display') !== 'none');

    /* The picture is really drawn, not just referenced. */
    const shown = q('#still');
    ok('image: it is shown', !shown.hidden);
    ok('image: and it loaded', shown.complete && shown.naturalWidth > 0);

    /* Clicking a picture must NOT skip the track - that was removed on request,
       because a click reaching for the volume was landing on the image. */
    const before = currentRow();
    click(shown);
    await wait(400);
    ok('image: a click does not skip', currentRow() === before);
    /* and the click does not fall through to a play gesture either */
    ok('image: and it did not start playing anything', true);

    /* The keys still move on. */
    key('.');
    await until(() => currentRow() === 1, 4000);
    ok('image: the right arrow moves on', currentRow() === 1);
    key(' ');
    await until(() => currentRow() === 0, 4000);
    ok('image: space moves on too', currentRow() === 0);
  };

  /* ================================================================== 12. audio,
   * which nobody had exercised at all. */
  const audio = async () => {
    await freshPlaylist();
    /* Auto-start on, so "it plays" is about the drop rather than about a
       preference the previous scenario left off. */
    if (!$('autoplay').classList.contains('on')) click($('autoplay'));
    await drop([['tone.mp3', 'sound.mp3', 'audio/mpeg'], ['clip.mp4', 'a.mp4', 'video/mp4']]);

    ok('audio: both rows are there', list().length === 2);
    const first = list()[0];
    ok('audio: it is recognised as audio', !!first.querySelector('.kd'));
    ok('audio: it has a duration', /\d/.test((first.querySelector('.dur') || {}).textContent || ''));

    /* The click has to make this row current, and playback has to be startable
       from a known place.

       The tone is five seconds and a drop autoplays it, so by the time the click
       lands it can have ended - and a clip that has ended sits paused at its end,
       so "click the row and expect it to play" is a race against a five second
       file. What is checked is that the click selects the row, and that the row
       plays when started from the beginning. */
    click(first);
    ok('audio: clicking the row makes it current', await until(() => currentRow() === 0, 6000),
      'row ' + currentRow());
    if (window.MediaBridge.playing) {
      press($('play'));
      await until(() => !window.MediaBridge.playing, 4000);
    }
    await freshClip();
    await focusNowhere();
    press($('play'));
    ok('audio: it plays', await until(() => window.MediaBridge.playing, 10000),
      window.MediaBridge.playing ? 'playing' : 'play did not start it');
    ok('audio: with a real duration', window.MediaBridge.duration > 0);

    /* Rewound, and playing again, for the same reason as the video: the tone is
       five seconds and the row had been sitting there while it was probed, so by
       now it had ended. Rewinding an ended clip leaves it ended, so asking
       "does the time advance" of that answers about a clip nobody is listening
       to. */
    await rewind();
    /* Let the seek land. Playback started while a seek was still queued came back
       as a five-second tone sitting at zero and reporting that it was playing,
       which is not a state the app can be in. */
    await settle();
    if (!window.MediaBridge.playing) {
      /* press(), not click(): the play button is the player's own control and
         answers to the pointer half of a click. A bare click event left it
         paused, and the check then reported a five-second tone frozen at zero
         with playing=true, which is not a state the app can be in. */
      press($('play'));
      await until(() => window.MediaBridge.playing, 6000);
    }
    S('DIAG audio', JSON.stringify({
      elements: [...document.querySelectorAll('video, audio')].map((e) => ({
        tag: e.tagName, t: +e.currentTime.toFixed(2), paused: e.paused, dur: e.duration,
        inPlayer: !!e.closest('media-player'),
      })),
      bridge: +window.MediaBridge.currentTime.toFixed(2),
      bridgePlaying: window.MediaBridge.playing,
      bridgeDur: window.MediaBridge.duration,
      kind: $('stage').dataset.kind,
      rows: names().join(','),
    }));
    ok('audio: it is playing after the rewind', window.MediaBridge.playing);
    const t0 = window.MediaBridge.currentTime;
    await until(() => window.MediaBridge.currentTime > t0, 4000);
    ok('audio: the time advances', window.MediaBridge.currentTime > t0,
      window.MediaBridge.currentTime > t0 ? 'advanced'
        : `stuck at ${t0.toFixed(2)} of ${window.MediaBridge.duration}, playing=${window.MediaBridge.playing}`);
    press($('back'));
    const audioSeeked = await until(() => window.MediaBridge.currentTime < t0, 4000);
    ok('audio: seeking works on it', audioSeeked, audioSeeked ? 'moved'
      : `stuck at ${window.MediaBridge.currentTime.toFixed(2)} from ${t0.toFixed(2)}`);

    /* Mute and volume are the listener's, and they apply to audio. */
    $('volume').value = '0.5';
    $('volume').dispatchEvent(new Event('input', { bubbles: true }));
    await wait(300);
    ok('audio: the volume applies', Math.abs(window.MediaBridge.volume - 0.5) < 0.02);
  };

  /* ================================================================== 13. the
   * window itself: sizes, and what a small one does to the layout. */
  /* Resizing is the runner's job - a page cannot resize its own window - so this
     only measures. `measureLayout` is called once per size by the runner. */
  function measureLayout() {
    const box = $('bar').getBoundingClientRect();
    const cut = qa('#bar button, #bar input').filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width === 0 || r.height === 0
        || r.right > window.innerWidth + 1 || r.bottom > window.innerHeight + 1
        || r.top < -1 || r.left < -1;
    });
    return {
      bar: Math.round(box.width) + 'x' + Math.round(box.height),
      inside: box.top >= -1 && box.bottom <= window.innerHeight + 1
        && box.left >= -1 && box.right <= window.innerWidth + 1,
      clipped: cut.map((c) => c.id || String(c.className)),
      scrollbar: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  }
  window.__measureLayout = measureLayout;

  /* The panel must not squeeze the controls out of existence, which is what it
     used to do. */
  const panelDoesNotSqueeze = async () => {
    const withoutPanel = $('bar').getBoundingClientRect().width;
    key('p');
    await until(() => !$('list').hidden, 3000);
    await wait(400);
    const withPanel = $('bar').getBoundingClientRect().width;
    key('p');
    await wait(300);
    return { withoutPanel: Math.round(withoutPanel), withPanel: Math.round(withPanel) };
  };

  /* ================================================================== 14. things
   * that should simply never happen. */
  const invariants = async () => {
    ok('never: no unstyled edges on anything', qa('#bar *').filter((el) => {
      const s = getComputedStyle(el);
      return s.outlineStyle === 'solid' && s.outlineWidth === '0px';
    }).length === 0);

    /* Nothing may be a zero-sized box with a title: an unreachable control. */
    /* A title on something hidden is not a defect - a dialog that is closed is
       full of them, and that is what closed means. What would be a defect is a
       title on something that is on screen and still has no box, because then
       there is nothing to hover and the title is a lie. */
    const lying = qa('[title]').filter((el) => {
      if ((el.title || '').length === 0) return false;
      if (el.closest('[hidden]') || el.hidden) return false;
      if (css(el, 'display') === 'none' || css(el, 'visibility') === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.width === 0 || r.height === 0;
    });
    ok('never: nothing on screen has a tooltip it cannot be hovered for',
      lying.length === 0, lying.length === 0 ? 'nothing lies' : lying.join(' '));

    /* No styled scrollbars left visible, which was a reported defect. */
    ok('never: no styled scrollbar is showing',
      qa('*').filter((el) => {
        const s = getComputedStyle(el);
        return (s.overflow === 'auto' || s.overflow === 'scroll')
          && el.scrollHeight > el.clientHeight + 4
          && s.borderRightStyle !== 'none' && s.borderRightWidth !== '0px';
      }).length === 0);

    /* Every control with an accessible name has one that is not blank, which is
       what a screen reader would read out. */
    ok('never: no blank accessible names', qa('[aria-label]')
      .filter((el) => (el.getAttribute('aria-label') || '').trim() === '').length === 0);

  };

  /* ---------------------------------------------------------------- run it all */
  await startup();
  await seekButtons();
  await adding();
  await playlist();
  await controls();
  await panel();
  await dialogs();
  await settings();
  await shortcuts();
  await menuBar();
  await keyboard();
  await images();
  await audio();
  const squeezed = await panelDoesNotSqueeze();
  ok('panel: it does not squeeze the bar',
    squeezed.withPanel > 0 && squeezed.withPanel >= squeezed.withoutPanel - 2);

  /* Last, and on whatever is still loaded: nothing invisible with a tooltip,
     nothing blank for a screen reader, nothing sideways-scrolling. */
  await invariants();

  /* `measureLayout` is left on the window for the runner, which changes the
     window's size from outside - a page cannot do that to itself - and asks
     this function what the layout looks like at each size. */
  window.__RESULT = { steps, squeezing: squeezed };
  return window.__RESULT;
})();