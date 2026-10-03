/* Headless harness shared by the end-to-end suites.
   - show:false + --headless: renders and captures without a window appearing
   - serves tests/e2e over HTTP so a suite can fetch real media files (a clip
     is far too large to inject through executeJavaScript)
   - runScript() loads a page script from disk instead of inlining it, which
     removes a whole class of escaping problems and keeps failures readable

   Audio is muted two ways by the runner (tests/e2e/run.sh): Chromium's
   --mute-audio switch, and a null sink. This file also asks the process to
   mute itself, so a suite run by hand is quiet too. */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-dev-shm-usage');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('headless');
app.commandLine.appendSwitch('mute-audio');
app.disableHardwareAcceleration();

/* A suite that throws while loading would otherwise leave Electron sitting
   there with no window and no output, and the runner would wait out its whole
   timeout. Fail fast, and say what happened. */
process.on('uncaughtException', (err) => {
  console.error('SUITE CRASHED:', err && err.stack ? err.stack : String(err));
  process.exit(1);
});

const PORT = Number(process.env.MT_TEST_PORT) || 8123;
const SERVE_DIR = path.join(__dirname, '..', 'media');
const TYPES = { '.mp4': 'video/mp4', '.png': 'image/png', '.mp3': 'audio/mpeg', '.js': 'text/javascript' };

let server = null;
function serve() {
  if (server) return Promise.resolve(server);
  server = http.createServer((req, res) => {
    const name = path.basename(decodeURIComponent(req.url.split('?')[0]));
    const file = path.join(SERVE_DIR, name);
    if (!fs.existsSync(file)) { res.writeHead(404).end(); return; }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      // the page is served from :8000 and fetches media from here
      'access-control-allow-origin': '*',
    });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(PORT, '127.0.0.1', () => r(server)));
}

async function open(opts) {
  const o = opts || {};
  await serve();
  await app.whenReady();
  const win = new BrowserWindow({
    width: o.width || 1100,
    height: o.height || 700,
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  const errors = [];
  win.webContents.on('console-message', (_e, l, m) => {
    if (l >= 2 && !/Security|Policy|Deprecat/.test(m)) errors.push(m);
  });
  win.harnessErrors = errors;
  await win.loadURL(`http://127.0.0.1:${process.env.PORT || 8000}/index.html`);
  await waitForBoot(win);

  /* The application menu, for the suites.
  
     The browser build has no menu bar - the bar belongs to the desktop shells -
     so there is nothing real for a suite to click. But the menu commands are a
     code path worth testing: a menu item that calls a different function from
     the button it replaced is exactly the bug a menu invites, and a suite that
     can only press buttons cannot catch one.

     So the harness stands in for the shell: it listens for the same commands the
     preload sends and calls the same handler the app registered. Nothing is
     reimplemented here, so a suite sending a menu command exercises the real
     route. */
  await win.webContents.executeJavaScript(`
    (() => {
      const handlers = [];
      const shell = window.MediaShell || (window.MediaShell = { shell: 'web' });
      shell.onMenuCommand = (fn) => { handlers.push(fn); return () => handlers.splice(handlers.indexOf(fn), 1); };
      shell.menuState = () => {};
      window.__menu = (command) => { for (const fn of handlers.slice()) fn(command); };
    })();
  `).catch(() => {});


  return win;
}

async function waitForBoot(win) {
  for (let i = 0; i < 80; i++) {
    const ok = await win.webContents.executeJavaScript('!!window.MediaBridge && !!window.MediaSettings').catch(() => false);
    if (ok) {
          return true;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

async function fresh(win, seed) {
  // twice: the outgoing page has a debounced save that can re-write prefs after
  // the first clear, which leaks the previous run's state into this one
  for (let i = 0; i < 2; i++) {
    await win.webContents.executeJavaScript('localStorage.clear();');
    await new Promise((r) => setTimeout(r, 250));
    await win.webContents.executeJavaScript('location.reload();');
    await new Promise((r) => setTimeout(r, 1100));
    await waitForBoot(win);
  }
  if (seed) {
    await win.webContents.executeJavaScript(
      'localStorage.setItem("mediatools.prefs", ' + JSON.stringify(JSON.stringify(seed)) + '); location.reload();',
    );
    await new Promise((r) => setTimeout(r, 1300));
    await waitForBoot(win);
  }
}

/* Copies the script to the media server and runs it as a page script. The
   script assigns its result to window.__RESULT. */
async function runScript(win, srcPath) {
  const name = '__run_' + path.basename(srcPath);
  fs.copyFileSync(srcPath, path.join(SERVE_DIR, name));
  const result = await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      window.__RESULT = undefined;
      window.__DONE = undefined;
      const s = document.createElement('script');
      s.src = 'http://127.0.0.1:${PORT}/${name}?t=' + Date.now();
      s.onload = () => {
        // the page script exposes its work as window.__DONE; onload only means
        // the file parsed, so wait for the actual completion
        const started = Date.now();
        const poll = () => {
          if (window.__DONE) {
            Promise.resolve(window.__DONE).then(() => resolve(window.__RESULT), (e) => resolve({ steps: [['THREW', String(e && e.message)]] }));
            return;
          }
          if (Date.now() - started > 60000) { reject(new Error('script never started')); return; }
          setTimeout(poll, 50);
        };
        poll();
      };
      s.onerror = () => reject(new Error('script failed to load'));
      document.head.appendChild(s);
      setTimeout(() => reject(new Error('script timed out')), 60000);
    })`, true);
  fs.rmSync(path.join(SERVE_DIR, name), { force: true });
  return result;
}

/* A page snippet for quick one-liners (no escaping surprises). */
const run = (win, code) => win.webContents.executeJavaScript(code, true);

async function shot(win, file) {
  // capturePage can hand back a stale composited frame; force a real repaint
  await win.webContents.executeJavaScript('(() => { void document.body.offsetHeight; })()');
  await win.webContents.executeJavaScript('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
  await new Promise((r) => setTimeout(r, 700));
  fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG());
}

module.exports = { app, open, fresh, run, runScript, shot, waitForBoot, PORT };
