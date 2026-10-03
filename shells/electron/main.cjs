/* The Electron shell.

   Deliberately the same job as the Tauri one, done the way Electron allows:
   the app itself is unchanged and still runs in a webview. This process supplies
   the four things a browser tab cannot - a native dialog, real paths, a place to
   keep the saved state, and a fullscreen the window will honour.

   One difference is worth naming, because it cost a bug in the Tauri shell and
   would cost the same here. Electron's Chromium refuses a media element that
   carries `crossorigin` unless the response carries CORS headers, and the player
   library always sets that attribute. So media is served from this process over
   loopback, and the page is loaded from the same origin: same-origin media is not
   subject to CORS at all, which removes the whole class of problem rather than
   papering over it.

   Everything is served by one small HTTP server rather than a custom protocol.
   A registered scheme is opaque to media elements, which puts us back where the
   Tauri build started. */

const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');

/* Where the frontend lives.

   Two layouts, and both have to work: in this repository it is `dist/` two
   directories up, and in a packaged application it sits inside the app
   directory. Probing for the page itself rather than for a marker is what makes
   the same code work in both - a packaged app that could only find one of them
   would be a build nobody tested. */
function findRoot(start) {
  for (const candidate of [
    path.resolve(start, '..', '..'),                 // this repository
    path.resolve(start, '..'),                       // packaged: app/dist
    start,
  ]) {
    if (fs.existsSync(path.join(candidate, 'dist', 'index.html'))) return candidate;
  }
  throw new Error(`cannot find the frontend: no dist/index.html near ${start}`);
}

const ROOT = findRoot(__dirname);

/* Opt-in tracing. A GUI process that hangs before it prints anything is
   indistinguishable from one that works, and the walkthrough runner needs to be
   able to say which. */
const trace = (message) => {
  if (process.env.MT_TRACE) console.log('[shell]', message);
};
const DIST = path.join(ROOT, 'dist');
const TITLE = 'Custom Media Player';
const BUNDLE_ID = 'com.almenber.custommediaplayer';

let mainWindow = null;

/* ------------------------------------------------------------------ */
/* media                                                               */
/* ------------------------------------------------------------------ */

/* The same table as js/mime.js, for the same reason: a media element decides
   what to demux from the Content-Type, and guessing turns a playable track into
   a silent failure. Anything unknown is served as a plain byte stream, which is
   honest rather than a guess. */
const CONTENT_TYPES = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/mp4',
  '.webm': 'video/webm', '.ogv': 'video/ogg',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
  '.opus': 'audio/ogg', '.flac': 'audio/flac', '.aiff': 'audio/aiff', '.aif': 'audio/aiff',
};

const contentTypeFor = (file) => CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';

/* Paths the app has actually been given, keyed by an opaque token.

   A token, not a path, and that is the whole security model: nothing on the
   machine can ask this server for a file the app did not ask for, because it
   would have to guess a token that is never rendered anywhere. */
const registry = new Map();
let nextToken = 0;

function registerMedia(file) {
  for (const [token, known] of registry) {
    if (known === file) return token;
  }
  const token = `${Date.now().toString(36)}${(nextToken++).toString(36)}`;
  registry.set(token, file);
  return token;
}

/* ------------------------------------------------------------------ */
/* one server, for the page and the media                             */
/* ------------------------------------------------------------------ */

const MIME_FOR_FILE = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
};

let server = null;
let origin = '';

function serveFile(req, res, file, { download = false } = {}) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  if (!stat.isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }

  const type = download ? contentTypeFor(file) : (MIME_FOR_FILE[path.extname(file).toLowerCase()] || 'application/octet-stream');
  const total = stat.size;

  /* Range, because without it seeking cannot work: a media element handed the
     whole file with a 200 has no way to ask for a byte range or to know where
     it is. */
  const header = req.headers.range;
  let start = 0;
  let end = total - 1;
  let status = 200;

  if (header) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
    if (match) {
      if (match[1] === '' && match[2] !== '') {
        /* A suffix range: the last N bytes. */
        start = Math.max(0, total - Number(match[2]));
        end = total - 1;
      } else {
        start = Number(match[1] || 0);
        if (match[2] !== '') end = Math.min(Number(match[2]), total - 1);
      }
      if (start > end || start >= total) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` });
        res.end();
        return;
      }
      status = 206;
    }
  }

  const length = Math.max(0, end - start + 1);
  const headers = {
    'Content-Type': type,
    'Content-Length': String(length),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${total}`;

  res.writeHead(status, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  /* Streamed, not read into memory: a two-hour film is not a buffer. */
  const stream = fs.createReadStream(file, { start, end });
  /* An error part way through is ordinary - the client seeks away and drops the
     connection - so it is not reported. */
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

function startServer() {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      let urlPath;
      try {
        urlPath = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }

      /* Media. */
      if (urlPath.startsWith('/m/')) {
        const file = registry.get(urlPath.slice(3));
        if (!file) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('not found');
          return;
        }
        serveFile(req, res, file, { download: true });
        return;
      }

      /* The page. Anything else resolves inside dist, and `..` cannot escape:
         the path is normalised and then checked against the root. */
      const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
      const target = path.resolve(DIST, relative);
      if (target !== DIST && !target.startsWith(DIST + path.sep)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('forbidden');
        return;
      }
      serveFile(req, res, target);
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${server.address().port}`;
      trace(`serving the app and its media on ${origin}`);
      resolve(origin);
    });
  });
}

/* ------------------------------------------------------------------ */
/* saved state                                                         */
/* ------------------------------------------------------------------ */

/* Where the playlist and preferences live.

   A walkthrough has to start from nothing, or "how many rows are there now" is
   answered by whatever the last run left behind: the playback journey counted
   zero rows, added one, and the run before it had already put three back, so the
   report said four and every later row count was off by the same amount. The
   Tauri runner isolates its config for the same reason and the two shells must
   not disagree about what a clean run means. */
const statePath = () => {
  const dir = (process.env.MT_STATE_DIR || '').trim();
  return dir ? path.join(dir, 'state.json') : path.join(app.getPath('userData'), 'state.json');
};

ipcMain.handle('load-state', async () => {
  try {
    const text = await fsp.readFile(statePath(), 'utf8');
    /* A corrupt file must not stop the app from starting. Losing preferences is
       far better than losing the window. */
    return JSON.parse(text);
  } catch {
    return null;
  }
});

ipcMain.handle('save-state', async (_event, state) => {
  /* Staged, then renamed: a crash mid-write must not leave a half-written file
     the next launch has to discard. */
  const target = statePath();
  const tmp = `${target}.tmp`;
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await fsp.rename(tmp, target);
});

/* ------------------------------------------------------------------ */
/* the app's own requests                                              */
/* ------------------------------------------------------------------ */

ipcMain.handle('pick-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open media',
    properties: ['openFile', 'multiSelections'],
    filters: [{
      name: 'Media',
      extensions: [
        'mp4', 'm4v', 'webm', 'ogv', 'mov', 'png', 'jpg', 'jpeg', 'gif', 'webp',
        'avif', 'bmp', 'svg', 'mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus',
        'flac', 'aiff', 'aif',
      ],
    }],
  });
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle('pick-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open a folder',
    properties: ['openDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
});

/* A folder, walked.

   It used to read one level and keep only the files it found directly, so
   choosing a folder of folders returned nothing from the subfolders - or, with
   one nested folder, the single image inside it and nothing else. Reported as
   "add folder sometimes adds one image only if there is nested folders instead
   of direct media files". The filter on isFile() was the whole bug: a
   subdirectory was not a file, so it was dropped along with its contents.

   Depth is capped, and the cap is reported rather than silent. A symlink loop
   (`a -> .`) would otherwise recurse until the process died; a home directory
   with a library of nested folders would come back with a hundred thousand
   paths and no way for the user to know why.

   Symlinks are not followed, which is what makes the cap belt-and-braces
   rather than the only defence: on Linux readdir does not report a symlink to a
   directory as isDirectory(), so it is skipped before it can be entered. */
const MAX_FOLDER_DEPTH = 12;

async function walkFolder(dir, depth, out) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    /* A folder we cannot read is not a reason to fail the whole pick: the
       caller gets whatever else was found. */
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    /* eslint-disable-next-line no-undef -- a symlink is reported by lstat, not
       by the readdir type, and following one is how a walk never ends. */
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (depth < MAX_FOLDER_DEPTH) await walkFolder(full, depth + 1, out);
      continue;
    }
    if (entry.isFile()) out.push(full);
  }
}

ipcMain.handle('list-folder', async (_event, dir) => {
  const found = [];
  await walkFolder(dir, 0, found);
  return found
    /* Sorted: a directory read comes back in whatever order the filesystem
       feels like, and a playlist that reshuffles between launches looks like a
       bug. Sorted on the full path so the order is stable across platforms. */
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
});

ipcMain.handle('file-exists', (_event, file) => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
});

ipcMain.handle('media-url', (_event, file) => `${origin}/m/${registerMedia(file)}`);

/* ------------------------------------------------------------------ */
/* the menu bar                                                       */
/* ------------------------------------------------------------------ */

/* A menu of our own.

   Electron's default bar was showing, and it had never been asked for. Every
   item in it acts on an Electron window - minimise, zoom, the dev tools, "reload"
   - rather than on this app, and "Reload" in particular threw away an unsaved
   playlist. So it was replaced rather than removed: the bar is also the one place
   where every action can carry its shortcut, which is where the app actually
   wants to be.

   Menu items do not reach into the page. They send one of the named commands
   below, and the page does what it would have done had the button been pressed -
   so the menu cannot drift away from the buttons it duplicates. That is the
   whole reason for the command table rather than a direct handler.

   A menu item that the page does not implement is disabled rather than hidden,
   so the list is the same length everywhere and a person can see that Clear
   exists and is not offered in this build. */
function send(command) {
  return () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('menu-command', command);
  };
}

function toggleItem(command, test) {
  return () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('menu-command', command);
    /* The check mark has to come from the same source as the state, or it drifts
       the moment either side changes. */
    if (test) mainWindow.setMenuItemChecked?.(command, !!test());
  };
}

function buildMenu() {
  const { Menu, MenuItem, app: electronApp } = require('electron');

  /* Read by the page, so an item can be greyed out when the thing it names is
     not there - Clear in a browser tab, Add a folder where there are no paths. */
  const can = (name) => {
    try {
      return mainWindow.webContents.executeJavaSync(
        `window.MediaFileSource && window.MediaFileSource.${name} ? true : false`,
      );
    } catch {
      return false;
    }
  };
  const isOn = (expr) => {
    try {
      return mainWindow.webContents.executeJavaSync(`!!(${expr})`);
    } catch {
      return false;
    }
  };

  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'Open Files', accelerator: 'CmdOrCtrl+O', click: send('open-files') },
        { label: 'Add Files', accelerator: 'CmdOrCtrl+Shift+O', click: send('add-files') },
        { label: 'Add Folder', click: send('add-folder'), enabled: can('openFolder') },
        { type: 'separator' },
        {
          label: 'Clear Playlist',
          accelerator: 'CmdOrCtrl+Shift+X',
          click: send('clear-playlist'),
          /* Only where a playlist can outlive the session. A clear button that
             throws everything away for nothing is worse than no clear button. */
          enabled: can('canPersist'),
        },
        { type: 'separator' },
        { role: 'quit', label: 'Quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        {
          label: 'Play / Pause',
          accelerator: 'Space',
          /* Registered as an accelerator rather than handled here, because the
             page already owns Space and owns it correctly - including the rule
             that a focused control gets it first. Two handlers would fire. */
          registerAccelerator: true,
          click: send('play-pause'),
        },
        { label: 'Previous', accelerator: ',', registerAccelerator: true, click: send('previous') },
        { label: 'Next', accelerator: '.', registerAccelerator: true, click: send('next') },
        { type: 'separator' },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: send('settings') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Show Playlist', accelerator: 'P', click: send('toggle-panel') },
        { label: 'Show Controls', accelerator: 'H', click: send('toggle-controls') },
        { type: 'separator' },
        { label: 'Default', accelerator: 'D', click: send('fit-contain') },
        { label: 'Crop', accelerator: 'C', click: send('fit-cover') },
        { label: 'Stretch', accelerator: 'S', click: send('fit-stretch') },
        { type: 'separator' },
        { label: 'Enter Fullscreen', accelerator: 'F', click: send('fullscreen') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Playback',
      submenu: [
        {
          label: 'Loop Playlist',
          type: 'checkbox',
          accelerator: 'L',
          checked: isOn('window.MediaBridge && window.MediaBridge.loop'),
          click: send('toggle-loop'),
        },
        {
          label: 'Auto Start',
          type: 'checkbox',
          accelerator: 'A',
          checked: isOn('document.getElementById("autoplay").classList.contains("on")'),
          click: send('toggle-autoplay'),
        },
      ],
    },
    {
      /* Standalone, not a submenu item.

         Settings and Info are places a person goes to deliberately, not things
         they browse for. Every application on this desktop - the browser, the
         file manager, the IDE - puts them at the top level, and burying them
         under Help is the thing that makes a menu feel old. */
      label: 'Info',
      click: send('info'),
    },
    {
      label: 'Settings',
      accelerator: 'CmdOrCtrl+,',
      click: send('settings'),
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  return menu;
}

/* ------------------------------------------------------------------ */
/* walkthrough                                                         */
/* ------------------------------------------------------------------ */

/* The same three operations the Tauri shell offers to its walkthrough, and for
   the same reason: a layout that clips its own controls, or a player that never
   starts, is invisible to a unit test because jsdom reports every element as
   visible whatever the viewport. Only a real window shows it.

   Opt-in behind --walkthrough, and never part of a normal launch. */

ipcMain.handle('diagnostic-set-size', (event, size) => {
  const target = BrowserWindow.fromWebContents(event.sender);
  if (target && size && size.width > 0 && size.height > 0) {
    /* The content size, not the outer one: the decorations are not layout. */
    target.setContentSize(Math.round(size.width), Math.round(size.height));
  }
});

ipcMain.handle('diagnostic-simulate-drop', (_event, paths) => {
  /* Nothing to do at the shell level: Electron delivers drops to the page as a
     DOM event, so the journey dispatches it there. The paths travel with it. */
  return Array.isArray(paths) ? paths.length : 0;
});

/* ------------------------------------------------------------------ */
/* window                                                              */
/* ------------------------------------------------------------------ */

/* Fullscreen at the window level, for the same reason as the Tauri shell: the
   page asks for it, and the window is what can actually do it. Electron's
   Chromium does have the HTML API, but going through the window keeps the two
   shells behaving identically, which matters more than the route taken. */
ipcMain.on('set-fullscreen', (event, on) => {
  const target = BrowserWindow.fromWebContents(event.sender);
  if (target) target.setFullScreen(Boolean(on));
});

ipcMain.handle('is-fullscreen', (event) => {
  const target = BrowserWindow.fromWebContents(event.sender);
  return target ? target.isFullScreen() : false;
});

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 700,
    minWidth: 480,
    minHeight: 420,
    title: TITLE,
    backgroundColor: '#000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  /* Shown once painted, so a launch never flashes an empty white box. */
  mainWindow.once('ready-to-show', () => mainWindow.show());

  /* The menu needs the page to exist: two of its items are greyed out or ticked
     from what the page says. Built when the window is created rather than at
     app-ready, because `can()` reads the page and would answer "no" for
     everything. */
  buildMenu();

  /* Nothing in this app should ever open a second window or navigate away. A
     link to somewhere else would leave the user in a page with no way back. */
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  /* The two checkbox items follow the page. Without this they are whatever they
     were at build time, which is "off" - so Loop would show unticked while the
     playlist was looping, and unticking it in the menu would be the only way to
     see the truth. */
  mainWindow.webContents.on('menu-state', (_e, state) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.setMenuItemChecked?.('toggle-loop', !!state.loop);
    mainWindow.setMenuItemChecked?.('toggle-autoplay', !!state.autoplay);
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) event.preventDefault();
  });

  trace('window created; loading the page');
  await mainWindow.loadURL(`${origin}/index.html`);
  trace('page loaded');

  /* Walkthrough mode, opted into on the command line or the environment.

     Run straight away rather than on did-finish-load: loadURL has already
     resolved, which *is* the page having finished loading. Waiting for an event
     that has already happened meant the walkthrough never started and the run
     sat until it timed out with nothing at all to report. */
  if (walkthroughRequested) {
    /* The same script the Tauri shell runs, read from one place, so the two
       shells cannot drift apart on what a journey means. */
    const script = fs.readFileSync(path.join(ROOT, 'tests', 'e2e', 'walkthrough.js'), 'utf8');

    /* The same probe file the Tauri shell is given, for the same reason: a
       walkthrough that cannot ask "does a real file play" is checking the shell
       and not the application. Without this the playback journey is silently
       skipped and the run still says PASS, which is the worst kind of pass. */
    const probeFile = process.env.MT_PROBE_FILE || '';
    const probeAudio = process.env.MT_PROBE_AUDIO || '';
    const preamble =
      `window.__PROBE_FILE__ = ${JSON.stringify(probeFile)};` +
      ` window.__PROBE_MP3__ = ${JSON.stringify(probeAudio)};`;

    trace(`starting the walkthrough${probeFile ? ' with a probe file' : ' WITHOUT a probe file'}`);
    mainWindow.webContents.executeJavaScript(`${preamble}\n${script}`).catch((err) => {
      console.error('[walkthrough] could not start:', err && err.message);
    });
    setTimeout(() => {
      mainWindow.webContents
        .executeJavaScript('window.__WALKTHROUGH_REPORT__ || {}')
        .then((report) => {
          console.log('--- custom media player: walkthrough ---');
          for (const [key, value] of Object.entries(report)) {
            console.log(`  ${key.padEnd(28)} ${value}`);
          }
          console.log('--- end walkthrough ---');
          const passed = report.walkthrough_verdict && String(report.walkthrough_verdict).startsWith('PASS');
          app.exit(passed ? 0 : 1);
        })
        .catch((err) => {
          console.error('[walkthrough] no report:', err && err.message);
          app.exit(1);
        });
    }, 30000);
  }
}

trace('main entered');
/* Chromium parses the app's arguments too, and an unrecognised switch can be
   swallowed before the app ever sees it - which is why `--walkthrough` on its
   own was ignored. The environment variable is the reliable route, and the flag
   is kept for a person running it by hand. */
const walkthroughRequested =
  process.argv.includes('--walkthrough') || Boolean(process.env.MT_WALKTHROUGH);
trace(`argv=${JSON.stringify(process.argv.slice(1))} walkthrough=${walkthroughRequested}`);
app.whenReady().then(async () => {
  trace('electron ready');
  try {
    await startServer();
  } catch (err) {
    /* Without the loopback port nothing local can play, and saying so beats
       launching an app that quietly refuses every file. */
    console.error('[shell] cannot open a local port:', err && err.message);
    dialog.showErrorBox(TITLE, 'This build could not open a local port, so local files cannot be played.');
    app.exit(1);
    return;
  }
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* Also stop the server, or a quit leaves the process alive holding the port. */
app.on('will-quit', () => {
  if (server) server.close();
});

module.exports = { BUNDLE_ID, ROOT };