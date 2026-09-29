/* Injected by the shell for `--diagnose`, and never part of the app itself.

   It records what it finds on window.__DIAG__; the shell collects it from a
   Rust thread afterwards. Nothing here waits on a page timer, because WebKit
   throttles those in a window that is not the focused one - which is how an
   earlier version of this file simply never finished, silently.

   It answers the two questions that cannot be checked from outside the
   process: whether the shell's API is reachable from the page at all, and
   whether this machine can decode H.264. The second matters because the
   webview decodes through the platform media stack - GStreamer on Linux - and
   a machine missing the MP4 demuxer shows an app that silently refuses to play
   anything at all.

   The clip is a real second of H.264 shipped in the bundle, loaded through
   exactly the same code path as user media. `canPlayType` is recorded but not
   trusted for the verdict: it can be optimistic, and the point is to find out
   rather than to assume.

   Running this opens a window, so it is opt-in behind a flag. */

(() => {
  const report = {};
  const say = (key, value) => { report[key] = value; };
  window.__DIAG__ = report;

  const internals = window.__TAURI_INTERNALS__;
  const tauri = window.__TAURI__;
  const core = tauri && tauri.core;

  say('tauri_internals', internals ? 'present' : 'MISSING');
  say('tauri_global', tauri ? 'present' : 'MISSING');
  say('tauri_core', core ? 'present' : 'MISSING');
  say('invoke', typeof (core && core.invoke));
  say('convert_file_src', typeof (core && core.convertFileSrc));
  say('event_listen', typeof (tauri && tauri.event && tauri.event.listen));

  say('desktop_adapter', window.MediaFileSourceTauri ? 'registered' : 'MISSING');
  say('active_source', window.MediaFileSource === window.MediaFileSourceTauri
    ? 'desktop'
    : (window.MediaFileSource ? 'browser (WRONG inside the shell)' : 'none'));
  say('bridge', typeof window.MediaBridge === 'object' ? 'present' : 'MISSING');
  say('app_mounted', !!document.getElementById('stage'));
  say('mime_module', typeof window.MediaMime === 'object' ? 'present' : 'MISSING');
  say('url', String(location.protocol) + '//' + String(location.host || '(no host)'));

  if (window.MediaFileSourceTauri) {
    try {
      say('asset_url', String(window.MediaFileSourceTauri.urlFor({ path: 'probe.mp4' })).slice(0, 70));
    } catch (err) {
      say('asset_url', 'threw: ' + err.message);
    }
  }

  const probe = new window.Video();
  probe.muted = true;
  probe.preload = 'auto';
  window.__DIAG_PROBE__ = probe;
  say('probe_ready_state', String(probe.readyState));

  let settled = false;
  const done = (verdict) => {
    if (settled) return;
    settled = true;
    say('h264_playback', verdict);
    say('can_play_type_mp4', probe.canPlayType('video/mp4; codecs="avc1.42E01E"') || '(empty)');
    say('probe_ready_state', String(probe.readyState));
    say('probe_network_state', String(probe.networkState));
    if (probe.error) say('probe_error_code', String(probe.error.code));
  };

  probe.addEventListener('loadeddata', () => done('WORKS'), { once: true });
  probe.addEventListener('error', () => done('FAILED - no decoder for H.264'), { once: true });
  probe.addEventListener('loadedmetadata', () => say('probe_loadedmetadata', 'yes'), { once: true });
  probe.addEventListener('stalled', () => say('probe_stalled', 'yes'), { once: true });
  probe.addEventListener('progress', () => say('probe_progress', String(probe.buffered.length)), { once: true });

  try {
    probe.src = 'assets/probe.mp4';
    probe.load();
    say('probe_src_set', String(probe.src).slice(0, 60));
  } catch (err) {
    say('probe_error', String(err));
    done('threw while loading the probe');
  }
})();
