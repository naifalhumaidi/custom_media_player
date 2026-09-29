/* Collected by the shell after the codec probe has had time to run. See
   diagnostic.js for what it measures, and why the wait is not done in the
   page: WebKit throttles timers in a page it considers hidden. */
(() => {
  const report = window.__DIAG__ || { error: 'the page never recorded anything' };
  report.page_was_hidden = String(document.hidden);
  report.visibility = String(document.visibilityState);
  const core = window.__TAURI__ && window.__TAURI__.core;
  const internals = window.__TAURI_INTERNALS__;
  const channel = (core && typeof core.invoke === 'function')
    ? core.invoke
    : (internals && typeof internals.invoke === 'function' ? internals.invoke : null);
  if (channel) channel('print_diagnostic', { report: report, done: true }).catch(() => {});
})();
