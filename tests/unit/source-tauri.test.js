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
    event: {
      listen: (name, fn) => {
        listeners[name] = fn;
        return Promise.resolve(() => { delete listeners[name]; });
      },
    },
  };
  return { calls, listeners, emit: (name, payload) => listeners[name] && listeners[name]({ payload }) };
}

describe('registration', () => {
  afterEach(() => {
    delete window.__TAURI__;
    delete window.__TAURI_INTERNALS__;
    delete window.MediaFileSourceTauri;
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

  it('resolves a path to an asset URL, and caches it', async () => {
    const item = { path: '/media/a b/clip.mp4' };
    const first = SRC.urlFor(item);
    expect(first).toBe('asset://localhost//media/a%20b/clip.mp4');
    /* the player asks repeatedly, and re-encoding a long path each time would
       be work for nothing */
    expect(SRC.urlFor(item)).toBe(first);
  });

  it('refuses an item with no path, with a message that says why', () => {
    expect(() => SRC.urlFor({ name: 'x.mp4' })).toThrow(/no path/);
  });

  it('release clears the cached URL and keeps the path', async () => {
    const item = { path: '/media/clip.mp4' };
    const first = SRC.urlFor(item);
    SRC.release(item);
    expect(item.url).toBeNull();
    expect(item.path).toBe('/media/clip.mp4');
    /* still resolvable, so a clear-undo can bring the row back */
    /* The same path always yields the same asset URL - that is the point of a
       URL. What matters is that the item is still resolvable afterwards. */
    expect(() => SRC.urlFor(item)).not.toThrow();
  });

  it('release is safe to call twice and on nothing', () => {
    const item = { path: '/media/clip.mp4' };
    SRC.urlFor(item);
    SRC.release(item);
    expect(() => SRC.release(item)).not.toThrow();
    expect(() => SRC.release(null)).not.toThrow();
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
