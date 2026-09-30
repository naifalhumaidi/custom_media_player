/* The only bridge between the page and Node.

   Context isolation is on and node integration is off, so the page cannot reach
   anything by accident: this file decides exactly what it can. Everything here
   is a named operation the app needs, with no way to pass an arbitrary command
   through - a generic `invoke(name, args)` would hand the page the whole IPC
   surface and throw away the reason for the isolation. */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

/* Filled in by dropFilesForTest, drained by pathForFile. Set in the page's own
   context on purpose: it is a test hook, and it must not be reachable in a
   normal build. */
let pendingDrop = null;

contextBridge.exposeInMainWorld('MediaShell', {
  /* which shell this is, so js/source.js can pick the right adapter */
  shell: 'electron',

  pickFiles: () => ipcRenderer.invoke('pick-files'),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  listFolder: (dir) => ipcRenderer.invoke('list-folder', dir),
  fileExists: (file) => ipcRenderer.invoke('file-exists', file),

  loadState: () => ipcRenderer.invoke('load-state'),
  saveState: (state) => ipcRenderer.invoke('save-state', state),

  mediaUrl: (file) => ipcRenderer.invoke('media-url', file),

  setFullscreen: (on) => ipcRenderer.send('set-fullscreen', on),
  isFullscreen: () => ipcRenderer.invoke('is-fullscreen'),

  /* The same handful of operations the Tauri walkthrough has, under Electron's
     own names. Deliberately not a generic `invoke`: this would otherwise hand the
     page the entire IPC surface, which is the thing context isolation exists to
     prevent, and a walkthrough is not worth that. */
  walkthrough: {
    setSize: (width, height) => ipcRenderer.invoke('diagnostic-set-size', { width, height }),
    isFullscreen: () => ipcRenderer.invoke('is-fullscreen'),
    simulateDrop: (paths) => ipcRenderer.invoke('diagnostic-simulate-drop', paths),
  },

  /* Puts real File objects on a pending drop, so the DOM-drop journey can be
     driven the way a person drives it rather than by calling the adapter. Paths
     come from the shell, which is the only place a File can become one. */
  dropFilesForTest: (paths) => {
    if (!pendingDrop) pendingDrop = [];
    pendingDrop.push(...paths);
  },
  takeDropPaths: () => (pendingDrop || []).splice(0),

  /* A real path for a dropped File.

     `File.path` was removed from Electron, and `webUtils.getPathForFile` is the
     replacement. It only works in a preload - which is why this exists at all,
     and why the adapter asks the shell rather than trying to read a path off the
     file object. Returns '' for anything that is not a real file, which the
     adapter treats as "no path" rather than as a row that cannot play. */
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
});