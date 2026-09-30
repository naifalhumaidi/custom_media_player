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