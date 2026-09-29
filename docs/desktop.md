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

| Target | Platform |
|---|---|
| `.deb` | Linux |
| `.appimage` | Linux |
| `.msi` | Windows |
| `setup.exe` (NSIS) | Windows |

All four are in `tauri.conf.json` under `bundle.targets`.

## 3. What is verified, and what is not

Being precise about this, because "it builds" is not "it works" and the
difference matters when you hand it to someone.

**Verified by running the built binary here**

- the shell builds and launches
- the window opens and the page mounts
- `window.__TAURI__` is reachable, with `invoke`, `convertFileSrc` and
  `event.listen`
- `convertFileSrc` produces `asset://localhost/<encoded path>` on Linux
- `js/source-tauri.js` registers and `js/source.js` selects it — the diagnostic
  reports `active_source: desktop`
- `MediaBridge` mounts, so the playback side is intact

**Verified without a screen**

- `cargo test` — 6 tests over the state file, the staged write, the folder
  listing order and the existence check
- `npm test` — 20 tests over the desktop adapter against a stubbed shell: path
  to item mapping, Windows paths, asset-URL caching, `release`, a moved file, a
  folder, the persisted keys, a failed write, and drop coalescing

**Not verified, and it needs a human with a display**

- the native file and folder dialogs opening and returning
- a video actually playing
- a dropped file arriving
- the playlist surviving a restart

This machine has no virtual display and no permission to install one, so those
remain. `cargo test` and the stubbed-shell tests cover the logic either side of
each of them; what they cannot cover is the two lines of glue in the middle.

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
