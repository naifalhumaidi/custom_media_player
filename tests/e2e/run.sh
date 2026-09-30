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
# Shared with the desktop runner, and the single place that decides silence.
#
# This used to create and tear down its own sink, and the teardown never
# worked: it read `pactl list short modules` and split on ":", while pactl
# separates those columns with tabs. The failure was silent, and twenty
# `mt_e2e_sink` sinks accumulated on the machine before it was noticed.
# shellcheck source=tests/e2e/quiet.sh
. "$ROOT/tests/e2e/quiet.sh"

if [ -n "${PULSE_SINK:-}" ]; then
  echo "e2e: audio routed to the null sink '$PULSE_SINK'"
else
  echo "e2e: WARNING no null sink available; relying on --mute-audio alone" >&2
fi

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
  timeout 400 "$ELECTRON" \
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
