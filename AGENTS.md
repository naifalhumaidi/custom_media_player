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
    ./run-app.sh                                 # Electron, on a person's real desktop

Both runners isolate the saved state, so a run starts from an empty playlist and
is reproducible. Both are reasonably expensive — several seconds of real video
playback each — so run one, read it, and decide. Do not loop.

## Never open a window on the user's screen

This has happened twice, and both times it landed in the middle of work the user
was doing. Any window this agent starts must be on a throwaway framebuffer:

    tests/e2e/electron-desktop.sh   # Xvfb :98, --ozone-platform=x11
    tests/e2e/desktop.sh

`./run-app.sh` is the one exception and it is not for the agent. It is the
launcher the user runs themselves, and it must never be used to verify anything.

Two things make this fail while looking fine:

- Chromium prefers Wayland whenever WAYLAND_DISPLAY is set, and does not care
  that DISPLAY points at a framebuffer. Unset it outright - not only when it is
  empty - and pass --ozone-platform=x11 as well, so the claim is a switch and
  not a promise.
- A stale `shells/electron/dist/` is found by the shell before the repo `dist/`
  and silently serves old code. It must not exist.

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