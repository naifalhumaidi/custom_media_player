# Media Tools

A local media player for images, video and audio. Drop files in, play them
through as a playlist, and the app remembers where you were.

No build step, no framework, no network. Vanilla JavaScript, a vendored copy of
one playback library, and a 105-line static file server.

**English | [العربية](README.ar.md)**

---

## Running it

```bash
npm install      # only needed for the tests
npm start        # http://localhost:8000
```

`npm start` runs `serve.js`, a dependency-free static server. Opening
`index.html` directly from the filesystem does **not** work: custom elements and
module loading both need a real origin.

If port 8000 is busy the server picks another one and prints it.

## Using it

**Add files** — drag them onto the window, or onto the playlist panel. A drop on
the window starts playing; a drop on the panel appends without interrupting what
is already playing.

**Play** — click the picture, or press <kbd>Space</kbd>. Double-click the picture
for fullscreen.

**Reorder** — drag a playlist row. The list reflows as you drag, so what you see
mid-drag is the result. Let go outside the list to cancel.

**Everything else** — press <kbd>?</kbd> for the full list of shortcuts and keys.
They are also all in `requirements.md` §6.

### Keyboard

| Key | Action |
|---|---|
| <kbd>Space</kbd> <kbd>Enter</kbd> <kbd>K</kbd> | Play / pause |
| <kbd>.</kbd> / <kbd>,</kbd> | Next / previous item |
| <kbd>←</kbd> <kbd>→</kbd> | Seek ∓10s |
| <kbd>↑</kbd> <kbd>↓</kbd> | Volume |
| <kbd>M</kbd> | Mute |
| <kbd>F</kbd> | Fullscreen |
| <kbd>L</kbd> | Loop the playlist |
| <kbd>A</kbd> | Auto-start the next item |
| <kbd>D</kbd> <kbd>C</kbd> <kbd>S</kbd> | Fit: default / crop / stretch |
| <kbd>H</kbd> | Show or hide the control bar |
| <kbd>P</kbd> | Show or hide the playlist |
| <kbd>?</kbd> <kbd>I</kbd> | Instructions |
| <kbd>⇧X</kbd> | Clear the playlist |
| <kbd>Esc</kbd> | Close whatever is open |

Arrow keys are left to a focused slider, and typing in the settings dialog is
left to the dialog.

### Settings

The gear in the bar opens Settings.

- **Language** — English or العربية. The whole interface mirrors, including the
  seek bar, the panel and the digits.
- **Logo** — use your own image on the start window, or remove it. The button
  also puts the shipped one back, so removing it is never a dead end.
- **Brand colour** — any colour. The logo's own gold, `#aa7827`, is the default,
  and the button next to the picker restores it.

Large logos are downscaled before they are stored. If the browser's storage is
full anyway, the settings dialog says so rather than silently losing your other
preferences.

## What is remembered

Volume, mute, the fit mode, the loop and auto-start toggles, whether the bar and
the panel are open, your position, the language, the logo and the brand colour.

The playlist itself is **not** remembered in the browser: a file dropped into a
page is only a name, and storing the list would produce a playlist of rows that
cannot play. That is what the desktop shell is for — see below.

## Tests

```bash
npm test           # 84 unit tests, jsdom, no browser
npm run test:media # build the fixtures (needs ffmpeg)
npm run test:e2e   # 5 headless browser suites
npm run test:all
```

`npm test` loads the real `index.html` and the real scripts, and fakes only the
playback library — the boundary `js/media.js` exists to isolate. That keeps the
tests fast and deterministic without letting them drift away from the shipped
markup.

`npm run test:e2e` needs an Electron binary (`/usr/lib/electron41/electron`, or
set `ELECTRON_BIN`). It starts the app server itself and **routes test audio to
a null sink**, so running the suites never makes a sound.

## Layout

    src/            the application, in TypeScript
      types.ts      the contracts the three shells all keep to
      core/         what a file IS
      source/       browser, tauri, electron, and the selector between them
      bridge/       the only file that knows a media library exists
      ui/           translations and settings
      app.ts        the application
    js/             generated from src/ by esbuild, and committed
    shells/
      electron/     the Electron main process and its preload
      tauri/        the Rust source lives in src-tauri
    tests/
      unit/         vitest, jsdom, the real index.html
      e2e/          the runner, the Chromium suites, and the walkthrough
    scripts/        the build, the packaging, the frontend allowlist
    docs/           this and its translations
    artifacts/      built binaries (not committed)

js/ is generated and committed. It is the shipped artifact, so a fresh clone can
open the page with no toolchain at all. `npm run build:web` regenerates it, and
`npm run typecheck` runs the compiler over src/ without emitting anything - it is
wired into `pretest`, so every test run type-checks first.

The compiled output is one classic script per source file and unbundled, because
index.html loads plain <script> tags and each file registers a global. A bundle
would leave the load order implicit, and js/ unreadable in a browser's sources
panel.

## The desktop apps

The same code in a native window, with real file paths, native dialogs, and a
playlist that survives a restart. Two shells, one application.

```bash
# Tauri - the small one. Rust, WebKitGTK on Linux, WebView2 on Windows.
npm run desktop:dev      # build the web assets, then launch
npm run desktop:build    # .deb and friends

# Electron - the predictable one. Bundles its own Chromium.
tests/e2e/electron-run.sh                    # against the installed Electron
npm run package:electron -- linux win32     # self-contained (~250 MB each)
```

Neither shell is a fork. `src/source/` holds one adapter per environment and
`src/source/index.ts` picks between them; `app.js` - now `src/app.ts` - contains
no `if (isTauri)` anywhere and none of the adapters knows the others exist.

Both are tested the same way, by the same walkthrough driving the same journeys
in a real window. See [`docs/desktop.md`](docs/desktop.md) - including why a
video player built on WebKitGTK cannot play a local file until the shell serves
it, and how to check whether a machine can decode H.264 at all.

## Design notes

A few decisions that are not obvious from the code, and that the code explains
at more length where they live:

- **The playback library is quarantined.** `js/media.js` is the only file that
  knows Vidstack exists, and it is the escape hatch: replacing the library means
  rewriting that one file, not the app.
- **No borders anywhere.** A selected or focused thing is a flat background
  plus a 2px inset edge. Every edge drawn as a hard border reads as a stray
  grey line, which is exactly what the design brief rules out.
- **The panel is full height and the bar sits on top of it.** The alternative —
  shortening the panel to make room — costs the bar its full width and leaves a
  gap that changes as the bar wraps.
- **The library's keyboard map is cleared.** It binds `l`, `j`, the arrows, `m`,
  `f` and `c` by default, and it reads the same key events the app does, so
  every letter fired twice. The app owns and documents every shortcut.
- **A brand colour is a set of CSS custom properties.** Changing the colour is
  one style write, and both stylesheets follow.

## Not built yet

Streaming (HLS/DASH), captions, speed control, picture-in-picture, editing,
tag reading, multiple windows, and any network source. Keyboard reordering of
the playlist is a real accessibility gap: a row can be played and removed from
the keyboard, but not moved.
