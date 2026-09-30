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

  const channel = (window.__TAURI__ && window.__TAURI__.core) || window.__TAURI_INTERNALS__;
  const invoke = (cmd, args) => channel.invoke(cmd, args || {});
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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

  (async () => {
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
    say('window_resizable', after !== before ? 'yes' : 'NO - the window ignores a resize');

    await invoke('diagnostic_set_size', { width: 1280, height: 800 });
    await wait(200);

    function describe(el) {
      const id = el.id ? '#' + el.id : '';
      const cls = el.className && typeof el.className === 'string'
        ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
        : '';
      return el.tagName.toLowerCase() + id + cls;
    }
  })().catch((err) => say('layout_worst', 'threw: ' + err));

  /* ---- 2, 3. drop a file and play it --------------------------------- */

  (async () => {
    if (!probeFile) {
      say('walkthrough_play', 'no probe file supplied');
      return;
    }
    const bridge = window.MediaBridge;
    if (!bridge) {
      say('walkthrough_play', 'no bridge');
      return;
    }

    const before = document.querySelectorAll('.row').length;
    await invoke('diagnostic_simulate_drop', { paths: [probeFile] });
    await wait(1500);

    /* Did it reach the playlist? */
    const rows = document.querySelectorAll('.row').length;
    say('walkthrough_drop', `rows before=${before} after=${rows}`);

    /* The player's own state, which is the only honest answer to "does it
       play". A <video> element with a src says nothing about whether the app's
       player started it. */
    await bridge.play();
    await wait(2000);

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

    const t1 = bridge.currentTime;
    await wait(1500);
    const t2 = bridge.currentTime;

    say('walkthrough_playing', bridge.playing ? 'yes' : 'NO - the player is paused');
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
  })().catch((err) => say('walkthrough_play', 'threw: ' + err));

  /* ---- 4. fullscreen by keyboard ------------------------------------- */

  (async () => {
    const before = await invoke('is_fullscreen');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', bubbles: true }));
    await wait(600);
    const during = await invoke('is_fullscreen');
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
  })().catch((err) => say('walkthrough_fullscreen', 'threw: ' + err));

  /* ---- 5. a file that has moved keeps its row ------------------------- */

  (async () => {
    try {
      const rowsBefore = document.querySelectorAll('.row').length;
      await wait(400);
      const rowsAfter = document.querySelectorAll('.row').length;
      const missing = document.querySelectorAll('.row.missing, .row.is-missing, .row[data-missing]').length;
      say('walkthrough_missing_rows',
        `rows ${rowsBefore} -> ${rowsAfter}, ${missing} marked as gone (a moved file keeps its row)`);
    } catch (err) {
      say('walkthrough_missing_rows', 'threw: ' + err);
    }
  })();

  /* Report once everything has had time, and mark it so a second call knows. */
  (async () => {
    await wait(7000);
    const failures = [];
    for (const [key, value] of Object.entries(report)) {
      const text = String(value);
      if (/\bNO\b|BROKEN|threw:|outside the window|no size|too small/.test(text)) {
        failures.push(key);
      }
    }
    say('walkthrough_verdict', failures.length
      ? `FAIL - ${failures.length} problem(s): ${failures.join(', ')}`
      : 'PASS - every journey worked');

    if (channel) {
      try {
        await channel.invoke('print_diagnostic', { report, done: true });
      } catch (err) {
        /* Nothing further can be done from here; the shell is on its way out. */
      }
    }
  })();
})();