/* Collected by the shell after the probe has had time to run.

   It reports whatever the page has recorded, whether or not the probe
   finished, because "no verdict" and "a verdict that says no" are different
   answers and only one of them is about the machine.

   The wait happens here rather than in the page: WebKit throttles page timers
   in a window that is not the focused one, so a page-side timeout is not
   trustworthy. This is polled from a Rust thread, which is not throttled. */

(async () => {
  const report = window.__DIAG__ || { error: 'the page never recorded anything' };
  report.page_was_hidden = String(document.hidden);
  report.visibility = String(document.visibilityState);
  report.page_timer = String(window.__DIAG_TIMER__ || 'never set');

  if (report.probe_complete === undefined) {
    report.probe_complete = 'STILL RUNNING when the shell stopped waiting';
  }

  /* The verdict the caller actually wants, in one line. Derived here rather
     than in the page so that it reflects the final state of every stage. */
  if (report.stage3_video_real_file) {
    report.verdict = String(report.stage3_video_real_file).startsWith('OK')
      ? 'PASS - a real file on disk played'
      : 'FAIL - a real file on disk did not play: ' + report.stage3_video_real_file;
  } else if (report.stage2_video_packaged) {
    report.verdict = 'FAIL - no real file was tested; the packaged asset said: '
      + report.stage2_video_packaged;
  } else {
    report.verdict = 'FAIL - the probe never reached the media stack';
  }

  /* The playlist that survived to this launch. Read-only, and the one check here
     that needs no simulation: state.json was written by a previous run, so if
     it is there and every row got a URL, persistence works end to end. */
  try {
    const channel = (window.__TAURI__ && window.__TAURI__.core) || window.__TAURI_INTERNALS__;
    /* Through the adapter, not a bare invoke. The adapter is what re-registers
       each path with the shell, so asking it is the only way to see whether a
       restored row can actually play - a bare read shows five rows and proves
       nothing about any of them. */
    const source = window.MediaFileSource;
    const state = source && typeof source.loadState === 'function'
      ? await source.loadState()
      : await channel.invoke('load_state');
    const saved = (state && Array.isArray(state.items)) ? state.items : [];
    report.saved_playlist = saved.length + ' row(s) restored from the last run';
    if (saved.length) {
      const withUrl = saved.filter((i) => i && i.url).length;
      report.saved_rows_playable = withUrl + '/' + saved.length +
        (withUrl === saved.length ? ' (all re-registered and ready)' : ' (SOME COULD NOT PLAY)');
      const missing = [];
      for (const item of saved) {
        if (!item || !item.path) continue;
        /* eslint-disable-next-line no-await-in-loop */
        if (!(await channel.invoke('file_exists', { path: item.path }))) missing.push(item.name);
      }
      report.saved_rows_missing = missing.length ? missing.join(', ') : 'none';
    }
  } catch (err) {
    report.saved_playlist = 'could not read it: ' + err;
  }

  /* A dropped file, driven through the event the shell actually sends.

     There is no DataTransfer in a Tauri webview: the platform delivers absolute
     paths on a tauri://drag-drop event, which is why js/source-tauri.js
     subscribes to that instead of to DOM drop. Subscribing here as well checks
     the whole route - event, adapter, registration - rather than just that a
     listener exists.

     Opt-in, because it adds a row to the real playlist and the app then saves.
     A diagnostic that quietly rewrites what the user left behind is not a
     diagnostic. */
  if (window.__PROBE_DROP__) {
    try {
      const source = window.MediaFileSource;
      if (source && typeof source.onExternalDrop === 'function') {
        const got = new Promise((resolve) => {
          const stop = source.onExternalDrop((items) => {
            if (typeof stop === 'function') stop();
            resolve(items);
          });
        });
        const dropTarget = String(window.__PROBE_FILE__ || '');
        /* From the shell, not from the page: `event.emit` in the JS API sends an
           event to Rust, and would never reach a page listener. */
        const channel = (window.__TAURI__ && window.__TAURI__.core) || window.__TAURI_INTERNALS__;
        /* A raw listener as well, so "the page never saw it" and "the adapter
           ignored it" stay different answers. */
        let rawSaw = 0;
        try {
          await window.__TAURI__.event.listen('mt-diag-drop', () => { rawSaw += 1; });
        } catch (err) {
          report.page_event_listen = 'refused: ' + String((err && (err.message || err)) || err);
        }
        await channel.invoke('diagnostic_simulate_drop', {
          paths: dropTarget ? [dropTarget] : [],
        });
        await new Promise((resolve) => setTimeout(resolve, 300));
        report.drop_event_reached_page = String(rawSaw > 0);
        const items = await Promise.race([
          got,
          new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
        ]);
        if (!items) report.dropped_file = 'the drop never arrived';
        else if (!items.length) report.dropped_file = 'arrived with no files - the path was dropped';
        else {
          report.dropped_file = 'arrived: ' + items[0].name +
            ' url=' + (items[0].url ? 'yes' : 'NONE (this row could not play)');
        }
      } else {
        report.dropped_file = 'the source does not offer onExternalDrop';
      }
    } catch (err) {
      report.dropped_file = 'threw: ' + err;
    }
  } else {
    report.dropped_file = 'not tested (set MT_PROBE_DROP=1; it adds a row to the real playlist)';
  }

  /* The native dialogs cannot be finished by a machine - a person has to click
     a button - but whether the command exists and opens something is checkable,
     and a shell missing the command would be worth knowing before a user does.
     Raced against a short timer on purpose: a command that never settles is a
     dialog that opened and is waiting, which is the healthy outcome. */
  try {
    const channel = (window.__TAURI__ && window.__TAURI__.core) || window.__TAURI_INTERNALS__;
    const opened = await Promise.race([
      channel.invoke('pick_files').then(() => 'closed without choosing', () => 'rejected'),
      new Promise((resolve) => setTimeout(() => resolve('still open, waiting for a click'), 1500)),
    ]);
    report.native_dialog = opened;
  } catch (err) {
    report.native_dialog = 'threw: ' + err;
  }

  /* Fullscreen, driven exactly as the button drives it. Worth proving rather
     than assuming: WebKitGTK has no HTML Fullscreen API at all, so this is the
     only route there is, and it was never exercised before. */
  try {
    const shellFs = window.MediaFullscreen;
    if (shellFs && typeof shellFs.toggle === 'function') {
      const channel = (window.__TAURI__ && window.__TAURI__.core)
        || window.__TAURI_INTERNALS__;
      const before = await channel.invoke('is_fullscreen');
      await shellFs.toggle();
      await new Promise((r) => setTimeout(r, 400));
      const during = await channel.invoke('is_fullscreen');
      report.fullscreen_shell = 'present, changed the window: ' + (before !== during);
      report.fullscreen_button_state = String(shellFs.active);
      /* Back, so the diagnostic does not leave the window fullscreen. */
      await shellFs.toggle();
      await new Promise((r) => setTimeout(r, 300));
      report.fullscreen_restored = String(!(await channel.invoke('is_fullscreen')));
    } else {
      report.fullscreen_shell = 'ABSENT - the button would do nothing';
      report.fullscreen_html_api = typeof document.documentElement.requestFullscreen;
    }
  } catch (err) {
    report.fullscreen_shell = 'threw: ' + err;
  }

  const core = window.__TAURI__ && window.__TAURI__.core;
  const internals = window.__TAURI_INTERNALS__;
  const channel = (core && typeof core.invoke === 'function')
    ? core.invoke
    : (internals && typeof internals.invoke === 'function' ? internals.invoke : null);
  if (channel) channel('print_diagnostic', { report: report, done: true }).catch(() => {});
})();