#!/usr/bin/env bash
# Runs the app in a real window on your desktop.
#
# This is for YOU to click on. tests/e2e/electron-desktop.sh is the opposite: it
# opens the window on a throwaway framebuffer so an automated run cannot land in
# the middle of your work, which also means you cannot see it.
#
# Nothing is downloaded. Electron is the one already installed by pacman, and the
# page is the dist/ folder in this repository - so this costs zero bytes of data.

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ELECTRON="${MT_ELECTRON:-}"
if [ -z "$ELECTRON" ]; then
  # webUtils.getPathForFile - the only way to recover a path from a dropped file
  # on current Electron - arrived in 32. Newest installed wins.
  ELECTRON=$(ls -d /usr/lib/electron*/electron /usr/bin/electron 2>/dev/null \
    | sed 's|.*/electron\([0-9]*\)/electron|\1 &|; s|^/usr/bin/electron$|999999 &|' \
    | sort -rn | head -1 | cut -d' ' -f2-)
fi
if [ -z "$ELECTRON" ] || [ ! -x "$ELECTRON" ]; then
  echo "No Electron found. Install it with:  sudo pacman -S electron" >&2
  exit 127
fi

# The page has to exist before there is anything to show.
if [ ! -f "$ROOT/dist/index.html" ]; then
  echo "dist/ is missing - building it (this compiles TypeScript, no download)." >&2
  (cd "$ROOT" && npm run build:web) || exit 1
fi

# Chromium refuses to run as root, and a sandbox needs privileges this lacks.
export ELECTRON_DISABLE_SANDBOX=1

exec "$ELECTRON" "$ROOT/shells/electron" "$@"
