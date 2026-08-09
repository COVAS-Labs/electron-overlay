#!/usr/bin/env bash
set -Eeuo pipefail

if (( $# != 6 )); then
  printf '%s\n' "Usage: $0 REPOSITORY SCENARIO MODE OUTPUT CASE_DIRECTORY SHARED_TEXTURE" >&2
  exit 2
fi

readonly repository="$1"
readonly scenario="$2"
readonly mode="$3"
readonly output="$4"
readonly case_directory="$5"
readonly shared_texture="$6"
readonly electron="$repository/node_modules/.bin/electron"
readonly ready_file="$case_directory/report.json"
readonly pid_file="$case_directory/demo.pid"
readonly log_file="$case_directory/demo.log"

mkdir -p "$case_directory"
printf '%s\n' "$$" >"$pid_file"

export ELECTRON_ENABLE_LOGGING=1
export ELECTRON_DISABLE_SECURITY_WARNINGS=1

case "$mode" in
  x11)
    exec "$electron" \
      --no-sandbox \
      --disable-gpu \
      --disable-dev-shm-usage \
      --enable-logging=stderr \
      --ozone-platform=x11 \
      "$repository/packages/demo/main.mjs" \
      --demo="$scenario" \
      --backend=x11 \
      --ready-file="$ready_file" >"$log_file" 2>&1
    ;;
  wayland)
    exec "$electron" \
      --no-sandbox \
      --disable-gpu \
      --disable-dev-shm-usage \
      --enable-logging=stderr \
      --ozone-platform=wayland \
      "$repository/packages/demo/main.mjs" \
      --demo="$scenario" \
      --backend=wayland-electron \
      --ready-file="$ready_file" >"$log_file" 2>&1
    ;;
  layer-shell)
    exec "$electron" \
      --no-sandbox \
      --disable-gpu \
      --disable-dev-shm-usage \
      --enable-logging=stderr \
      --ozone-platform=wayland \
      "$repository/packages/demo/main.mjs" \
      --demo=layer-shell \
      --output="$output" \
      --shared-texture="$shared_texture" \
      --ready-file="$ready_file" >"$log_file" 2>&1
    ;;
  *)
    printf '%s\n' "Unknown visual demo mode: $mode" >&2
    exit 2
    ;;
esac
