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

# An *empty* WAYLAND_DISPLAY still counts as set, and Chromium then tries it,
# fails, and exits rather than falling back to X11. Unset rather than blanked.
if [ -z "${WAYLAND_DISPLAY:-}" ]; then
  unset WAYLAND_DISPLAY
fi

exec "$ELECTRON" "$ROOT/shells/electron" "$@"