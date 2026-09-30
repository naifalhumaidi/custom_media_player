/* Collected by the shell after the probe has had time to run.

   It reports whatever the page has recorded, whether or not the probe
   finished, because "no verdict" and "a verdict that says no" are different
   answers and only one of them is about the machine.

   The wait happens here rather than in the page: WebKit throttles page timers
   in a window that is not the focused one, so a page-side timeout is not
   trustworthy. This is polled from a Rust thread, which is not throttled. */

(() => {
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

  const core = window.__TAURI__ && window.__TAURI__.core;
  const internals = window.__TAURI_INTERNALS__;
  const channel = (core && typeof core.invoke === 'function')
    ? core.invoke
    : (internals && typeof internals.invoke === 'function' ? internals.invoke : null);
  if (channel) channel('print_diagnostic', { report: report, done: true }).catch(() => {});
})();