#!/usr/bin/env bash
# Runs the Electron shell headlessly, on a virtual display, with no sound.
#
# The same arrangement as tests/e2e/desktop.sh, which runs the Tauri one:
#
#   - Xvfb : a virtual framebuffer, so no window appears on the real screen
#   - a null sink : test media must never reach a speaker
#
# Electron is Chromium with a Node process attached, and both need the display.
# Nothing is drawn and nothing is heard.
#
# Usage: tests/e2e/electron-desktop.sh [--walkthrough] [args...]

set -uo pipefail

EXTRA_ARGS=()

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DISPLAY_NUM="${MT_DISPLAY:-98}"

if ! command -v Xvfb >/dev/null 2>&1; then
  echo "electron-desktop: Xvfb is not installed (Arch: sudo pacman -S xorg-server-xvfb)" >&2
  exit 127
fi

# One mechanism for silence, shared with the other runners.
# shellcheck source=tests/e2e/quiet.sh
. "$ROOT/tests/e2e/quiet.sh"

# An Electron of a known version, rather than whatever is on PATH.
#
# The newest one installed, which matters: the glob alone picked electron12 on
# this machine, whose Node cannot even `require('node:path')`. A shell that
# fails to load because of which Electron was found first is not a test result,
# it is a coin toss.
ELECTRON="${MT_ELECTRON:-}"
if [ -z "$ELECTRON" ]; then
  ELECTRON=$(ls -d /usr/lib/electron*/electron /usr/bin/electron 2>/dev/null \
    | sed 's|.*/electron\([0-9]*\)/electron|\1 &|; s|^/usr/bin/electron$|999999 &|' \
    | sort -rn \
    | head -1 \
    | cut -d' ' -f2-)
fi
if [ -z "$ELECTRON" ] || [ ! -x "$ELECTRON" ]; then
  echo "electron-desktop: no Electron found (Arch: sudo pacman -S electron)" >&2
  exit 127
fi

# ---- the virtual display ---------------------------------------------------
if [ -e "/tmp/.X11-unix/X$DISPLAY_NUM" ]; then
  echo "electron-desktop: reusing the display already on :$DISPLAY_NUM"
else
  rm -f "/tmp/.X${DISPLAY_NUM}-lock" 2>/dev/null
  Xvfb ":$DISPLAY_NUM" -screen 0 1920x1080x24 -nolisten tcp >/tmp/mt-xvfb-electron.log 2>&1 &
  XVFB_PID=$!
  trap 'kill $XVFB_PID 2>/dev/null' EXIT
  for _ in $(seq 1 40); do
    [ -e "/tmp/.X11-unix/X$DISPLAY_NUM" ] && break
    sleep 0.25
  done
  if [ ! -e "/tmp/.X11-unix/X$DISPLAY_NUM" ]; then
    echo "electron-desktop: the virtual display did not come up" >&2
    cat /tmp/mt-xvfb-electron.log >&2
    exit 1
  fi
  echo "electron-desktop: virtual display :$DISPLAY_NUM ready"
fi

# See tests/e2e/desktop.sh: an empty, isolated configuration directory, so a run
# does not inherit the last one's playlist.
export XDG_CONFIG_HOME="${MT_CONFIG_HOME:-/tmp/mt-walkthrough-config-electron}"
rm -rf "$XDG_CONFIG_HOME"
mkdir -p "$XDG_CONFIG_HOME"

export DISPLAY=":$DISPLAY_NUM"

# Chromium prefers Wayland whenever WAYLAND_DISPLAY is set, and it does not care
# that DISPLAY points at a framebuffer. Leaving it set meant a run of this script
# opened a real window on the user's compositor - on their desktop, following
# them across workspaces, while the script reported it was testing headlessly.
# Nothing here needs that, so it is removed rather than trusted.
unset WAYLAND_DISPLAY
unset XDG_SESSION_TYPE

# Electron is a Chromium: it mutes itself, opens no audio device on its own, and
# the null sink from quiet.sh catches anything that does.
export ELECTRON_DISABLE_SECURITY_WARNINGS=1
# Chromium refuses to run as root, and a sandbox needs privileges this does not
# have. Isolated on a virtual display with no network use, which is the whole
# point of the runner.
export ELECTRON_DISABLE_SANDBOX=1

exec "$ELECTRON" --ozone-platform=x11 "$ROOT/shells/electron" "$@"