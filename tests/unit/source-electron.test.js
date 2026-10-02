/* The Electron file source, driven against a stubbed shell.

   The same contract as js/source-tauri.js, and the same reason for testing it:
   the shell is the only thing this module talks to, and a stub makes every path
   through it reproducible here without a display, a webview or a filesystem.

   What this cannot cover is the shell itself - the loopback server, the native
   dialog, the real window. Those are what tests/e2e/electron-desktop.sh and the
   walkthrough are for. Between the two, the parts that need a person with a
   screen are few and named. */

import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../helpers/app-harness.js';

const MIME_SRC = fs.readFileSync(path.join(ROOT, 'js/mime.js'), 'utf8');
const SOURCE_SRC = fs.readFileSync(path.join(ROOT, 'js/source-electron.js'), 'utf8');

/* A stand-in for the preload's window.MediaShell.
   `realDrop` decides whether dropped files come back with a path, which is the
   one thing Electron changed and the one thing worth getting wrong. */
function installShell(options = {}) {
  const calls = [];
  const state = { fullscreen: options.startFullscreen === true };
  const listeners = {};

  const shell = {
    shell: 'electron',
    pickFiles: () => {
      calls.push(['pick-files']);
      return Promise.resolve(options.files || []);
    },
    pickFolder: () => Promise.resolve(options.folder === undefined ? null : options.folder),
    listFolder: () => Promise.resolve(options.folderContents || []),
    fileExists: (file) => Promise.resolve(!(options.missing || []).includes(file)),
    loadState: () => Promise.resolve(options.state === undefined ? null : options.state),
    saveState: (value) => {
      calls.push(['save-state', value]);
      return options.failSave ? Promise.reject(new Error('disk full')) : Promise.resolve();
    },
    mediaUrl: (file) => {
      if ((options.urlFails || []).includes(file)) {
        return Promise.reject(new Error('could not open a local port'));
      }
      return Promise.resolve(`http://127.0.0.1:35415/m/${Buffer.from(file).toString('hex').slice(0, 16)}`);
    },
    setFullscreen: (on) => {
      if (options.refuseFullscreen) throw new Error('the window refused to go fullscreen');
      state.fullscreen = Boolean(on);
    },
    isFullscreen: () => Promise.resolve(state.fullscreen),
    /* File.path was removed from Electron; the preload is the only place a path
       can be recovered, so the stub stands in for it here. */
    pathForFile: (file) => {
      if (options.realDrop === false) return '';
      return file && file.path !== undefined ? file.path : '';
    },
    walkthrough: {
      setSize: vi.fn(),
      isFullscreen: () => Promise.resolve(state.fullscreen),
      simulateDrop: vi.fn(),
    },
  };

  window.MediaShell = shell;
  return { shell: state, calls, listeners, options };
}

const dropEvent = (files) => ({ dataTransfer: { files } });

describe('the Electron source', () => {
  let SRC;

  const load = (options) => {
    installShell(options);
    // eslint-disable-next-line no-new-func
    new Function(MIME_SRC)();
    // eslint-disable-next-line no-new-func
    new Function(SOURCE_SRC)();
    SRC = window.MediaFileSourceElectron;
  };

  afterEach(() => {
    delete window.MediaShell;
    delete window.MediaFileSourceElectron;
    delete window.MediaFullscreen;
  });

  it('registers nothing without the shell, so index.html can always include it', () => {
    // eslint-disable-next-line no-new-func
    new Function(MIME_SRC)();
    // eslint-disable-next-line no-new-func
    new Function(SOURCE_SRC)();
    /* A desktop adapter present in a browser would be selected by js/source.js
       and the app would then ask a shell that is not there for everything. */
    expect(window.MediaFileSourceElectron).toBeUndefined();
  });

  it('registers when the preload is there', () => {
    load({});
    expect(SRC).toBeDefined();
    for (const name of ['canPersist', 'openFiles', 'openFolder', 'urlFor', 'release', 'loadState', 'saveState', 'fileExists', 'dropItems']) {
      expect(typeof SRC[name]).toBe('function');
    }
  });

  it('turns chosen paths into playable items', async () => {
    load({ files: ['/media/holiday.mp4', '/media/notes.txt', '/media/shot.PNG'] });
    const items = await SRC.openFiles();
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ name: 'holiday.mp4', kind: 'video', path: '/media/holiday.mp4' });
    /* the unplayable one is marked, not silently typed as video */
    expect(items[1].kind).toBeNull();
    /* the extension test is case-insensitive, so an upper-case name works */
    expect(items[2]).toMatchObject({ name: 'shot.PNG', kind: 'image', mime: 'image/png' });
  });

  it('keeps the name from the end of a Windows path', async () => {
    load({ files: ['C:\\Users\\me\\Videos\\clip.mov'] });
    const items = await SRC.openFiles();
    expect(items[0].name).toBe('clip.mov');
    expect(items[0].path).toBe('C:\\Users\\me\\Videos\\clip.mov');
  });

  it('gives an opened file a URL the media stack can open', async () => {
    load({ files: ['/media/a b/clip.mp4'] });
    const [item] = await SRC.openFiles();
    expect(item.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/m\//);
    /* The player asks repeatedly; the answer cannot change, so it is kept. */
    expect(SRC.urlFor(item)).toBe(item.url);
  });

  it('refuses an item with no path, with a message that says why', () => {
    load({});
    expect(() => SRC.urlFor({ name: 'x.mp4' })).toThrow(/no path/);
  });

  it('says so plainly when the shell could not give a URL', async () => {
    load({ files: ['/media/clip.mp4'], urlFails: ['/media/clip.mp4'] });
    const [item] = await SRC.openFiles();
    expect(item.url).toBeNull();
    expect(() => SRC.urlFor(item)).toThrow(/could not give/);
  });

  it('filters a folder with the shared table, so documents become no rows', async () => {
    load({ folder: '/media', folderContents: ['/media/clip.mp4', '/media/notes.txt'] });
    const items = await SRC.openFolder();
    expect(items.map((i) => i.name)).toEqual(['clip.mp4']);
  });

  /* Awaited, and the await is the assertion as much as the result is.

     A dropped file has to be given a playable URL, and that is an IPC round
     trip, so dropItems is a promise. These tests asserted on a bare array, which
     is the shape the adapter had while it was broken: it returned the items
     without asking for a URL, the row appeared, and it could never play. A test
     written against the broken shape passes on the broken code. */
  it('reads a DOM drop, which is the one thing it does that Tauri cannot', async () => {
    load({});
    const items = await SRC.dropItems(dropEvent([{ path: '/media/dropped.mp4' }, { path: '/media/song.mp3' }]));
    expect(items.map((i) => i.name)).toEqual(['dropped.mp4', 'song.mp3']);
  });

  /* The regression the await above allowed through: a drop that resolves a URL,
     because a drop that does not is a row that appears and can never play. */
  it('gives every dropped file a URL, not just the ones opened from a dialog', async () => {
    load({});
    const [item] = await SRC.dropItems(dropEvent([{ path: '/media/dropped.mp4' }]));
    expect(item.url).toBeTruthy();
    expect(() => SRC.urlFor(item)).not.toThrow();
  });

  /* A drop the shell cannot resolve a path for leaves a row that can never
     play, so it is refused - the same rule as openFiles, which already had it. */
  it('refuses a dropped file with no recoverable path', async () => {
    load({ realDrop: false });
    expect(await SRC.dropItems(dropEvent([{ name: 'mystery.mp4' }]))).toEqual([]);
  });

  it('has nothing to read in a drop with no files', async () => {
    load({});
    expect(await SRC.dropItems(dropEvent([]))).toEqual([]);
    expect(await SRC.dropItems({})).toEqual([]);
    expect(await SRC.dropItems(null)).toEqual([]);
  });

  it('re-registers restored rows instead of trusting a saved URL', async () => {
    load({
      state: {
        items: [
          { name: 'one.mp4', path: '/media/one.mp4', kind: 'video', url: 'http://127.0.0.1:9999/m/stale' },
        ],
      },
    });
    const state = await SRC.loadState();
    expect(state.items[0].url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/m\//);
    expect(state.items[0].url).not.toContain('9999');
  });

  it('does not write a dead URL into the saved state', async () => {
    const harness = installShell({ files: ['/media/clip.mp4'] });
    // eslint-disable-next-line no-new-func
    new Function(MIME_SRC)();
    // eslint-disable-next-line no-new-func
    new Function(SOURCE_SRC)();
    const source = window.MediaFileSourceElectron;
    const [item] = await source.openFiles();
    await source.saveState({ items: [item], index: 0 });

    const saved = harness.calls.find(([cmd]) => cmd === 'save-state');
    expect(saved[1].items[0].url).toBeUndefined();
    expect(saved[1].items[0].path).toBe('/media/clip.mp4');
  });

  it('keeps only the keys it is supposed to persist', async () => {
    const harness = installShell({});
    // eslint-disable-next-line no-new-func
    new Function(MIME_SRC)();
    // eslint-disable-next-line no-new-func
    new Function(SOURCE_SRC)();
    await window.MediaFileSourceElectron.saveState({ index: 1, position: 5, secret: 'do not keep', items: [] });
    const saved = harness.calls.find(([cmd]) => cmd === 'save-state')[1];
    expect(saved.index).toBe(1);
    expect(saved.position).toBe(5);
    expect(saved.secret).toBeUndefined();
  });

  it('reports a file that has moved', async () => {
    load({ missing: ['/media/gone.mp4'] });
    expect(await SRC.fileExists({ path: '/media/gone.mp4' })).toBe(false);
    expect(await SRC.fileExists({ path: '/media/here.mp4' })).toBe(true);
  });

  it('does not call a file gone when it simply cannot tell', async () => {
    load({});
    window.MediaShell.fileExists = () => Promise.reject(new Error('no such command'));
    /* A false "gone" would hide a file the user still has, which is the worse
       failure of the two. */
    expect(await SRC.fileExists({ path: '/media/clip.mp4' })).toBe(true);
  });

  it('says a failed save failed, rather than swallowing it', async () => {
    load({ failSave: true });
    const seen = [];
    document.addEventListener('mediatools:save-error', (e) => seen.push(e));
    await SRC.saveState({ items: [] });
    expect(seen).toHaveLength(1);
  });

  it('release keeps the URL, because there is nothing to give back', async () => {
    load({ files: ['/media/clip.mp4'] });
    const [item] = await SRC.openFiles();
    const first = SRC.urlFor(item);
    SRC.release(item);
    expect(item.url).toBe(first);
    expect(() => SRC.urlFor(item)).not.toThrow();
    expect(() => SRC.release(null)).not.toThrow();
  });

  /* ---- fullscreen ---------------------------------------------------- */

  it('offers a fullscreen hook that asks the window', async () => {
    load({});
    const hook = window.MediaFullscreen;
    expect(typeof hook.toggle).toBe('function');
    hook.toggle();
    expect(hook.active).toBe(true);
    expect(window.MediaShell.isFullscreen).toBeDefined();
  });

  it('reverts its state when the window refuses', () => {
    load({ refuseFullscreen: true });
    const hook = window.MediaFullscreen;
    expect(() => hook.toggle()).toThrow(/refused/);
    expect(hook.active).toBe(false);
  });

  it('starts from the window, not from an assumption', async () => {
    load({ startFullscreen: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(window.MediaFullscreen.active).toBe(true);
  });

  it('keeps notifying the other listeners when one of them throws', () => {
    load({});
    const hook = window.MediaFullscreen;
    let reached = false;
    hook.onChange(() => { throw new Error('a bad listener'); });
    hook.onChange(() => { reached = true; });
    hook.toggle();
    expect(reached).toBe(true);
  });
});