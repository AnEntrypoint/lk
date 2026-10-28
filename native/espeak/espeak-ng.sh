#!/usr/bin/env bash
# Runs the locally unpacked espeak-ng (no root install). Used by paradee_server for OOV words.
HERE="$(cd "$(dirname "$0")" && pwd)/root"
LIB="$HERE/usr/lib/x86_64-linux-gnu"
LD_LIBRARY_PATH="$LIB${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" exec "$HERE/usr/bin/espeak-ng" --path="$LIB/espeak-ng-data" "$@"
