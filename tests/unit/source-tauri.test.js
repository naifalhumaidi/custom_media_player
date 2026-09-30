/* The desktop file source, driven against a stubbed shell.

   The shell is the only thing this module talks to, and a stub is the honest
   way to test it: every path in the contract - a dialog returning paths, a
   file that has moved, a save that fails, a drop delivered as a burst of one
   file at a time - is reproducible here without a display, a webview or a
   filesystem.

   What this cannot cover is the shell itself, which is what src-tauri/src/tests.rs
   and the `--diagnose` flag are for. Between the two, the parts that need a
   human with a screen are few and named. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../helpers/app-harness.js';

const MIME_SRC = fs.readFileSync(path.join(ROOT, 'js/mime.js'), 'utf8');
const SOURCE_SRC = fs.readFileSync(path.join(ROOT, 'js/source-tauri.js'), 'utf8');

/* A stand-in for window.__TAURI__, recording what the adapter asked for. */
function installShell(options = {}) {
  const calls = [];
  const listeners = {};
  const existing = Array.isArray(options.files) ? [...options.files] : [];

  const handlers = {
    pick_files: () => (existing.length ? existing.splice(0) : options.files || []),
    pick_folder: () => options.folder === undefined ? null : options.folder,
    list_folder: ({ dir }) => options.folderContents || [],
    file_exists: ({ path: p }) => (options.missing || []).includes(p) ? false : true,
    /* The shell serves local files over loopback; this mirrors that, including
       the per-process port that makes a saved URL worthless on the next
       launch. */
    media_url: ({ path: p }) => {
      if ((options.urlFails || []).includes(p)) {
        return Promise.reject(new Error('could not open a local port'));
      }
      return `http://127.0.0.1:35415/m/${Buffer.from(p).toString('hex').slice(0, 16)}`;
    },
    /* The window's own answer, which is the truth. `refuseFullscreen` makes the
       window say no, which is a case the page has to survive honestly. */
    is_fullscreen: () => options.startFullscreen === true,
    set_fullscreen: ({ fullscreen }) => {
      if (options.refuseFullscreen) {
        return Promise.reject(new Error('the window refused to go fullscreen'));
      }
      options.startFullscreen = fullscreen;
      return Promise.resolve();
    },
    load_state: () => options.state === undefined ? null : options.state,
    save_state: (args) => {
      calls.push(['save_state', args]);
      if (options.failSave) return Promise.reject(new Error('disk full'));
      return Promise.resolve();
    },
  };

  window.__TAURI_INTERNALS__ = { invoke: () => {} };
  window.__TAURI__ = {
    core: {
      invoke: (cmd, args) => {
        calls.push([cmd, args]);
        if (!handlers[cmd]) return Promise.reject(new Error(`unexpected command: ${cmd}`));
        try {
          return Promise.resolve(handlers[cmd](args || {}));
        } catch (err) {
          return Promise.reject(err);
        }
      },
      /* The real one turns a path into asset://localhost/<encoded>. The
         encoding is the part worth reproducing. */
      convertFileSrc: (p) => 'asset://localhost/' + String(p).split('/').map(encodeURIComponent).join('/'),
    },
    /* Stand-in for the window API the shell uses to notice a fullscreen change
       that did not come from the page. */
    window: {
      getCurrentWindow: () => ({
        onResized: (fn) => {
          listeners['resized'] = fn;
          return Promise.resolve(() => { delete listeners['resized']; });
        },
      }),
    },
    event: {
      listen: (name, fn) => {
        listeners[name] = fn;
        return Promise.resolve(() => { delete listeners[name]; });
      },
    },
  };
  return {
    calls,
    listeners,
    /* Exposed because several tests drive the window's state directly, the way
       a window manager would. */
    options,
    emit: (name, payload) => listeners[name] && listeners[name]({ payload }),
    /* The platform's event for a fullscreen change made outside the page. */
    resize: (payload) => listeners['resized'] && listeners['resized'](payload),
  };
}

describe('registration', () => {
  afterEach(() => {
    delete window.__TAURI__;
    delete window.__TAURI_INTERNALS__;
    delete window.MediaFileSourceTauri;
    delete window.MediaFullscreen;
  });

  it('registers nothing in a browser, so index.html can always include it', () => {
    // eslint-disable-next-line no-new-func
    new Function(MIME_SRC)();
    // eslint-disable-next-line no-new-func
    new Function(SOURCE_SRC)();
    /* A desktop adapter present in a browser would be selected by js/source.js
       and the app would then ask a shell that is not there for everything. */
    expect(window.MediaFileSourceTauri).toBeUndefined();
  });

  it('registers when the shell is present', () => {
    installShell();
    // eslint-disable-next-line no-new-func
    new Function(MIME_SRC)();
    // eslint-disable-next-line no-new-func
    new Function(SOURCE_SRC)();
    expect(typeof window.MediaFileSourceTauri).toBe('object');
    for (const name of ['canPersist', 'openFiles', 'openFolder', 'urlFor', 'release', 'loadState', 'saveState', 'fileExists']) {
      expect(typeof window.MediaFileSourceTauri[name], name).toBe('function');
    }
    expect(window.MediaFileSourceTauri.canPersist()).toBe(true);
  });

  it('warns rather than failing silently if the API is missing', () => {
    window.__TAURI_INTERNALS__ = {};
    window.__TAURI__ = { core: {} };
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    // eslint-disable-next-line no-new-func
    new Function(MIME_SRC)();
    // eslint-disable-next-line no-new-func
    new Function(SOURCE_SRC)();
    expect(window.MediaFileSourceTauri).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('with a shell', () => {
  let shell;
  let SRC;

  beforeEach(() => {
    // eslint-disable-next-line no-new-func
    new Function(MIME_SRC)();
    shell = installShell();
    // eslint-disable-next-line no-new-func
    new Function(SOURCE_SRC)();
    SRC = window.MediaFileSourceTauri;
  });

  afterEach(() => {
    delete window.__TAURI__;
    delete window.__TAURI_INTERNALS__;
    delete window.MediaFileSourceTauri;
  });

  it('turns chosen paths into playable items', async () => {
    shell = installShell({ files: ['/media/holiday.mp4', '/media/notes.txt', '/media/shot.PNG'] });
    // eslint-disable-next-line no-new-func
    new Function(SOURCE_SRC)();
    SRC = window.MediaFileSourceTauri;
    const items = await SRC.openFiles();
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ name: 'holiday.mp4', kind: 'video', path: '/media/holiday.mp4' });
    /* the unplayable one is marked, not silently typed as video */
    expect(items[1].kind).toBeNull();
    /* the extension test is case-insensitive, so an upper-case name works */
    expect(items[2]).toMatchObject({ name: 'shot.PNG', kind: 'image', mime: 'image/png' });
  });

  it('keeps the name from the end of a Windows path', async () => {
    shell = installShell({ files: ['C:\\Users\\me\\Videos\\clip.mov'] });
    // eslint-disable-next-line no-new-func
    new Function(SOURCE_SRC)();
    SRC = window.MediaFileSourceTauri;
    const items = await SRC.openFiles();
    expect(items[0].name).toBe('clip.mov');
    expect(items[0].path).toBe('C:\\Users\\me\\Videos\\clip.mov');
  });

  it('gives an opened file a loopback URL the media stack can open', async () => {
    shell = installShell({ files: ['/media/a b/clip.mp4'] });
    // eslint-disable-next-line no-new-func
    new Function(SOURCE_SRC)();
    SRC = window.MediaFileSourceTauri;

    const [item] = await SRC.openFiles();
    /* Not an asset:// URL: GStreamer has no handler for that scheme on Linux,
       which is why the shell serves the bytes itself. */
    expect(item.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/m\//);
    /* The player asks repeatedly; the answer cannot change, so it is kept. */
    expect(SRC.urlFor(item)).toBe(item.url);
    expect(SRC.urlFor(item)).toBe(item.url);
  });

  it('refuses an item with no path, with a message that says why', () => {
    expect(() => SRC.urlFor({ name: 'x.mp4' })).toThrow(/no path/);
  });

  it('says so plainly when the shell could not give a URL, rather than handing back one that will fail', async () => {
    shell = installShell({ files: ['/media/clip.mp4'], urlFails: ['/media/clip.mp4'] });
    // eslint-disable-next-line no-new-func
    new Function(SOURCE_SRC)();
    SRC = window.MediaFileSourceTauri;

    const [item] = await SRC.openFiles();
    expect(item.url).toBeNull();
    expect(() => SRC.urlFor(item)).toThrow(/could not give/);
  });

  it('release keeps the URL, because there is nothing to give back', async () => {
    shell = installShell({ files: ['/media/clip.mp4'] });
    // eslint-disable-next-line no-new-func
    new Function(SOURCE_SRC)();
    SRC = window.MediaFileSourceTauri;

    const [item] = await SRC.openFiles();
    const first = SRC.urlFor(item);
    SRC.release(item);
    /* The URL names a path the shell registered, not a blob this adapter
       created. Dropping it would mean a clear-undo could not bring the row
       back without asking the shell for it all over again. */
    expect(item.url).toBe(first);
    expect(item.path).toBe('/media/clip.mp4');
    expect(() => SRC.urlFor(item)).not.toThrow();
  });

  it('release is safe to call twice and on nothing', async () => {
    shell = installShell({ files: ['/media/clip.mp4'] });
    // eslint-disable-next-line no-new-func
    new Function(SOURCE_SRC)();
    SRC = window.MediaFileSourceTauri;

    const [item] = await SRC.openFiles();
    SRC.release(item);
    expect(() => SRC.release(item)).not.toThrow();
    expect(() => SRC.release(null)).not.toThrow();
  });

  /* The trap this closes: a saved URL names the port of the process that
     wrote it, which is gone by the next launch. Restoring it as-is produces a
     playlist that looks complete and plays nothing. */
  it('re-registers restored rows instead of trusting a saved URL', async () => {
    shell = installShell({
      state: {
        items: [
          { name: 'one.mp4', path: '/media/one.mp4', kind: 'video', url: 'http://127.0.0.1:9999/m/stale' },
        ],
      },
    });
    // eslint-disable-next-line no-new-func
    new Function(SOURCE_SRC)();
    SRC = window.MediaFileSourceTauri;

    const state = await SRC.loadState();
    expect(state.items[0].url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/m\//);
    expect(state.items[0].url).not.toContain('9999');
  });

  it('does not write a dead URL into the saved state', async () => {
    shell = installShell({ files: ['/media/clip.mp4'] });
    // eslint-disable-next-line no-new-func
    new Function(SOURCE_SRC)();
    SRC = window.MediaFileSourceTauri;

    const [item] = await SRC.openFiles();
    expect(item.url).toBeTruthy();
    await SRC.saveState({ items: [item], index: 0 });

    const saved = shell.calls.find(([cmd]) => cmd === 'save_state');
    expect(saved).toBeTruthy();
    expect(saved[1].state.items[0].url).toBeUndefined();
    expect(saved[1].state.items[0].path).toBe('/media/clip.mp4');
  });

  /* Dropped files reach the playlist and the first one starts playing at once,
     so a row handed over without a URL would be visible and unplayable. */
  it('registers dropped files before handing them to the app', async () => {
    shell = installShell({});
    // eslint-disable-next-line no-new-func
    new Function(SOURCE_SRC)();
    SRC = window.MediaFileSourceTauri;

    const received = [];
    const stop = SRC.onExternalDrop((items) => received.push(...items));
    shell.emit('tauri://drag-drop', { type: 'drop', paths: ['/media/dropped.mp4'] });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(received).toHaveLength(1);
    expect(received[0].url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/m\//);
    stop();
  });

  it('reports a file that has moved', async () => {
    shell = installShell({ missing: ['/media/gone.mp4'] });
    // eslint-disable-next-line no-new-func
    new Function(SOURCE_SRC)();
    SRC = window.MediaFileSourceTauri;
    expect(await SRC.fileExists({ path: '/media/gone.mp4' })).toBe(false);
    expect(await SRC.fileExists({ path: '/media/here.mp4' })).toBe(true);
  });

  it('does not call a file gone when it simply cannot tell', async () => {
    window.__TAURI__.core.invoke = () => Promise.reject(new Error('no such command'));
    // eslint-disable-next-line no-new-func
    new Function(SOURCE_SRC)();
    /* A false "gone" would hide a file the user still has, which is the worse
       of the two mistakes. */
    expect(await SRC.fileExists({ path: '/media/clip.mp4' })).toBe(true);
  });

  it('reads a folder, one level, playable files only', async () => {
    shell = installShell({
      folder: '/media/album',
      folderContents: ['/media/album/01.mp4', '/media/album/cover.jpg', '/media/album/notes.txt'],
    });
    // eslint-disable-next-line no-new-func
    new Function(SOURCE_SRC)();
    SRC = window.MediaFileSourceTauri;
    const items = await SRC.openFolder();
    expect(items.map((i) => i.name)).toEqual(['01.mp4', 'cover.jpg']);
  });

  it('a cancelled folder dialog is not an error', async () => {
    shell = installShell({ folder: null });
    // eslint-disable-next-line no-new-func
    new Function(SOURCE_SRC)();
    SRC = window.MediaFileSourceTauri;
    expect(await SRC.openFolder()).toEqual([]);
  });

  it('the playlist is written as paths, and the blob-only keys are dropped', async () => {
    await SRC.saveState({
      index: 2, position: 30, fit: 'cover', loop: true, volume: 0.5,
      muted: false, ui: true, list: false, autoplay: true,
      settings: { lang: 'ar' },
      items: [{ name: 'a.mp4', kind: 'video', path: '/media/a.mp4' }],
      /* a key the desktop does not persist, to prove the list is a filter */
      somethingElse: 'ignored',
    });
    const saved = shell.calls.find(([cmd]) => cmd === 'save_state')[1].state;
    expect(saved.index).toBe(2);
    expect(saved.items).toHaveLength(1);
    expect(saved.items[0].path).toBe('/media/a.mp4');
    expect(saved.somethingElse).toBeUndefined();
  });

  it('a failed write is reported, not swallowed', async () => {
    shell = installShell({ failSave: true });
    // eslint-disable-next-line no-new-func
    new Function(SOURCE_SRC)();
    SRC = window.MediaFileSourceTauri;
    const events = [];
    document.addEventListener('mediatools:save-error', (e) => events.push(e));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await SRC.saveState({ index: 0, items: [] });
    /* Silently losing the playlist AND every preference is the failure this
       reporting exists to prevent. */
    expect(events).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a successful write announces itself', async () => {
    const events = [];
    document.addEventListener('mediatools:saved', () => events.push(1));
    await SRC.saveState({ index: 0, items: [] });
    expect(events).toHaveLength(1);
  });

  it('a read that fails is not fatal', async () => {
    window.__TAURI__.core.invoke = (cmd) => (cmd === 'load_state' ? Promise.reject(new Error('gone')) : Promise.resolve(null));
    // eslint-disable-next-line no-new-func
    new Function(SOURCE_SRC)();
    SRC = window.MediaFileSourceTauri;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await SRC.loadState()).toBeNull();
    warn.mockRestore();
  });

  it('coalesces a drop of many files into one batch', async () => {
    const batches = [];
    SRC.onExternalDrop((items) => batches.push(items));
    /* the platform emits one event per file; fifty events would otherwise be
       fifty separate additions, each appending to the playlist */
    for (const p of ['/media/1.mp4', '/media/2.mp4', '/media/3.mp4']) {
      shell.emit('tauri://drag-drop', { type: 'drop', paths: [p] });
    }
    await new Promise((r) => setTimeout(r, 5));
    expect(batches).toHaveLength(1);
    expect(batches[0].map((i) => i.name)).toEqual(['1.mp4', '2.mp4', '3.mp4']);
  });

  it('ignores the drag events that are not a drop', async () => {
    const batches = [];
    SRC.onExternalDrop((items) => batches.push(items));
    shell.emit('tauri://drag-drop', { type: 'over' });
    shell.emit('tauri://drag-drop', { type: 'enter' });
    shell.emit('tauri://drag-drop', { type: 'drop', paths: [] });
    await new Promise((r) => setTimeout(r, 5));
    expect(batches).toHaveLength(0);
  });

  it('has no DOM drop to read, and says so rather than pretending', () => {
    /* The browser adapter's dropItems(event) has nothing to work with here:
       there is no DataTransfer in a Tauri webview. Returning [] is honest;
       pretending to support it would silently break every drop. */
    expect(SRC.dropItems({ dataTransfer: { files: [1, 2, 3] } })).toEqual([]);
  });
});

/* ---- fullscreen, through the window ------------------------------------- */

describe('fullscreen through the window', () => {
  /* Its own block, deliberately. The shell describe loads the adapter in a
     beforeEach, so a test here that installs a second adapter races the first
     one's pending probe - and the winner is whichever resolves first, which is
     not the one under test. A clean slate per test is the only honest way to
     assert on something installed asynchronously. */

  let shell;

  /* WebKitGTK has no HTML Fullscreen API: requestFullscreen does not exist,
     document.fullscreenElement is permanently null and fullscreenchange never
     fires. The button was therefore dead on Linux, and reported nothing. */

  const install = async (options) => {
    shell = installShell(options);
    // eslint-disable-next-line no-new-func
    new Function(MIME_SRC)();
    // eslint-disable-next-line no-new-func
    new Function(SOURCE_SRC)();
    /* The hook appears only once the shell has answered, so a test that wants
       to inspect it has to let that answer land first. */
    await new Promise((resolve) => setTimeout(resolve, 0));
    return window.MediaFullscreen;
  };

  beforeEach(() => {
    delete window.MediaFullscreen;
    delete window.MediaFileSourceTauri;
  });

  afterEach(() => {
    delete window.__TAURI__;
    delete window.__TAURI_INTERNALS__;
    delete window.MediaFullscreen;
    delete window.MediaFileSourceTauri;
  });

/* ---- fullscreen, through the window ---------------------------------- */

/* WebKitGTK has no HTML Fullscreen API: requestFullscreen does not exist,
   document.fullscreenElement is permanently null and fullscreenchange never
   fires. The button was therefore dead on Linux and said nothing. These are
   the only tests that cover the route that replaced it. */

/* The hook is installed only after the shell has answered, so a test that
   wants to inspect it has to let that answer land first. Not awaiting here is
   how a test ends up asserting on undefined and blaming the adapter. */
const installWithFullscreen = async (options) => {
  shell = installShell(options);
  // eslint-disable-next-line no-new-func
  new Function(MIME_SRC)();
  // eslint-disable-next-line no-new-func
  new Function(SOURCE_SRC)();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return window.MediaFullscreen;
};

it('offers a fullscreen hook, because the HTML API is not there', async () => {
  const hook = await installWithFullscreen({});
  expect(hook).toBeDefined();
  expect(typeof hook.toggle).toBe('function');
  expect(hook.active).toBe(false);
});

it('toggles the window, and the button state follows the window', async () => {
  const hook = await installWithFullscreen({});

  await hook.toggle();
  expect(shell.options.startFullscreen).toBe(true);
  expect(hook.active).toBe(true);

  await hook.toggle();
  expect(shell.options.startFullscreen).toBe(false);
  expect(hook.active).toBe(false);
});

it('reverts its state when the window refuses, rather than lying about it', async () => {
  const hook = await installWithFullscreen({ refuseFullscreen: true });
  await expect(hook.toggle()).rejects.toThrow(/refused/);
  /* A button showing fullscreen when the window is not is worse than one
     that did nothing: the user has no way to tell the two apart. */
  expect(hook.active).toBe(false);
});

/* The window can leave fullscreen without the page asking - a window manager
   shortcut, or being dragged to another monitor. */
it('follows the window when fullscreen ends without the page asking', async () => {
  const hook = await installWithFullscreen({ startFullscreen: true });
  expect(hook.active).toBe(true);

  const seen = [];
  hook.onChange(() => seen.push(hook.active));

  shell.options.startFullscreen = false;
  shell.resize();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(hook.active).toBe(false);
  expect(seen).toContain(false);
});

it('keeps notifying the other listeners when one of them throws', async () => {
  const hook = await installWithFullscreen({ startFullscreen: true });

  let reached = false;
  hook.onChange(() => { throw new Error('a bad listener'); });
  hook.onChange(() => { reached = true; });

  shell.options.startFullscreen = false;
  shell.resize();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(reached).toBe(true);
});

/* A window manager can restore fullscreen across a crash, so the initial
   state is asked for rather than assumed to be false. */
it('starts from the window, not from an assumption', async () => {
  shell = installShell({ startFullscreen: true });
  // eslint-disable-next-line no-new-func
  new Function(MIME_SRC)();
  // eslint-disable-next-line no-new-func
  new Function(SOURCE_SRC)();

  /* Not yet: the answer has not come back, and claiming otherwise would flash
     the wrong button on every launch. */
  expect(window.MediaFullscreen).toBeUndefined();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(window.MediaFullscreen.active).toBe(true);
});

it('offers no hook when the shell cannot answer, leaving the HTML path alone', async () => {
  shell = installShell({});
  window.__TAURI__.core.invoke = (cmd) => (
    cmd === 'is_fullscreen' ? Promise.reject(new Error('no such command')) : Promise.resolve()
  );
  // eslint-disable-next-line no-new-func
  new Function(MIME_SRC)();
  // eslint-disable-next-line no-new-func
  new Function(SOURCE_SRC)();
  await new Promise((resolve) => setTimeout(resolve, 0));
  /* An older shell without the command is not a reason to break the app;
     js/media.js keeps using the page's own API in that case. */
  expect(window.MediaFullscreen).toBeUndefined();
});
});
