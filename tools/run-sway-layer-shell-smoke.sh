#!/usr/bin/env bash
set -Eeuo pipefail

readonly readiness_timeout="${SWAY_READY_TIMEOUT_SECONDS:-20}"
readonly smoke_timeout="${LAYER_SHELL_SMOKE_TIMEOUT_SECONDS:-60}"
readonly log_dir="${SWAY_LOG_DIR:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/electron-overlay-layer-shell-logs}"

mkdir -p "$log_dir"
runtime_dir="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/electron-overlay-sway.XXXXXX")"
chmod 700 "$runtime_dir"
config="$runtime_dir/config"
printf '%s\n' 'xwayland disable' 'output * background #000000 solid_color' >"$config"

export XDG_RUNTIME_DIR="$runtime_dir"
export XDG_SESSION_TYPE=wayland
export WLR_BACKENDS=headless
export WLR_RENDERER=pixman
export WLR_LIBINPUT_NO_DEVICES=1
unset DISPLAY WAYLAND_DISPLAY SWAYSOCK

sway_log="$log_dir/sway.log"
client_log="$log_dir/client.log"
native_client_log="$log_dir/native-client.log"
wayland_info_log="$log_dir/wayland-info.log"
sway_pid=""

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ -n "$sway_pid" ]] && kill -0 "$sway_pid" 2>/dev/null; then
    kill "$sway_pid" 2>/dev/null || true
    wait "$sway_pid" 2>/dev/null || true
  fi
  rm -rf "$runtime_dir"
  if (( status != 0 )); then
    for log in "$sway_log" "$wayland_info_log" "$native_client_log" "$client_log"; do
      if [[ -f "$log" ]]; then
        printf '\n===== %s =====\n' "$log" >&2
        cat "$log" >&2
      fi
    done
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

sway --debug --config "$config" >"$sway_log" 2>&1 &
sway_pid=$!

deadline=$((SECONDS + readiness_timeout))
while (( SECONDS < deadline )); do
  kill -0 "$sway_pid" 2>/dev/null || { wait "$sway_pid" || true; exit 1; }
  for socket in "$runtime_dir"/sway-ipc.*.sock; do
    if [[ -S "$socket" ]]; then export SWAYSOCK="$socket"; break 2; fi
  done
  sleep 0.1
done
[[ -n "${SWAYSOCK:-}" ]] || { printf '%s\n' "Sway IPC did not become ready." >&2; exit 1; }

swaymsg create_output >/dev/null
export LAYER_SHELL_OUTPUT=HEADLESS-2
swaymsg output "$LAYER_SHELL_OUTPUT" mode 1920x1080 >/dev/null
for socket in "$runtime_dir"/wayland-*; do
  if [[ -S "$socket" ]]; then export WAYLAND_DISPLAY="${socket##*/}"; break; fi
done
[[ -n "${WAYLAND_DISPLAY:-}" ]] || { printf '%s\n' "Sway Wayland socket was not found." >&2; exit 1; }

timeout 5s wayland-info >"$wayland_info_log" 2>&1
if ! rg -q 'zwlr_layer_shell_v1' "$wayland_info_log"; then
  printf '%s\n' "Sway did not advertise zwlr_layer_shell_v1." >&2
  exit 1
fi

set +e
ELECTRON_RUN_AS_NODE=1 timeout --signal=TERM --kill-after=10s "${smoke_timeout}s" \
  npm run test:electron:layer-shell:native 2>&1 | tee "$native_client_log"
native_status=${PIPESTATUS[0]}
if (( native_status != 0 )); then
  set -e
  exit "$native_status"
fi
timeout --signal=TERM --kill-after=10s "${smoke_timeout}s" \
  npm run test:electron:layer-shell 2>&1 | tee "$client_log"
smoke_status=${PIPESTATUS[0]}
set -e
exit "$smoke_status"
