# The desktop build

The same app in a native window. No build step for the web version, no server,
no install for the browser one — the desktop shell is what you hand someone.

**English | [العربية](desktop.ar.md)**

---

## 1. What it is

A Tauri 2 window around the existing application. The playlist, the panel, the
transport, the settings and the localisation are all the code already in this
repository, unchanged. The shell supplies the three things a browser tab cannot:

| | Browser | Desktop |
|---|---|---|
| Adding files | `<input type=file>` | the OS file dialog |
| Where files live | a `blob:` URL that dies with the tab | a real path |
| The playlist next launch | impossible | written as paths |
| Dropping files | a DOM `DragEvent` with `File` objects | `tauri://drag-drop` with paths |
| Preferences | `localStorage` | a JSON file in the config directory |

That is the whole difference. Everything else is the same app.

## 2. Running it

```bash
npm install
npm run desktop:dev        # builds the web assets, then launches with hot reload of Rust
npm run desktop:build      # produces installers
```

`npm run desktop:dev` assembles `dist/` first. The bundler never sees the
repository: `scripts/build-frontend.mjs` copies an explicit allowlist of files,
so `node_modules`, the tests and the documentation cannot end up in a shipped
build, and a file that the page needs but the list has forgotten fails the build
rather than shipping an app with a missing script.

### Output

| Target | Platform | Built by |
|---|---|---|
| `.pkg.tar.zst` | Arch / CachyOS | `packaging/PKGBUILD` |
| `.AppImage` | any Linux x86-64 | `tauri build` |
| `.deb` | Debian, Ubuntu | `tauri build` (needs `dpkg-deb`) |
| `.msi` | Windows | `tauri build` |
| `setup.exe` (NSIS) | Windows | `tauri build` |

**Building for Arch**

```bash
npm run build:web
npx tauri build --no-bundle      # the binary, with the web assets inside it
cd packaging && makepkg -f       # -> custom-media-player-1.0.0-1-x86_64.pkg.tar.zst
sudo pacman -U ../packaging/custom-media-player-1.0.0-1-x86_64.pkg.tar.zst
```

`gst-plugins-good` is a **hard dependency** of the package, not an optional one.
Without the MP4 demuxer the app launches and silently plays nothing, and that is
the most confusing failure on this platform — so the package refuses to install
into a system that would have it.

**Building for Windows**

The Windows targets are configured and the code is platform-neutral, but a
Windows installer cannot be produced from Linux: it needs the MSVC toolchain and
the WebView2 SDK. Run `npm install && npm run desktop:build` on a Windows
machine, or on a Windows CI runner. §8 is the verification checklist for when you
do.

## 3. What is verified, and what is not

Being precise about this, because "it builds" is not "it works" and the
difference matters when you hand it to someone.

**Verified by running the release binary on a virtual display**

Everything below was produced by `tests/e2e/desktop.sh`, which runs the built
binary under `Xvfb` with audio routed to a sink with no output. Nothing is drawn
and nothing is heard.

- the shell builds, launches, opens its window, and the page mounts
- `js/source-tauri.js` registers and `js/source.js` selects it — the diagnostic
  reports `active_source: desktop`
- `MediaBridge` mounts
- **a real H.264 file plays.** A 127 KB file off disk, through the same call the
  app makes, reaches `readyState 4`
- **an MP3 plays**, same route
- **the window goes fullscreen and comes back.** Not through the page: WebKitGTK
  has no HTML Fullscreen API, so the page cannot do it
- **a dropped file arrives carrying a playable URL** — the shell emits the event
  the platform emits, covering the event, the adapter and the registration. It
  stops at the toolkit boundary, because no machine can invent a pointer drag
- **the playlist survives a restart.** The previous run's `state.json` is read
  through the adapter, and every row is re-registered with the shell
- **the native dialog command exists and opens something** — raced against a
  timer, since a command that never settles is a dialog waiting for a click
- `window.__TAURI__` is reachable, with `invoke` and `event.listen`

**Verified without a screen**

- `cargo test` — 17 tests: the state file, the staged write, folder listing
  order, the existence check, and eleven over the loopback media server
  (whole file, both range forms, content type, an unknown token, a path in a
  URL, a deleted file, an empty file, stable tokens)
- `npm test` — 155 tests, including 27 over the desktop adapter against a
  stubbed shell
- the five browser e2e suites

**Still needs a human**

- the native dialogs *returning* a chosen path. That needs a click. The command
  is confirmed present and the window opens; what happens after the click is not
  machine-checkable
- how it looks and feels on a real screen, at real window sizes
- the Windows build, which is cross-compiled and has never been run (§8)

## 3b. How a journey is actually tested

A unit test cannot see a control that is clipped off the edge of a real window,
because jsdom reports every element as visible whatever the viewport. Nor can it
see a control that is present and does nothing. Both of those were real bugs
here, and neither was visible from the code.

So there is a walkthrough: `tests/e2e/walkthrough.js`, run by both desktop
shells against the real application in a real window.

    ./tests/e2e/desktop.sh --walkthrough        # Tauri
    ./tests/e2e/electron-desktop.sh --walkthrough   # Electron

It does what a person does:

  1. resize the window to 1600x1000, 1280x800, 1024x640, 800x520 and 520x440,
     and check every control is inside the viewport and has a size
  2. drop a real file on the window and check the playlist grows
  3. play it: is the duration known, is the time advancing, does seek work
  4. pause
  5. press `f` and check the window went fullscreen and came back
  6. check a moved file keeps its row rather than vanishing

One script, both shells, so a journey cannot mean one thing in Tauri and another
in Electron. It waits for conditions rather than for a length of time - a fixed
sleep reported a working player as broken on a cold start, which is worse than
not testing.

**A note on what it cannot check.** It drives the drop through the shell's own
event, so everything the app owns is covered - the event, the adapter, the URL
registration - and it stops at the toolkit boundary, because no machine can
invent a pointer drag. The Chromium suites in tests/e2e cannot catch the layout
bug at all: the player library sizes itself differently there, so the same CSS
passes in Electron and fails on WebKitGTK. That asymmetry is the reason a
walkthrough on the real engine exists at all.

## 3a. Three bugs that were not bugs in this app

Both were reported as "it has bugs". Neither was in the application logic; both
were platform facts that the shell had to accommodate. They are written down
here because the obvious fix — using Tauri's documented `convertFileSrc` and
the HTML Fullscreen API — is wrong on Linux, and the next person will try it.

### Local files could not be played at all

On Linux the webview decodes through GStreamer, and GStreamer resolves media URIs
with its own URI handlers. Tauri registers its `asset://` protocol with WebKit's
network layer only, so a media element pointed at `asset://localhost/...` never
gets a byte:

```
No URI handler implemented for "asset"   (missing-plugin)
```

Every alternative was measured, and each fails:

| URL | why it fails |
|---|---|
| `asset://localhost/...` | Tauri serves it; GStreamer has no handler |
| `tauri://localhost/...` | the app's own origin; likewise no handler |
| `file:///...` | WebKit refuses local resources for a page that is not itself a file |
| `http://asset.localhost/...` | that is the *Windows* form of the asset protocol; nothing listens on Linux |
| `data:...` | works, and is unusable for a two-hour video |

So the shell serves the bytes itself, on an ephemeral loopback port
(`src-tauri/src/media_server.rs`). Range requests are answered properly, which is
what makes seeking work at all. Files are addressed by an opaque token, not by
path, so nothing on the machine can walk the filesystem through it.

Two consequences, both easy to get wrong:

- **A URL must never be saved.** It names the port of the process that wrote it.
  `saveState` strips it and `loadState` re-registers, or the next launch restores
  a playlist that looks complete and plays nothing.
- **`WEBKIT_GST_ALLOWED_URI_PROTOCOLS` is set before the webview exists.**
  WebKitGTK keeps a hardcoded list of schemes its media stack will open — `blob`,
  `data`, `file`, `http`, `https` — and refuses everything else silently.

### Controls were drawn off screen

The player library writes `--player-width` onto the player element from its own
measurement, and measures the control bar - whose natural width is what it is
trying to fit. So the two agree on a number larger than the window and each keeps
the other there. On an 800px window the player settled at 924px, the stage
clipped the overflow, and the last four controls were not on screen at all.

Overriding the variable was not enough: the computed width stayed at 924 while
the variable read 100%, which means the rule producing the used width is not the
one consuming the variable - and `min-width` is allowed to beat `max-width`. The
width is now pinned outright.

Compounding it, the window was `resizable: false`, so anything the layout clipped
was permanently unreachable, and there was no maximize button either.

### Fullscreen did nothing

WebKitGTK has no HTML Fullscreen API. `requestFullscreen` does not exist,
`document.fullscreenElement` is always null, and `fullscreenchange` never fires.
The button was dead on Linux and the `f` shortcut reported a failure to a console
nobody was watching.

The window itself can still go fullscreen, so the page asks the shell
(`set_fullscreen` / `is_fullscreen`). `js/media.js` prefers that hook when it is
present and keeps the HTML path for the browser build, which never had a problem
— the bridge still does not know a shell exists.

## 4. The codec problem, and how to check it

On Linux the webview decodes through GStreamer. A machine without the MP4
demuxer shows an app that loads, opens, and silently refuses to play anything —
no error, no message, just a picture that never appears.

That is not hypothetical: it was true on the machine this was built on, and it
is why there is a diagnostic.

```bash
./src-tauri/target/release/custom-media-player --diagnose
```

It prints whether the shell's API is reachable and whether a real H.264 clip
loaded, and it opens a window while doing so. On a machine that cannot play
H.264 it says so.

To fix a Linux machine that cannot:

```
sudo pacman -S gst-plugins-good      # Arch / CachyOS: provides the MP4 demuxer
```

`gst-plugins-base`, `-bad` and `-ugly` are usually already installed. It is
`gst-plugins-good` that carries `isomp4`, `matroskademux` and `wavparse`, and
those three being absent is what makes MP4 silently fail.

Windows and macOS ship their own media stacks with the codecs, so this does not
apply there.

## 5. Files, and what happens when one moves

The app references files where they are. Nothing is copied, so there is no
duplicated disk usage and no library folder to manage.

The trade-off is that a playlist outlives the files in it, so a file can later
be moved, renamed or deleted. When that happens:

- the row **stays**, dimmed, struck through, and marked `gone`
- it is not playable, and selecting it says why instead of failing silently
- it is still removable
- the rest of the playlist is unaffected

A playlist that quietly loses tracks is worse than one that visibly shows a
hole, so nothing is ever removed behind the user's back.

## 6. Layout

```
src-tauri/
  Cargo.toml
  tauri.conf.json          window, security, bundle targets
  capabilities/default.json  the permissions this app needs, and no more
  src/
    main.rs                six commands, no playback logic
    tests.rs               the logic that can be tested without a screen
    diagnostic.js          what `--diagnose` injects
    diagnostic-collect.js  how the result is collected back
  icons/                   generated by `npm run icon`
js/
  mime.js                  what kind of file this is, for every source
  source-web.js            the browser adapter
  source-tauri.js          the desktop adapter
  source.js                picks one, and validates the contract
scripts/
  build-frontend.mjs       assembles dist/ from an allowlist
icon-source.png            the icon `npm run icon` generates from
```

### The security posture, stated plainly

- The app has **no network capability at all**. No HTTP client, no remote
  content, and a CSP that only permits the app's own origin.
- It has **no filesystem plugin**. The app reaches the disk only through its own
  six commands, each of which does one thing.
- The dialog permission is the only one granted beyond `core:default`.
- The asset protocol scope is `**`, which is broad on purpose: a media player
  must be able to open a file from anywhere the user points at, including a USB
  drive. It reads files the user has already chosen, and there is no code path
  that reads anything else.

The bundle identifier is `com.almenber.custommediaplayer`, which follows the
project path. It becomes the Windows executable name, so if you want something
else it is one line in `tauri.conf.json` before you build for the client.

## 7. Testing

```bash
npm test                                        # 144 unit tests, no screen needed
cargo test --manifest-path src-tauri/Cargo.toml # 6 Rust tests, no screen needed
npm run test:e2e                                # 5 browser suites, web version
```

The desktop tests deliberately do not launch a window. Everything that can be
checked against a stub or a temp directory is, so that running the app on a
screen is only ever needed for the things that genuinely require one.

## 8. Notes for the Windows build

Nothing here has been run on Windows, so this is what to check first:

1. `npm install` and `npm run desktop:build` on a machine with the MSVC build
   tools and the WebView2 runtime. The WebView2 runtime is present by default
   on Windows 11 and on current Windows 10.
2. A path with a space in it, and a path in `C:\Users\<name>\Videos` — the
   adapter splits on both separators, and it is tested with both.
3. A restart: add files, close, reopen, confirm the playlist is there.
4. Drag a file from Explorer onto the window.
5. `--diagnose` should report `active_source: desktop` and `h264_playback: WORKS`.

The `.msi` and NSIS installer are both configured. NSIS is set to per-user
install, so it does not need administrator rights.
