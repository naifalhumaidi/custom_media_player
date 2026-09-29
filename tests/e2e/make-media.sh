#!/usr/bin/env bash
# Builds the media fixtures the end-to-end suites drop into the player.
#
# They are generated rather than committed: a few seconds of ffmpeg is cheaper
# than several megabytes of binary in version control, and it keeps the repo
# free of files nobody can review in a diff. The clips are deliberately tiny
# and short - the suites assert on layout, timing and state, never on picture.
#
# Usage: tests/e2e/make-media.sh

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/media"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "make-media: ffmpeg is required to build the fixtures" >&2
  exit 127
fi

mkdir -p "$OUT"

need() { [ -f "$OUT/$1" ] || return 0; }

if need clip.mp4 || need still.png || need tone.mp3 || need long.mp4; then :; fi

if need clip.mp4; then
  echo "make-media: clip.mp4"
  ffmpeg -loglevel error -y \
    -f lavfi -i "testsrc2=size=320x180:rate=15:duration=8" \
    -f lavfi -i "sine=frequency=440:duration=8" \
    -c:v libx264 -preset veryfast -crf 34 -pix_fmt yuv420p -c:a aac -b:a 32k -shortest \
    "$OUT/clip.mp4"
fi

if need long.mp4; then
  echo "make-media: long.mp4"
  ffmpeg -loglevel error -y \
    -f lavfi -i "testsrc2=size=320x180:rate=15:duration=60" \
    -f lavfi -i "sine=frequency=330:duration=60" \
    -c:v libx264 -preset veryfast -crf 36 -pix_fmt yuv420p -c:a aac -b:a 24k -shortest \
    "$OUT/long.mp4"
fi

if need still.png; then
  echo "make-media: still.png"
  ffmpeg -loglevel error -y -f lavfi -i "testsrc2=size=640x360" -frames:v 1 "$OUT/still.png"
fi

if need tone.mp3; then
  echo "make-media: tone.mp3"
  ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=440:duration=5" -c:a libmp3lame -b:a 32k "$OUT/tone.mp3"
fi

echo "make-media: ready in $OUT"
ls -la "$OUT"
