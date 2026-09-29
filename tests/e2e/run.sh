#!/usr/bin/env bash
# Headless end-to-end test runner.
#
# Two independent layers keep test audio away from the speaker:
#
#   1. --mute-audio tells Chromium to mute at the audio-service level.
#   2. The process is pointed at a null sink, so even a stream that ignores
#      the flag is consumed by a device with no output. This is the layer that
#      actually matters: --mute-audio alone still opens a live stream.
#
# The sink is created on demand and torn down on exit, and the machine's
# default output is never changed.
#
# Usage:  tests/e2e/run.sh [suite.cjs ...]     (defaults to every suite)

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ELECTRON="${ELECTRON_BIN:-/usr/lib/electron41/electron}"
PORT="${PORT:-8000}"
NULL_SINK="mt_e2e_sink"

cd "$ROOT"

if [ ! -x "$ELECTRON" ]; then
  echo "e2e: no Electron at $ELECTRON (set ELECTRON_BIN)" >&2
  exit 127
fi

# ---- the app under test must be serving -------------------------------------
if ! curl -fsS -o /dev/null "http://127.0.0.1:$PORT/"; then
  echo "e2e: starting the app server on :$PORT"
  node serve.js >/tmp/mt-serve.log 2>&1 &
  SERVER_PID=$!
  trap 'kill $SERVER_PID 2>/dev/null' EXIT
  for _ in $(seq 1 40); do
    curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" && break
    sleep 0.25
  done
  if ! curl -fsS -o /dev/null "http://127.0.0.1:$PORT/"; then
    echo "e2e: the app server did not come up (see /tmp/mt-serve.log)" >&2
    exit 1
  fi
fi

# ---- a sink with no output ---------------------------------------------------
SINK_LOADED=""
if command -v pactl >/dev/null 2>&1; then
  if pactl list short sinks 2>/dev/null | grep -q ":$NULL_SINK$"; then
    SINK_LOADED="existing"
  elif pactl load-module module-null-sink "sink_name=$NULL_SINK" >/dev/null 2>&1; then
    SINK_LOADED="loaded"
  fi
  if [ -n "$SINK_LOADED" ]; then
    echo "e2e: audio routed to the null sink '$NULL_SINK' ($SINK_LOADED)"
  else
    echo "e2e: WARNING no null sink available; relying on --mute-audio alone" >&2
  fi
else
  echo "e2e: WARNING pactl not found; relying on --mute-audio alone" >&2
fi

cleanup() {
  [ "$SINK_LOADED" = "loaded" ] && pactl unload-module "$(pactl list short modules | grep ":$NULL_SINK" | cut -d: -f1 | head -1)" 2>/dev/null
  return 0
}
trap 'cleanup' EXIT

# ---- suites ------------------------------------------------------------------
if [ $# -gt 0 ]; then
  SUITES=("$@")
else
  SUITES=()
  for f in "$ROOT"/tests/e2e/*.cjs; do
    [ -e "$f" ] && SUITES+=("$f")
  done
fi

# Electron's own noise on a headless box; the suites report their own results.
NOISE='SharedImageManager|shared_memory|/dev/shm|ERROR:ui/ozone|console-message|libva|Fontconfig'

failed=0
for suite in "${SUITES[@]}"; do
  name="$(basename "$suite")"
  raw="$(mktemp)"
  # Electron's own flags: the suites need autoplay to be allowed, and audio
  # off. The harness sets these too, so a hand-run suite is quiet as well.
  PULSE_SINK="$NULL_SINK" timeout 400 "$ELECTRON" \
    --mute-audio \
    --autoplay-policy=no-user-gesture-required \
    "$suite" >"$raw" 2>&1
  status=$?
  out="$(grep -vE "$NOISE" "$raw")"
  summary="$(printf '%s\n' "$out" | grep -E 'PASSED|FAILED|passed [0-9]+/' | tail -1)"
  if [ $status -ne 0 ] || printf '%s' "$out" | grep -qE 'FAIL|Error:|PAGE ERR'; then
    failed=$((failed + 1))
    echo "FAIL $name ${summary:+- $summary}"
    printf '%s\n' "$out" | grep -E 'FAIL|Error|error' | head -8 | sed 's/^/    /'
  else
    echo "ok   $name ${summary:+- $summary}"
  fi
  rm -f "$raw"
done

if [ $failed -gt 0 ]; then
  echo ""
  echo "e2e: $failed suite(s) failed"
  exit 1
fi
echo ""
echo "e2e: all ${#SUITES[@]} suite(s) passed"
