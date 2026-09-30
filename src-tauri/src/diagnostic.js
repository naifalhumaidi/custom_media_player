/* Injected by the shell for `--diagnose`, and never part of the app itself.

   It records what it finds on window.__DIAG__; the shell collects it from a
   Rust thread afterwards. Nothing here decides anything on a page timer,
   because WebKit throttles those in a window that is not the focused one -
   which is how an earlier version of this file simply never finished.

   It answers the two questions that cannot be checked from outside the process:
   whether the shell's API is reachable from the page at all, and whether this
   machine can actually play a video file.

   The second is asked in stages, because "the video did not play" has three
   quite different causes and one error code:

     1. can the shell serve a packaged asset at all?
     2. can a <video> element load that packaged asset?
     3. can it load a real file from disk through the same call the
        application makes?

   A single verdict conflates them. MEDIA_ERR_SRC_NOT_SUPPORTED in particular
   looks identical whether the codec is missing, the URL is wrong, or the
   content-security policy blocked the request - and `canPlayType` says
   "probably" in all three cases, because it never looks at any of them.

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

  const probeFile = window.__PROBE_FILE__ || '';
  say('probe_file', probeFile || '(none supplied)');
  if (window.MediaFileSourceTauri) {
    try {
      say('asset_url', String(window.MediaFileSourceTauri.urlFor({ path: probeFile || 'x.mp4' })).slice(0, 70));
    } catch (err) {
      say('asset_url', 'threw: ' + err.message);
    }
  }

  /* Whether a page timer runs at all here. If it does not, no stage below can
     finish and every verdict would be missing for a reason that has nothing to
     do with the app. */
  window.__DIAG_TIMER__ = 'not fired';
  setTimeout(() => { window.__DIAG_TIMER__ = 'fired'; }, 1000);

  const el = document.createElement('video');
  el.muted = true;
  el.preload = 'auto';
  say('can_play_type_mp4', el.canPlayType('video/mp4; codecs="avc1.42E01E"') || '(empty)');

  /* Loads a URL into the element and resolves to a verdict. Reports the element's
     own state on failure, because the error code alone cannot say why.

     `mime` is passed through to a <source> child when given. WebKitGTK's media
     source can often not work out the type of a resource served from a custom
     scheme, and declines it as a format error before GStreamer sees a byte -
     which is why declaring the type is worth testing separately. */
  const load = (url, budget, mime) => new Promise((resolve) => {
    let settled = false;
    const finish = (verdict) => {
      if (settled) return;
      settled = true;
      el.removeEventListener('loadeddata', onOk);
      el.removeEventListener('error', onErr);
      clearTimeout(timer);
      resolve(verdict);
    };
    const onOk = () => finish('OK (readyState ' + el.readyState + ')');
    const onErr = () => {
      const code = el.error ? el.error.code : 'none';
      const meaning = { 1: 'aborted', 2: 'network', 3: 'decode', 4: 'src not supported' }[code] || 'unknown';
      finish('FAILED error=' + code + ' (' + meaning + ') readyState=' + el.readyState +
        ' networkState=' + el.networkState);
    };
    const timer = setTimeout(() => finish('TIMED OUT after ' + budget + 'ms readyState=' + el.readyState +
      ' networkState=' + el.networkState), budget);
    el.addEventListener('loadeddata', onOk, { once: true });
    el.addEventListener('error', onErr, { once: true });
    try {
      if (mime) {
        const child = document.createElement('source');
        child.src = url;
        child.type = mime;
        el.appendChild(child);
      } else {
        el.src = url;
      }
      el.load();
    } catch (err) {
      finish('THREW: ' + err);
    }
  });

  (async () => {
    /* Stage 1 - the packaged asset. Uses fetch because it bypasses the media
       stack entirely: if this fails, the media stages below would fail too and
       the blame would land on the decoder. */
    try {
      const res = await fetch('assets/probe.mp4', { cache: 'no-store' });
      const body = await res.blob();
      say('stage1_packaged_asset', res.status + ' ' + res.headers.get('content-type') +
        ' ' + body.size + ' bytes');
    } catch (err) {
      say('stage1_packaged_asset', 'FETCH FAILED: ' + err);
    }

    /* Stage 2 - the same file, through the media stack. */
    say('stage2_video_packaged', 'running');
    say('stage2_video_packaged', await load('assets/probe.mp4', 10000));

    /* Stage 3 - a real file on disk, through the same call the app makes. This
       is the only stage that actually answers "will the app play a video".
       It asks the shell for the URL rather than building one, because that is
       what the application does. */
    if (probeFile) {
      let url = '';
      try {
        url = String(await core.invoke('media_url', { path: probeFile }));
      } catch (err) {
        say('stage3_video_real_file', 'media_url THREW: ' + err);
      }
      if (url) {
        say('stage3_url', url.slice(0, 70));
        say('stage3_video_real_file', 'running');
        say('stage3_video_real_file', await load(url, 10000));
      }
    } else {
      say('stage3_video_real_file', 'skipped - no probe file supplied');
    }

    /* Stage 4 and 5 - which URL form the media stack will accept at all.

       Stage 1 proved the bytes are served and stage 3 proved the media stack
       will not take them from a custom scheme. Those two facts together point
       at the scheme rather than the codec, so the useful question is no longer
       "can it decode" but "which origin can it load from". file:// is what
       WebKitGTK's media stack reaches natively; asset://localhost over http is
       the form Tauri uses on Windows. Whichever answers decides the fix. */
    if (probeFile) {
      const fileUrl = 'file://' + probeFile.split('/').map(encodeURIComponent).join('/');
      say('stage4_file_url', fileUrl.slice(0, 60));
      say('stage4_video_file_scheme', 'running');
      say('stage4_video_file_scheme', await load(fileUrl, 10000));

      const httpAsset = 'http://asset.localhost/' + probeFile.split('/').map(encodeURIComponent).join('/');
      say('stage5_http_asset_url', httpAsset.slice(0, 60));
      say('stage5_video_http_asset', 'running');
      say('stage5_video_http_asset', await load(httpAsset, 10000));

      /* Stage 6 - audio, asked the same way the application asks for it. An MP3
         needs no video decoder, so this separates "no video decoder" from
         "no media pipeline". It goes through the shell rather than over
         file://, because file:// is refused for a page that is not itself a
         file - which is a fact about loading, not about audio. */
      const mp3 = window.__PROBE_MP3__ || '';
      if (mp3) {
        let audioUrl = '';
        try {
          audioUrl = String(await core.invoke('media_url', { path: mp3 }));
        } catch (err) {
          say('stage6_audio_mp3', 'media_url THREW: ' + err);
        }
        if (audioUrl) {
          say('stage6_audio_mp3', 'running');
          say('stage6_audio_mp3', await load(audioUrl, 10000));
        }
      }
      say('stage7_video_typed', 'running');
      say('stage7_video_typed', await load(fileUrl, 10000, 'video/mp4'));
    }

    /* Stage 8 - a data: URL, which involves no scheme, no server and no
       network. Every other scheme has been refused before any load was even
       attempted, so this separates "this URL is refused" from "the media
       player will not start at all". If this works, the pipeline is fine and
       the earlier failures were about which origins it will open. If it fails
       too, nothing about the URL is at fault. */
    try {
      const bytes = new Uint8Array(await (await fetch('assets/probe.mp4')).arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
      say('stage8_data_url', 'running');
      say('stage8_data_url', await load('data:video/mp4;base64,' + btoa(binary), 10000));
    } catch (err) {
      say('stage8_data_url', 'could not build a data URL: ' + err);
    }

    say('probe_complete', 'yes');
    window.__DIAG_TIMER__ = window.__DIAG_TIMER__ + ' / probe done';
  })().catch((err) => say('probe_complete', 'THREW: ' + err));
})();