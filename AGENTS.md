# This project

Read `~/.config/opencode/AGENTS.md` first. The rules there are not
project-specific: they exist because a metered connection and a nearly full disk
are not mine to spend.

## What this project costs to build

Worth stating once, because it is not obvious and it bit hard:

- A native Tauri build compiles Rust from scratch and leaves **multi-gigabyte**
  output in `src-tauri/target/`.
- The debug, release and Windows cross-compile targets are separate directories
  and each is larger than the binary they produce.
- Nothing in `target/` is needed to *use* a build. Copy the binary out, then
  delete `target/`.

So: build, copy the artefact to `artifacts/`, verify, then delete `target/`.

## Building and verifying

    npm run build:web                  # compile TypeScript, assemble dist/
    npm test                           # type-check, build, unit tests
    npm run test:e2e                   # the browser suites (Chromium)

Desktop shells, headless only:

    ./tests/e2e/desktop.sh --walkthrough          # Tauri
    ./tests/e2e/electron-desktop.sh --walkthrough # Electron
    tests/e2e/electron-run.sh                     # Electron, for a person

Both runners isolate the saved state, so a run starts from an empty playlist and
is reproducible. Both are reasonably expensive — several seconds of real video
playback each — so run one, read it, and decide. Do not loop.

## The artefacts

    artifacts/tauri-linux/       binary and .deb
    artifacts/tauri-windows/     .exe, cross-compiled, never run
    artifacts/cachyos/          native Arch package (makepkg)
    artifacts/electron-windows/  self-contained Windows build

All of it is gitignored. `artifacts/README.txt` says what is verified and what is
not — keep it honest.

## Two platform facts that look like app bugs

Both have cost real time here and both will look like application errors to
anyone who meets them cold:

1. **WebKitGTK has no URI handler for the `asset://` scheme**, so a Tauri build
   on Linux cannot play a local file until the shell serves it over loopback. The
   player library also sets `crossorigin`, which makes that a CORS request — the
   server must send CORS headers or the media silently fails at `readyState 0`.
2. **WebKitGTK has no HTML Fullscreen API.** Fullscreen has to go through the
   window.

Both are documented in `docs/desktop.md`.

## Testing philosophy

`tests/e2e/walkthrough.js` drives real journeys in a real window at real sizes,
because a layout that clips its own controls is invisible to jsdom. It is the
only check that can see a class of bug the Chromium suites cannot reproduce at
all. Keep it, and keep it affordable.