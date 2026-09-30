#!/usr/bin/env bash
# Sourced by anything that can make a sound. Test media must never reach a
# speaker.
#
# Pointing the process at a null sink is enough for GStreamer, WebKitGTK,
# Chromium and FFmpeg alike: they all honour PULSE_SINK. This exists because
# one diagnostic run used gst-play-1.0 directly, which opened the real hardware
# sink and played a clip out loud. A sink with no output is not a politeness
# measure, it is the only thing standing between a test and someone's ears.
#
# Usage:  source tests/e2e/quiet.sh

MT_SINK="${MT_SINK:-mt_quiet_sink}"

if ! command -v pactl >/dev/null 2>&1; then
  export MT_MUTE=1
  return 0 2>/dev/null || exit 0
fi

# Remove sinks left behind by earlier runs first, then create exactly one.
# Doing it in that order is what keeps the count from growing: an earlier
# version created a sink before sweeping, so every run left one behind, and the
# machine ended up with thirty of them.
#
# `pactl unload-module` takes a *module* id, not the sink index that
# `pactl list short sinks` reports in its first column. Getting that backwards
# makes the sweep a no-op that looks like it worked, which is exactly what an
# earlier version of this file did.
#
# Only names this repository uses are touched, so a real device or a sink the
# user made is never unloaded.
while read -r module _ arguments _; do
  case "$arguments" in
    sink_name=mt_e2e_sink|sink_name=mt_test_sink|sink_name=mt_headless_sink|sink_name=mt_quiet_sink)
      pactl unload-module "$module" >/dev/null 2>&1
      ;;
  esac
done < <(pactl list short modules 2>/dev/null)

pactl load-module module-null-sink "sink_name=${MT_SINK}" >/dev/null 2>&1
export PULSE_SINK="$MT_SINK"
export MT_MUTE=1