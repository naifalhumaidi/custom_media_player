/* User walkthroughs, run inside the real window.

   The unit tests answer "does this function do what it says". They cannot
   answer "can a person use this", because jsdom reports every element as
   visible whatever the viewport and has no layout at all. Two of the bugs
   reported from the desktop build were exactly the kind only a real window
   shows - controls clipped off the bottom of a fixed-height window, and a
   button that does nothing because the platform it needs is missing.

   So this drives journeys a person would drive, in the real app, at the window
   sizes people use:

     1. every control is reachable, at each size, with nothing clipped
     2. drop a file on the window and hear it play
     3. seek, pause, and have the time remembered
     4. fullscreen by keyboard, and back
     5. a moved file keeps its row rather than vanishing

   Findings are reported as a flat list of "name = value" lines, because that is
   what the shell already knows how to print and collect. The verdict line is
   the only one that matters for reading at a glance. */

(() => {
  const report = {};
  const say = (key, value) => { report[key] = value; };
  window.__DIAG__ = report;

  /* The console, kept.

     A journey can fail without throwing - the row arrives, the file does not
     load, and every line the walkthrough writes describes a symptom rather than
     a cause. The reason is nearly always one line in here, and it was being
     thrown away. Only errors and warnings are kept, because an app that logs
     freely would otherwise bury the run in its own chatter. */
  const consoleLines = [];
  for (const level of ['error', 'warn']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      try {
        consoleLines.push(`${level}: ` + args.map((a) => {
          if (a && a.stack) return String(a.stack).split('\n').slice(0, 3).join(' <- ');
          if (typeof a === 'object') { try { return JSON.stringify(a); } catch { return String(a); } }
          return String(a);
        }).join(' '));
      } catch { /* an unprintable value must not break the run */ }
      original(...args);
    };
  }

  /* One walkthrough, both shells. The Tauri build has a command channel; the
     Electron build offers the same handful of operations under its own names.
     Resolving through here rather than in the tests means a journey is written
     once and runs against whichever shell is under test - and a journey that
     only works on one of them is a journey nobody is really testing. */
  const tauri = (window.__TAURI__ && window.__TAURI__.core) || window.__TAURI_INTERNALS__;
  const walk = window.MediaShell && window.MediaShell.walkthrough;

  const invoke = tauri
    ? (cmd, args) => tauri.invoke(cmd, args || {})
    : (cmd, args) => {
      if (!walk) return Promise.reject(new Error('no walkthrough channel in this shell'));
      if (cmd === 'diagnostic_set_size') return walk.setSize(args.width, args.height);
      if (cmd === 'is_fullscreen') return walk.isFullscreen();
      if (cmd === 'diagnostic_simulate_drop') return walk.simulateDrop(args.paths);
      return Promise.reject(new Error('this shell cannot ' + cmd));
    };

  /* A real drop, by whichever route the shell under test actually has.

     The Tauri build has a command for it. The Electron build has an IPC handler
     of the same name that only returns the array length and does nothing at all,
     because Electron delivers drops to the page as a DOM event - so asking it to
     drop meant nothing was ever dropped. The run then reported
     "rows before=0 after=0", "NONE in the page" and "the file never loaded",
     and still finished PASS, because the verdict only asked whether each
     journey threw.

     The path is queued for the preload to hand back and a real DragEvent is
     dispatched at the stage, which is the same code path a user's drop takes. */
  const dropAFileOnto = async (path) => {
    if (tauri) return invoke('diagnostic_simulate_drop', { paths: [path] });

    const shell = window.MediaShell;
    const stage = document.getElementById('stage');
    if (!shell || !stage) return { dispatched: false, why: 'no shell or no stage' };

    shell.dropFilesForTest([path]);

    /* One File per path. The object is a stand-in - its bytes are never read,
       because the adapter asks the preload for the path and the preload answers
       from the queue. What the adapter needs from the File is only that there is
       one, so the drop is recognised as files rather than as nothing. */
    const dt = new DataTransfer();
    for (const p of Array.isArray(path) ? path : [path]) {
      dt.items.add(new File([new Uint8Array([0])], p.split('/').pop() || 'probe'));
    }

    const options = { bubbles: true, cancelable: true, dataTransfer: dt };
    stage.dispatchEvent(new DragEvent('dragover', options));
    stage.dispatchEvent(new DragEvent('drop', options));
    return { dispatched: true, files: dt.files.length };
  };

  /* The journeys, one after another.

     They used to be started together and left to interleave, which sounds
     cheaper and is not: one of them resizes the window through five sizes while
     another is waiting for a video to start playing, so the playback journey was
     measuring a player being dragged around underneath it, and the layout
     journey was measuring a viewport the other one kept changing. Each has its
     own ceiling, so running them in turn still ends a broken run - it just ends
     it with answers that are about the thing being asked. */
  const journeys = [];
  let queue = Promise.resolve();

  /* `fn` is called for its rejections, not by the caller. A journey that throws
     before it has written anything would otherwise leave its own line absent,
     and an absent line is what the verdict reads as "it passed". */
  const journey = (key, fn) => {
    queue = queue.then(() => Promise.resolve().then(fn).catch((err) => {
      if (err && err.__walkthroughReported) return;
      err = err || new Error('rejected with nothing');
      /* Marked so the journey's own catch, which is more specific and has
         already recorded what it was doing, does not overwrite it. */
      try { err.__walkthroughReported = true; } catch { /* frozen */ }
      say(key, 'threw: ' + (err.message || String(err)));
    }));
    journeys.push(queue);
  };

  const channel = tauri;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /* Wait for a condition rather than for a length of time.

     Fixed sleeps made this flaky in both directions: a cold start after a
     rebuild can take longer than the sleep, so a working player was reported as
     not playing. The answer is not a longer sleep - it is waiting for the thing
     being measured, with a ceiling so a genuinely broken player still ends the
     run instead of hanging it. */
  const waitFor = async (predicate, timeout, label) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      let ok = false;
      try { ok = await predicate(); } catch { ok = false; }
      if (ok) return true;
      if (Date.now() >= deadline) { say('walkthrough_timeout', `gave up waiting for ${label} after ${timeout}ms`); return false; }
      await wait(120);
    }
  };
  const probeFile = String(window.__PROBE_FILE__ || '');

  /* Sizes a person might plausibly have: a laptop, a small laptop, a
     half-screen window, and the default. The default is the one that was
     shipping, so it is the one that has to work. */
  const SIZES = [
    [1600, 1000, 'desktop'],
    [1280, 800, 'laptop'],
    [1024, 640, 'half screen'],
    [800, 520, 'small laptop'],
    [520, 440, 'very small'],
  ];

  /* Every control a person is meant to be able to reach. Read from the live DOM
     rather than a list kept here, so a control added later is covered without
     this file being edited - and so a control that is present but unreachable
     still shows up. */
  const controlSelector = [
    '.bar button', '.bar [role="button"]',
    'media-play-button', 'media-mute-button', 'media-volume-slider',
    'media-time-slider', 'media-seek-button',
    '#btn-open', '#btn-folder', '#btn-settings', '#btn-help',
    '.row .btn', '.row button',
  ].join(',');

  const isHidden = (el) => {
    if (el.hidden) return true;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return true;
    if (Number(style.opacity) === 0) return true;
    return false;
  };

  /* ---- 1. every control reachable, at each size ----------------------- */

  /* registered, so the verdict cannot be taken before it has finished */
  journey('layout_worst', async () => {
    let worst = null;

    for (const [w, h, label] of SIZES) {
      await invoke('diagnostic_set_size', { width: w, height: h });
      await wait(250);

      const viewW = document.documentElement.clientWidth;
      const viewH = document.documentElement.clientHeight;
      const problems = [];

      for (const el of document.querySelectorAll(controlSelector)) {
        if (isHidden(el)) continue;
        const r = el.getBoundingClientRect();
        /* Zero-sized: present in the DOM, usable by nobody. */
        if (r.width < 1 || r.height < 1) {
          problems.push(`${describe(el)} has no size`);
          continue;
        }
        if (r.right > viewW + 1 || r.bottom > viewH + 1 || r.left < -1 || r.top < -1) {
          problems.push(`${describe(el)} is outside the window (${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)} in ${viewW}x${viewH})`);
        }
      }

      /* The stage is where the video goes. Zero height here is a player that
         cannot show anything, which looks exactly like "video does not play". */
      const stage = document.getElementById('stage');
      const sr = stage ? stage.getBoundingClientRect() : { width: 0, height: 0 };
      if (sr.width < 40 || sr.height < 40) {
        problems.push(`the stage is ${Math.round(sr.width)}x${Math.round(sr.height)}, too small to show anything`);
      }

      if (problems.length && (!worst || problems.length > worst.count)) {
        worst = { size: `${w}x${h} (${label})`, count: problems.length, problems };
      }
      say(`layout_${w}x${h}`, problems.length ? problems.join('; ') : 'all controls reachable');
    }

    if (worst) {
      say('layout_worst', `${worst.count} problem(s) at ${worst.size}: ${worst.problems.join('; ')}`);
    } else {
      say('layout_worst', 'no control is clipped at any size tested');
    }

    /* Why the widest control is wide. Guessing at this from the CSS alone
       wasted an afternoon: the rule that looks responsible is not the one that
       is binding, and only the computed values say which. */
    const probe = document.querySelector('media-time-slider');
    if (probe) {
      const chain = [];
      let node = probe;
      while (node && node !== document.documentElement) {
        const s = getComputedStyle(node);
        const r = node.getBoundingClientRect();
        chain.push(
          `${node.tagName.toLowerCase()}${node.id ? '#' + node.id : ''}${node.className && typeof node.className === 'string' && node.className.trim() ? '.' + node.className.trim().split(/\s+/)[0] : ''}` +
          ` w=${Math.round(r.width)} display=${s.display} flex=${s.flex} minW=${s.minWidth} maxW=${s.maxWidth} width=${s.width} overflow=${s.overflow}`
        );
        node = node.parentElement;
      }
      say('layout_probe_time_slider', chain.join('  ||  '));
    }

    /* The container question, asked directly: if the player is wider than the
       stage, every control inside it is drawn off screen and clipped, and no
       amount of flex tuning inside the player will bring them back. */
    await invoke('diagnostic_set_size', { width: 800, height: 520 });
    await wait(400);
    const describeBox = (el) => {
      if (!el) return 'absent';
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''} rect=${Math.round(r.width)}x${Math.round(r.height)}` +
        ` position=${s.position} width=${s.width} inset=${s.top}/${s.right}/${s.bottom}/${s.left}` +
        ` inline="${el.getAttribute('style') || ''}"`;
    };
    say('layout_probe_containers',
      [describeBox(document.documentElement), describeBox(document.body),
        describeBox(document.getElementById('stage')), describeBox(document.getElementById('media')),
        describeBox(document.querySelector('.bar'))].join('  ||  '));

    /* Which element is actually demanding the width. Every box in the bar,
       widest last, so the answer is a name rather than a theory. */
    const widest = [];
    for (const el of document.querySelectorAll('.bar, .bar *')) {
      const r = el.getBoundingClientRect();
      widest.push({ w: Math.round(r.width), el });
    }
    widest.sort((a, b) => b.w - a.w);
    {
      const m = document.getElementById('media');
      const s = m ? getComputedStyle(m) : null;
      say('layout_probe_var', s
        ? `--player-width=${s.getPropertyValue('--player-width').trim() || '(empty)'}` +
          ` --media-width=${s.getPropertyValue('--media-width').trim() || '(empty)'}` +
          ` width=${s.width} maxW=${s.maxWidth}`
        : 'no #media');
      /* Is our stylesheet even loaded? A stylesheet with one bad declaration can
         be dropped whole, which looks exactly like "my fix had no effect". */
      const sheets = Array.from(document.styleSheets).map((x) => {
        let rules = 'unreadable';
        try { rules = String(x.cssRules.length); } catch { /* cross-origin */ }
        return `${(x.href || 'inline').split('/').pop()}[${rules}]`;
      });
      say('layout_probe_sheets', sheets.join(' '));
    }

    say('layout_probe_widest', widest.slice(0, 6).map((entry) => {
      const el = entry.el;
      const s = getComputedStyle(el);
      return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}` +
        `${typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/)[0] : ''}` +
        `=${entry.w} flex=${s.flex} minW=${s.minWidth} ws=${s.whiteSpace}`;
    }).join('  |  '));

    /* A window that cannot be resized is its own defect: anything the layout
       clips becomes permanently unreachable. */
    const before = document.documentElement.clientWidth;
    await invoke('diagnostic_set_size', { width: before - 120, height: 600 });
    await wait(200);
    const after = document.documentElement.clientWidth;
    /* The numbers go in the line. "NO" on its own cannot be told apart from a
       window manager that would not let the test resize the window, from a
       window that genuinely cannot be resized, and from a viewport that did not
       follow the window - three different things and one word. */
    say('window_resizable', after !== before
      ? `yes (${before} -> ${after})`
      : `NO - asked for ${before - 120} wide, viewport stayed ${before}`);

    await invoke('diagnostic_set_size', { width: 1280, height: 800 });
    await wait(200);

    function describe(el) {
      const id = el.id ? '#' + el.id : '';
      const cls = el.className && typeof el.className === 'string'
        ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
        : '';
      return el.tagName.toLowerCase() + id + cls;
    }
  });   /* rejections are caught inside journey() */

  /* ---- 2, 3. drop a file and play it --------------------------------- */

  /* registered, so the verdict cannot be taken before it has finished */
  journey('walkthrough_play', async () => {
    if (!probeFile) {
      say('walkthrough_play', 'no probe file supplied');
      return;
    }
    const bridge = window.MediaBridge;
    if (!bridge) {
      say('walkthrough_play', 'no bridge');
      return;
    }

    const before = document.querySelectorAll('#list li').length;
    await dropAFileOnto(probeFile);
    /* Until the player knows the file. `duration` is the honest signal: a
       playlist can contain the row while the media has not loaded yet, and
       treating that as "loaded" is how a real failure gets missed. */
    await waitFor(() => Number.isFinite(bridge.duration) && bridge.duration > 0, 12000, 'the file to load');

    /* Did it reach the playlist? */
    const rows = document.querySelectorAll('#list li').length;
    say('walkthrough_drop', `rows before=${before} after=${rows}`);

    /* The player's own state, which is the only honest answer to "does it
       play". A <video> element with a src says nothing about whether the app's
       player started it. */
    await bridge.play();
    await waitFor(() => bridge.playing && bridge.currentTime > 0, 8000, 'playback to start');

    /* Every media element on the page, not just the first one found. Vidstack
       wraps a real <video> in its own custom element, and a query that stops at
       the wrapper reports an empty element that was never going to play - which
       reads exactly like "video does not work". */
    const allMedia = [];
    for (const el of document.querySelectorAll('video, audio')) {
      const r = el.getBoundingClientRect();
      allMedia.push(
        `<${el.tagName.toLowerCase()}> src=${String(el.currentSrc || el.src || '(none)').slice(0, 60)} ` +
        `readyState=${el.readyState} networkState=${el.networkState} ` +
        `paused=${el.paused} error=${el.error ? el.error.code : 'none'} ` +
        `box=${Math.round(r.width)}x${Math.round(r.height)} ` +
        `inside=${el.parentElement ? el.parentElement.tagName.toLowerCase() : 'none'}`
      );
    }
    say('walkthrough_media_elements', allMedia.length ? allMedia.join(' | ') : 'NONE in the page');
    say('walkthrough_bridge_element', (() => {
      const m = document.getElementById('media');
      if (!m) return 'no #media element';
      const r = m.getBoundingClientRect();
      return `<${m.tagName.toLowerCase()}> box=${Math.round(r.width)}x${Math.round(r.height)}`;
    })());

    const video = document.querySelector('video');
    if (video) {
      say('walkthrough_media_src', String(video.currentSrc || video.src || '') || 'EMPTY');
    }

    /* Volume and mute, with something loaded, answered on the element.

       The other journey checks these with an empty playlist, and can only check
       the bridge's own state there - there is no media for a setting to reach.
       This is the half that says the setting is not merely remembered: it lands
       on the video. Both halves, or the pair proves nothing between them. */
    {
      const video2 = document.querySelector('video, audio');
      const vol2 = document.getElementById('volume');
      const mute2 = document.getElementById('mute');
      if (video2 && vol2 && mute2) {
        vol2.value = '0.35';
        vol2.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(300);
        const mutedBefore = video2.muted;
        mute2.click();
        await wait(300);
        say('walkthrough_volume_and_mute_with_media',
          `element volume=${video2.volume.toFixed(2)} (asked 0.35) ` +
          `muted ${mutedBefore} -> ${video2.muted}`);
        /* Put the volume back, so the runs are comparable with each other. */
        vol2.value = '1';
        vol2.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(200);
      } else {
        say('walkthrough_volume_and_mute_with_media',
          `video=${!!video2} volume=${!!vol2} mute=${!!mute2}`);
      }
    }

    /* Rewound first, and this matters more than it looks.

       The probe clip is eight seconds long, and the journeys before this one -
       resizing the window through five sizes - take longer than that. The clip
       had already ended, so `playing` was false because the media had *finished*,
       and the report said "NO - the player is paused" on a player that had done
       exactly what it was told. Measuring a paused player and calling it broken
       is the same mistake as the one that got a whole run to say PASS. */
    if (Number.isFinite(bridge.duration) && bridge.duration > 1) {
      await bridge.seekBy(-bridge.duration);
      await wait(300);
    }

    await bridge.play();
    await waitFor(() => bridge.playing, 6000, 'playback to start after the rewind');

    const t1 = bridge.currentTime;
    await wait(1500);
    const t2 = bridge.currentTime;

    say('walkthrough_playing', bridge.playing
      ? 'yes'
      : `NO - paused at ${t2.toFixed(2)}s of ${bridge.duration}s`);
    say('walkthrough_duration', String(Math.round(bridge.duration || 0)) +
      (Number.isFinite(bridge.duration) ? '' : ' (not a number - metadata never arrived)'));
    say('walkthrough_time_advancing', t2 > t1
      ? `yes (${t1.toFixed(2)} -> ${t2.toFixed(2)})`
      : `NO - stuck at ${t2.toFixed(2)}`);

    /* Seeking, because a player that cannot seek is not a player. */
    if (bridge.duration > 1) {
      bridge.seekBy(2);
      await wait(900);
      say('walkthrough_seek', bridge.currentTime > 0.5
        ? `ok (jumped to ${bridge.currentTime.toFixed(2)}s)`
        : `NO - stayed at ${bridge.currentTime.toFixed(2)}s`);
    } else {
      say('walkthrough_seek', 'not tested - the file never loaded');
    }

    await bridge.pause();
    await wait(200);
    say('walkthrough_pause', bridge.playing ? 'NO - still playing' : 'ok');
  });   /* rejections are caught inside journey() */

  /* ---- 4. fullscreen by keyboard ------------------------------------- */

  /* registered, so the verdict cannot be taken before it has finished */
  journey('walkthrough_fullscreen', async () => {
    const fsButton = document.getElementById('fs');
    const before = await invoke('is_fullscreen');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', bubbles: true }));
    await wait(600);
    const during = await invoke('is_fullscreen');
    /* The button's own class, while fullscreen. Whether it *looks* enabled is a
       question about CSS, but whether the state reaches the class at all is a
       question about the app - and only one of those two ever gets checked. */
    say('walkthrough_fs_button_in_fullscreen',
      `window=${during} class="${fsButton ? fsButton.className : 'no button'}"`);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', bubbles: true }));
    await wait(600);
    const after = await invoke('is_fullscreen');

    say('walkthrough_fullscreen',
      before !== during && during !== after
        ? 'the f key took the window fullscreen and back'
        : `BROKEN (before=${before} during=${during} after=${after})`);

    const hook = window.MediaFullscreen;
    say('walkthrough_fullscreen_button_state',
      hook ? String(hook.active === (during && !after)) : 'no shell hook');
  });   /* rejections are caught inside journey() */

  /* ---- 5. the controls with nothing loaded ---------------------------- */

  /* A separate journey, and not part of the playback one, because it needs the
     opposite state: the playlist emptied. Reported from the desktop build as
     "I can't adjust the volume or mute it" once the list had been cleared, and
     "the progress bar is still where the last one was".

     Each control is asked directly and the answer is read off the media element
     rather than off a class name, so "the button ignored me", "the element
     refused" and "the button is not there" stay distinguishable instead of all
     arriving as "muting did not work". */
  journey('walkthrough_empty_controls', async () => {
    /* Which adapter answered, and what it says it can do. A control that is
       hidden is only meaningful next to the answer to "why" - the alternative is
       a report saying a button is missing, and no way to tell a build that
       genuinely lacks it from a wiring mistake. */
    say('walkthrough_source',
      `shell=${(window.MediaShell && window.MediaShell.shell) || 'none'} ` +
      `canPersist=${!!(window.MediaFileSource && window.MediaFileSource.canPersist && window.MediaFileSource.canPersist())} ` +
      `addFolder=${!!(window.MediaFileSource && window.MediaFileSource.openFolder)} ` +
      `clearHidden=${document.getElementById('clear-list') ? document.getElementById('clear-list').hidden : 'no button'} ` +
      `addFolderHidden=${document.getElementById('add-folder') ? document.getElementById('add-folder').hidden : 'no button'}` +
      ` addHidden=${document.getElementById('add') ? document.getElementById('add').hidden : 'no button'}` +
      ` addWired=${!!(document.getElementById('add') && document.getElementById('add').onclick)}` +
      ` clearWired=${!!(document.getElementById('clear-list') && document.getElementById('clear-list').onclick)}` +
      ` scripts=${Array.from(document.scripts).map((x) => x.src.split('/').pop()).join(',')}` +
      ` isElectron=${window.MediaFileSource === window.MediaFileSourceElectron}` +
      ` isWeb=${window.MediaFileSource === window.MediaFileSourceWeb}` +
      ` hasElectron=${!!window.MediaFileSourceElectron}` +
      ` appJs=${(document.querySelector('script[src*="app.js"]') || {}).src}`);

    const clearButton = document.getElementById('clear-list');
    if (!clearButton || clearButton.hidden) {
      say('walkthrough_empty_controls', 'no clear button in this build - see walkthrough_source');
      return;
    }
    const bridge = window.MediaBridge;
    const mediaEl = document.querySelector('video, audio');

    /* Clearing asks first, so the first click must change nothing at all. Then
       Cancel must also change nothing. Only the confirmation clears. Asking is
       the feature, so a journey that clicked straight through would be testing
       the absence of it. */
    const clearModal = document.getElementById('clear-modal');
    const rowsAtStart = document.querySelectorAll('#list li').length;
    clearButton.click();
    await wait(400);
    say('walkthrough_clear_asks',
      `asked=${!!clearModal && !clearModal.hidden} ` +
      `rows ${rowsAtStart} -> ${document.querySelectorAll('#list li').length} ` +
      `(nothing cleared yet: ${document.querySelectorAll('#list li').length === rowsAtStart}) ` +
      `focus=${document.activeElement ? document.activeElement.id : 'none'}`);

    document.getElementById('clear-cancel').click();
    await wait(300);
    say('walkthrough_clear_cancel',
      `closed=${!!clearModal && clearModal.hidden} ` +
      `rows=${document.querySelectorAll('#list li').length}`);

    clearButton.click();
    await wait(300);
    document.getElementById('clear-ok').click();
    await waitFor(() => document.querySelectorAll('#list li').length === 0, 4000,
      'the playlist to empty');

    say('walkthrough_empty_state',
      `rows=${document.querySelectorAll('#list li').length} ` +
      `bar=${getComputedStyle(document.getElementById('bar')).display} ` +
      `duration=${bridge ? bridge.duration : 'no bridge'}`);

    /* Mute and volume are asked of the bridge, not of the <video>.

       That is the correction. The bridge writes to the player element and the
       player holds the setting; there is no media for it to apply the setting
       to, which is the entire situation under test. Asking the <video> asks a
       question that has no right answer here - it would read 1.00 and unmuted
       whatever the user set, and would call a working control broken. The
       journey that has media loaded is the one that checks the <video>. */
    const muteButton = document.getElementById('mute');
    if (muteButton) {
      const wasMuted = bridge.muted;
      muteButton.click();
      await wait(350);
      say('walkthrough_mute_when_empty',
        `bridge muted ${wasMuted} -> ${bridge.muted} ` +
        `(button says muted=${muteButton.classList.contains('muted')} ` +
        `pressed=${muteButton.getAttribute('aria-pressed')}) ` +
        `${bridge.muted !== wasMuted ? 'it answered' : 'IGNORED'}`);

      /* And back, so the journeys that follow are not looking at a muted app. */
      muteButton.click();
      await wait(250);
    } else {
      say('walkthrough_mute_when_empty', 'no #mute button');
    }

    if (mediaEl) {

      const volume = document.getElementById('volume');
      if (volume) {
        const box = volume.getBoundingClientRect();
        /* A pointer at 20% along the slider: down, move, up. The library drags
           from the pointer, so a bare click does not move it. */
        /* A native range input is driven by its value, so it is asked the way a
           user asks it - the keyboard, which is also the route that has to work
           for somebody who cannot drag. */
        const before = bridge.volume;
        volume.value = '0.2';
        volume.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(350);
        say('walkthrough_volume_when_empty',
          `bridge volume ${before.toFixed(2)} -> ${bridge.volume.toFixed(2)} ` +
          `(asked for 0.20, slider shows ${volume.value}, ` +
          `fill=${getComputedStyle(volume).getPropertyValue('--mt-fill').trim() || 'unset'}) ` +
          `${Math.abs(bridge.volume - 0.2) < 0.02 ? 'it answered' : 'IGNORED'}`);
      } else {
        say('walkthrough_volume_when_empty', 'no volume slider in the page');
      }
    } else {
      say('walkthrough_empty_controls', 'no media element to ask');
    }

    /* The timeline. Left showing the last position played, it reads as a real
       position on a timeline that no longer has one. */
    const time = document.querySelector('media-time-slider');
    if (time) {
      const progress = time.querySelector('.vds-track-progress, .vds-track-fill');
      say('walkthrough_timeline_when_empty',
        `slider value=${time.getAttribute('aria-valuenow') || '(none)'} ` +
        `fill=${progress ? getComputedStyle(progress).width : 'no fill element'}`);
    } else {
      say('walkthrough_timeline_when_empty', 'no time slider in the page');
    }
  });

  /* ---- settings, and the colour taken from the mark ------------------ */

  journey('walkthrough_settings', async () => {
    const press = (k) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));

    press('s');
    await wait(500);
    const modal = document.getElementById('settings-modal');
    say('walkthrough_settings_opens', `open=${!!modal && !modal.hidden}`);

    /* The logo field is a button now, and the input behind it is off screen but
       still a real input - hidden with display:none it would leave the tab
       order and the accessibility tree. */
    const label = document.querySelector('label.btn.txt[for="set-logo"]');
    const input = document.getElementById('set-logo');
    const box = input ? input.getBoundingClientRect() : { width: -1, height: -1 };
    const cs2 = input ? getComputedStyle(input) : null;
    say('walkthrough_logo_button',
      `label=${!!label} text=${label ? JSON.stringify(label.textContent.trim()) : 'none'} ` +
      `inputType=${input ? input.type : 'none'} ` +
      /* Clipped, not display:none. A display:none input is out of the tab order
         and out of the accessibility tree, and this one still has to report the
         chosen file to a screen reader. The clip is the thing that makes it
         invisible: the user agent keeps a file input at 8x8 whatever size is
         asked of it, so the box is not the evidence - the clip is. */
      `box=${Math.round(box.width)}x${Math.round(box.height)} ` +
      `clipped=${cs2 ? cs2.clipPath : 'n/a'} ` +
      `hidden=${input ? input.hidden : 'n/a'} tabIndex=${input ? input.tabIndex : 'n/a'}`);

    /* The language picker: one arrow, and a dark popup.
       Two carets is what a custom chevron drawn over a native one looks like,
       and the two count because the native arrow is a background image of its
       own. */
    const select = document.getElementById('set-lang');
    const cs = select ? getComputedStyle(select) : null;
    say('walkthrough_select',
      select
        ? `appearance=${cs.appearance} layers=${(cs.backgroundImage.match(/gradient/g) || []).length} ` +
          `colourScheme=${cs.colorScheme}`
        : 'no select');

    /* The colour button, against the mark that actually ships. Read as a
       saturation check rather than an exact value: the question is whether a
       colour came back at all, and whether it is a colour. */
    const before = getComputedStyle(document.documentElement).getPropertyValue('--gold').trim();
    const button = document.getElementById('set-color-reset');
    if (button) {
      button.click();
      await wait(2500);
      const after = getComputedStyle(document.documentElement).getPropertyValue('--gold').trim();
      const m = /rgb\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(after);
      const sat = m ? Math.max(+m[1], +m[2], +m[3]) - Math.min(+m[1], +m[2], +m[3]) : -1;
      say('walkthrough_logo_colour',
        `${before} -> ${after} saturation=${sat} ` +
        `${sat > 0 ? 'a colour came back' : 'NOTHING CAME BACK'}`);
    } else {
      say('walkthrough_logo_colour', 'no button');
    }

    press('escape');
    await wait(400);
    say('walkthrough_settings_closes', `closed=${!!modal && modal.hidden}`);
  });

  /* ---- 5. a file that has moved keeps its row ------------------------- */

  /* registered, so the verdict cannot be taken before it has finished */
  journey('walkthrough_missing_rows', async () => {
    try {
      const rowsBefore = document.querySelectorAll('#list li').length;
      await wait(400);
      const rowsAfter = document.querySelectorAll('#list li').length;
      const missing = document.querySelectorAll('.row.missing, .row.is-missing, .row[data-missing]').length;
      say('walkthrough_missing_rows',
        `rows ${rowsBefore} -> ${rowsAfter}, ${missing} marked as gone (a moved file keeps its row)`);
    } catch (err) {
      say('walkthrough_missing_rows', 'threw: ' + err);
    }
  });

  /* The verdict, once every journey has finished writing.

     It used to sleep for a fixed time and then read the report, which is a race
     dressed up as a wait: the playback journey can spend twelve seconds waiting
     for a file to load and eight more waiting for it to play, and it writes as
     it goes - so a report read on a timer is read *before* the journey that
     matters has said anything.

     And the patterns below are matched against the report's own words, so they
     have to include the ways a failure is actually phrased. They did not. An
     Electron run printed "rows before=0 after=0", "NONE in the page", "stuck at
     0.00" and "the file never loaded" - every one of those is a dead player -
     and the verdict said PASS, because none of those sentences contains a word
     the old pattern list knew about. */
  (async () => {
    await Promise.allSettled(journeys);

    const failures = [];

    /* Every journey that must have run, and therefore must have written a line.
       A journey that returns early - no probe file, no bridge - leaves no line,
       and its absence used to be invisible. */
    const expected = [
      'layout_worst', 'walkthrough_drop', 'walkthrough_media_elements',
      'walkthrough_playing', 'walkthrough_duration', 'walkthrough_seek',
      'walkthrough_pause', 'walkthrough_fullscreen', 'walkthrough_missing_rows',
    ];
    for (const key of expected) {
      if (!(key in report)) failures.push(key + ' (never reported)');
    }

    /* The honest failure phrasings, in one list. */
    const broken = [
      /\bNO\b/, /\bNONE\b/, /\bEMPTY\b/, /\bBROKEN\b/,
      /threw:/, /never loaded/, /never started/, /gave up waiting/,
      /stuck at 0/, /not tested/, /after=0\b/, /dispatched: false/,
      /outside the window/, /no size/, /too small/,
      /* The words the empty-playlist journey uses when a control is on screen,
         takes a click, and does nothing. Those are the whole point of that
         journey, so a control that ignored it is the failure it exists to find
         - and a verdict that does not read them will pass a player whose volume
         and mute are dead. */
      /IGNORED/, /did not (move|change|answer)/,
    ];

    for (const [key, value] of Object.entries(report)) {
      if (broken.some((re) => re.test(String(value)))) failures.push(key);
    }

    /* The console, into the report, so a run that fails says why rather than
       only what it saw. */
    if (consoleLines.length) {
      say('walkthrough_console', consoleLines.slice(0, 12).join(' || '));
    }

    say('walkthrough_verdict', failures.length
      ? `FAIL - ${failures.length} problem(s): ${failures.join(', ')}`
      : 'PASS - every journey worked');

    /* Left on the window as well, so a shell can read the whole report without
       needing a command to carry it. */
    window.__WALKTHROUGH_REPORT__ = report;
    if (channel) {
      try {
        await channel.invoke('print_diagnostic', { report, done: true });
      } catch (err) {
        /* Nothing further can be done from here; the shell is on its way out. */
      }
    }
  })();
})();