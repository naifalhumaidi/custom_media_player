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

```
index.html          markup and the inline SVG icon sprite
app.js              all application state: playlist, panel, drops, keys, dialogs
js/media.js         the only file that knows a playback library exists
js/source.js        picks the file-source adapter
js/source-web.js    the browser adapter: object URLs, MIME types, persistence
js/i18n.js          English and Arabic
js/settings.js      language, logo, brand colour
styles.css          the chrome
styles-vidstack.css styles for the library's own controls
serve.js            the static file server
vendor/             Vidstack 1.15.6 (MIT) + its licence
tests/unit/         vitest suites
tests/e2e/          headless browser suites
```

`requirements.md` is the specification of record. The rest is in [`docs/`](docs/):
[analysis](docs/analysis.md), [system design](docs/system-design.md),
[architecture](docs/architecture.md), and
[the desktop build](docs/desktop.md).

## The desktop app

The same code in a native window, with real file paths and a playlist that
survives a restart.

```bash
npm run desktop:dev      # build the web assets, then launch
npm run desktop:build    # .deb, .appimage, .msi, setup.exe
```

See [`docs/desktop.md`](docs/desktop.md) — including how to check whether the
machine can actually decode H.264, which on Linux is the one thing that silently
breaks a video player.

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
