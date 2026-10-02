#!/usr/bin/env bash
# Runs the Electron build using the Electron already installed on this machine.
#
# Provided because a packaged Electron application is ~250 MB - it carries its
# own copy of Chromium - and that is a poor trade for testing a change. The
# packaged builds are what goes to the client; this is what you use.
#
# If you have no Electron installed:
#   pacman -S electron
# or run `npm run package:electron -- linux` for a self-contained directory.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

ELECTRON="${MT_ELECTRON:-}"
if [ -z "$ELECTRON" ]; then
  # The newest one installed. Version matters here: `webUtils.getPathForFile`,
  # which is the only way to recover a path from a dropped file, arrived in
  # Electron 32. An older one loads the app and then cannot read a drop.
  ELECTRON=$(ls -d /usr/lib/electron*/electron /usr/bin/electron 2>/dev/null \
    | sed 's|.*/electron\([0-9]*\)/electron|\1 &|; s|^/usr/bin/electron$|999999 &|' \
    | sort -rn | head -1 | cut -d' ' -f2-)
fi

if [ -z "$ELECTRON" ] || [ ! -x "$ELECTRON" ]; then
  echo "No Electron found. Install one with:  sudo pacman -S electron" >&2
  echo "or produce a self-contained build:  npm run package:electron -- linux" >&2
  exit 127
fi

if [ ! -f "$ROOT/dist/index.html" ]; then
  echo "dist/ is missing - building it." >&2
  (cd "$ROOT" && npm run build:web) || exit 1
fi

# Chromium prefers Wayland whenever WAYLAND_DISPLAY is set, and it does not care
# that DISPLAY points at a framebuffer. This script used to unset WAYLAND_DISPLAY
# only when it was *empty* - which is backwards. The variable is either absent or
# it names a real compositor, and on this machine it names the user's own Plasma
# session, so every run that went through here opened its window on their desktop
# rather than on the Xvfb display the run had been given. Unset it outright, and
# say so to Chromium as well, because unsetting alone is a promise and the switch
# is the fact.
unset WAYLAND_DISPLAY
unset QT_QAYLAND_DISPLAY 2>/dev/null || true
unset GDK_BACKEND 2>/dev/null || true

# A walkthrough must start from an empty playlist. Without this the saved state
# from the previous run is restored before the first journey looks, and every row
# count in the report is off by however many tracks the last run left behind.
if [ -n "${MT_WALKTHROUGH:-}" ] || [ -n "${MT_STATE_DIR:-}" ]; then
  if [ -n "${MT_STATE_DIR:-}" ]; then
    # A directory the caller named is theirs: created if absent, never deleted.
    mkdir -p "$MT_STATE_DIR"
  else
    MT_STATE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mt-walkthrough.XXXXXX")"
    # Only the one this script made. Someone who set MT_KEEP_STATE wants to read
    # the state afterwards.
    [ -z "${MT_KEEP_STATE:-}" ] && trap 'rm -rf "$MT_STATE_DIR"' EXIT
  fi
  export MT_STATE_DIR
fi

exec "$ELECTRON" --ozone-platform=x11 --disable-features=WaylandWindowDecorations "$ROOT/shells/electron" "$@"