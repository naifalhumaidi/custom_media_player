#!/usr/bin/env bash
# Runs the desktop app headlessly, on a virtual display, with no sound.
#
# Two independent layers keep the test from reaching the user:
#   - Xvfb : a virtual framebuffer. GTK3 has no headless backend, so a real X
#     server is the only way to run a Tauri window without a display.
#   - a null sink: Chromium's --mute-audio alone still opens a live stream, so
#     the process is also pointed at a sink with no output.
#
# Nothing is drawn and nothing is heard. The point is that a GUI app can be
# driven and inspected at all.
#
# Usage: tests/e2e/desktop.sh [--diagnose] [args...]
#        prints DISPLAY=:99 on success so a caller can reuse it

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DISPLAY_NUM="${MT_DISPLAY:-99}"


if ! command -v Xvfb >/dev/null 2>&1; then
  echo "desktop: Xvfb is not installed (Arch: sudo pacman -S xorg-server-xvfb)" >&2
  exit 127
fi

APP="${MT_APP:-$ROOT/artifacts/custom-media-player-linux}"
if [ ! -x "$APP" ]; then
  APP="$ROOT/src-tauri/target/release/custom-media-player"
fi
if [ ! -x "$APP" ]; then
  echo "desktop: no binary found; run: npm run build:web && npx tauri build --no-bundle" >&2
  exit 1
fi

# ---- the virtual display ---------------------------------------------------
if [ -e "/tmp/.X11-unix/X$DISPLAY_NUM" ] && command -v xdpyinfo >/dev/null 2>&1; then
  echo "desktop: reusing the display already on :$DISPLAY_NUM"
else
  pkill -f "Xvfb :$DISPLAY_NUM" 2>/dev/null
  rm -f "/tmp/.X${DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM}" 2>/dev/null
  Xvfb ":$DISPLAY_NUM" -screen 0 1920x1080x24 -nolisten tcp >/tmp/mt-xvfb.log 2>&1 &
  XVFB_PID=$!
  for _ in $(seq 1 40); do
    [ -e "/tmp/.X11-unix/X$DISPLAY_NUM" ] && break
    sleep 0.25
  done
  if [ ! -e "/tmp/.X11-unix/X$DISPLAY_NUM" ]; then
    echo "desktop: the virtual display did not come up (see /tmp/mt-xvfb.log)" >&2
    cat /tmp/mt-xvfb.log >&2
    exit 1
  fi
  echo "desktop: virtual display :$DISPLAY_NUM ready"
  trap 'kill $XVFB_PID 2>/dev/null' EXIT
fi

# ---- a sink with no output -------------------------------------------------
# Shared with the Electron runner. One mechanism, so there is one place where
# silence is decided and one place to audit.
# shellcheck source=tests/e2e/quiet.sh
. "$ROOT/tests/e2e/quiet.sh"

export DISPLAY=":$DISPLAY_NUM"
export GDK_BACKEND=x11
# WebKitGTK is far happier without compositing in a framebuffer
export WEBKIT_DISABLE_COMPOSITING_MODE=1
export LIBGL_ALWAYS_SOFTWARE=1
# no crash dialog popping up on a virtual screen nobody is watching
export GTK_DEBUG=no-interactive

exec "$APP" "$@"
