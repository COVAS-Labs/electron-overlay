#!/usr/bin/env bash
set -Eeuo pipefail

readonly readiness_timeout="${WESTON_READY_TIMEOUT_SECONDS:-20}"
readonly smoke_timeout="${WAYLAND_SMOKE_TIMEOUT_SECONDS:-60}"
readonly log_dir="${WESTON_LOG_DIR:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/electron-overlay-wayland-logs}"

mkdir -p "$log_dir"
runtime_dir="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/electron-overlay-weston.XXXXXX")"
chmod 700 "$runtime_dir"

export XDG_RUNTIME_DIR="$runtime_dir"
export XDG_SESSION_TYPE=wayland
export WAYLAND_DISPLAY=electron-overlay-wayland
unset DISPLAY

weston_log="$log_dir/weston.log"
electron_log="$log_dir/electron.log"
wayland_info_log="$log_dir/wayland-info.log"
weston_pid=""

print_logs() {
  for log in "$weston_log" "$wayland_info_log" "$electron_log"; do
    if [[ -f "$log" ]]; then
      printf '\n===== %s =====\n' "$log" >&2
      cat "$log" >&2
    fi
  done
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM

  if [[ -n "$weston_pid" ]] && kill -0 "$weston_pid" 2>/dev/null; then
    kill "$weston_pid" 2>/dev/null || true
    for _ in {1..50}; do
      kill -0 "$weston_pid" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$weston_pid" 2>/dev/null; then
      kill -KILL "$weston_pid" 2>/dev/null || true
    fi
    wait "$weston_pid" 2>/dev/null || true
  fi

  rm -rf "$runtime_dir"
  if (( status != 0 )); then
    print_logs
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

weston \
  --backend=headless-backend.so \
  --socket="$WAYLAND_DISPLAY" \
  --width=1024 \
  --height=768 \
  --idle-time=0 \
  --log="$weston_log" &
weston_pid=$!

deadline=$((SECONDS + readiness_timeout))
while true; do
  if ! kill -0 "$weston_pid" 2>/dev/null; then
    wait "$weston_pid" || true
    printf '%s\n' "Weston exited before its Wayland socket became ready." >&2
    exit 1
  fi
  if (( SECONDS >= deadline )); then
    printf 'Timed out after %ss waiting for Weston readiness.\n' "$readiness_timeout" >&2
    exit 1
  fi
  if [[ -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ]] \
    && timeout 2s wayland-info >"$wayland_info_log" 2>&1; then
    break
  fi
  sleep 0.1
done

set +e
timeout --signal=TERM --kill-after=10s "${smoke_timeout}s" \
  npm run test:electron:wayland 2>&1 | tee "$electron_log"
smoke_status=${PIPESTATUS[0]}
set -e

if (( smoke_status != 0 )); then
  if (( smoke_status == 124 )); then
    printf 'Electron Wayland smoke test timed out after %ss.\n' "$smoke_timeout" >&2
  fi
  exit "$smoke_status"
fi

if ! kill -0 "$weston_pid" 2>/dev/null; then
  wait "$weston_pid" || true
  printf '%s\n' "Weston exited before the Electron Wayland smoke test completed." >&2
  exit 1
fi
