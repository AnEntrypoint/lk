#!/usr/bin/env bash
# Starts the voice host: LiveKit (dev, only when no URL is given), Paradee TTS, Starling STT, Node host.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
PIDS=()
trap 'kill "${PIDS[@]}" 2>/dev/null || true' EXIT

if [ -z "${LIVEKIT_URL:-}" ]; then
  "$ROOT/native/livekit/livekit-server" --dev > "$ROOT/livekit.log" 2>&1 &
  PIDS+=($!)
  export LIVEKIT_URL=ws://127.0.0.1:7880 LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=secret
  sleep 2
fi

ESPEAK_NG="$ROOT/native/espeak/espeak-ng.sh" "$ROOT/native/build/paradee_server" "$ROOT/models" 8790 &
PIDS+=($!)

"$ROOT/native/bin-vulkan/starling-serve-linux-vulkan" --model parakeet \
  --gguf "$ROOT/models/underdog-bark-3.0-clean-q4pw.gguf" --port 8181 --parent-pid $$ &
PIDS+=($!)

sleep 3
cd "$ROOT/agent"
node host.mjs
