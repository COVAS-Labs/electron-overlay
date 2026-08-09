#!/usr/bin/env bash
set -Eeuo pipefail

readonly repository="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly artifact_directory="${VISUAL_DEMO_ARTIFACT_DIR:-$repository/artifacts/orbstack-visual}"
readonly readiness_timeout="${VISUAL_DEMO_READY_TIMEOUT_SECONDS:-30}"
readonly stability_attempts="${VISUAL_DEMO_STABILITY_ATTEMPTS:-20}"
readonly shared_texture="${VISUAL_DEMO_SHARED_TEXTURE:-false}"
readonly width=1280
readonly height=800

runtime_directory="$(mktemp -d "${TMPDIR:-/tmp}/electron-overlay-visual.XXXXXX")"
chmod 700 "$runtime_directory"
config_file="$runtime_directory/sway.conf"
sway_log="$artifact_directory/sway.log"
sway_pid=""
active_demo_pid=""

mkdir -p "$artifact_directory"
rm -rf "$artifact_directory"/*
printf '%s\n' \
  'xwayland force' \
  'default_border none' \
  'default_floating_border none' \
  'focus_follows_mouse no' \
  'mouse_warping none' \
  'seat seat0 fallback true' \
  'output * mode 1280x800' \
  'output * background #182333 solid_color' \
  'for_window [shell="xwayland"] floating enable, border none' >"$config_file"
printf 'exec env > "%s"\n' "$runtime_directory/sway-environment" >>"$config_file"

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ -n "$active_demo_pid" ]]; then
    kill -TERM -- "-$active_demo_pid" 2>/dev/null || true
    sleep 0.2
    kill -KILL -- "-$active_demo_pid" 2>/dev/null || true
  fi
  if [[ -n "$sway_pid" ]] && kill -0 "$sway_pid" 2>/dev/null; then
    kill "$sway_pid" 2>/dev/null || true
    wait "$sway_pid" 2>/dev/null || true
  fi
  rm -rf "$runtime_directory"
  if (( status != 0 )); then
    printf '%s\n' "Visual demo suite failed. Artifacts: $artifact_directory" >&2
    for log in "$artifact_directory"/*/*.log "$sway_log"; do
      if [[ -f "$log" ]]; then
        printf '\n===== %s =====\n' "$log" >&2
        tail -n 100 "$log" >&2
      fi
    done
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

export XDG_RUNTIME_DIR="$runtime_directory"
export XDG_SESSION_TYPE=wayland
export WLR_BACKENDS=headless
export WLR_RENDERER=pixman
export WLR_LIBINPUT_NO_DEVICES=1
unset DISPLAY WAYLAND_DISPLAY SWAYSOCK

sway --debug --config "$config_file" >"$sway_log" 2>&1 &
sway_pid=$!

deadline=$((SECONDS + readiness_timeout))
while (( SECONDS < deadline )); do
  kill -0 "$sway_pid" 2>/dev/null || { wait "$sway_pid" || true; exit 1; }
  for socket in "$runtime_directory"/sway-ipc.*.sock; do
    if [[ -S "$socket" ]]; then
      export SWAYSOCK="$socket"
      break 2
    fi
  done
  sleep 0.1
done
[[ -n "${SWAYSOCK:-}" ]] || { printf '%s\n' "Sway IPC did not become ready." >&2; exit 1; }

wait_end=$((SECONDS + readiness_timeout))
while (( SECONDS < wait_end )) && [[ ! -s "$runtime_directory/sway-environment" ]]; do sleep 0.1; done
[[ -s "$runtime_directory/sway-environment" ]] || {
  printf '%s\n' "Sway did not export its XWayland environment." >&2
  exit 1
}
export DISPLAY="$(rg '^DISPLAY=' "$runtime_directory/sway-environment" | cut -d= -f2-)"
if rg -q '^XAUTHORITY=' "$runtime_directory/sway-environment"; then
  export XAUTHORITY="$(rg '^XAUTHORITY=' "$runtime_directory/sway-environment" | cut -d= -f2-)"
fi
[[ -n "$DISPLAY" ]] || { printf '%s\n' "Sway did not export DISPLAY for XWayland." >&2; exit 1; }

for socket in "$runtime_directory"/wayland-*; do
  if [[ -S "$socket" ]]; then
    export WAYLAND_DISPLAY="${socket##*/}"
    break
  fi
done
[[ -n "${WAYLAND_DISPLAY:-}" ]] || { printf '%s\n' "Sway Wayland socket was not found." >&2; exit 1; }

output="$(swaymsg -t get_outputs -r | jq -r 'map(select(.active))[0].name // empty')"
[[ -n "$output" ]] || { printf '%s\n' "Sway did not expose an active headless output." >&2; exit 1; }
swaymsg output "$output" mode "${width}x${height}" >/dev/null
timeout 5s wayland-info >"$artifact_directory/wayland-info.log" 2>&1
rg -q 'zwlr_layer_shell_v1' "$artifact_directory/wayland-info.log" || {
  printf '%s\n' "Sway did not advertise zwlr_layer_shell_v1." >&2
  exit 1
}

wait_for_file() {
  local file="$1"
  local description="$2"
  local end=$((SECONDS + readiness_timeout))
  while (( SECONDS < end )); do
    [[ -s "$file" ]] && return 0
    if [[ -n "$active_demo_pid" ]] && ! kill -0 "$active_demo_pid" 2>/dev/null; then
      printf '%s\n' "The demo exited before $description." >&2
      return 1
    fi
    sleep 0.1
  done
  printf '%s\n' "Timed out waiting for $description." >&2
  return 1
}

wait_for_pointer_probe() {
  local scenario="$1"
  local recipient="$2"
  local end=$((SECONDS + readiness_timeout))
  while (( SECONDS < end )); do
    if swaymsg -t get_tree -r | jq -e \
      --arg title "electron-overlay demo $recipient | $scenario | pointer received" \
      '.. | objects | select(.name? == $title)' >/dev/null; then
      return 0
    fi
    sleep 0.1
  done
  printf '%s\n' "The click-through pointer probe did not receive compositor input." >&2
  return 1
}

capture_stable_screenshot() {
  local case_directory="$1"
  local previous="$case_directory/screenshot.previous.png"
  local current="$case_directory/screenshot.current.png"
  local final="$case_directory/screenshot.png"
  local attempt

  grim -o "$output" "$previous"
  for ((attempt = 1; attempt <= stability_attempts; attempt += 1)); do
    sleep 0.2
    grim -o "$output" "$current"
    if cmp -s "$previous" "$current"; then
      mv "$current" "$final"
      rm -f "$previous"
      [[ "$(identify -format '%wx%h' "$final")" == "${width}x${height}" ]] || {
        printf '%s\n' "Screenshot dimensions do not match ${width}x${height}." >&2
        return 1
      }
      return 0
    fi
    mv "$current" "$previous"
  done
  printf '%s\n' "The compositor output did not stabilize after $stability_attempts attempts." >&2
  return 1
}

stop_demo() {
  if [[ -z "$active_demo_pid" ]]; then return; fi
  kill -TERM -- "-$active_demo_pid" 2>/dev/null || true
  local end=$((SECONDS + 10))
  while (( SECONDS < end )) && kill -0 -- "-$active_demo_pid" 2>/dev/null; do sleep 0.1; done
  if kill -0 -- "-$active_demo_pid" 2>/dev/null; then
    kill -KILL -- "-$active_demo_pid" 2>/dev/null || true
  fi
  active_demo_pid=""
  sleep 0.2
}

run_case() {
  local scenario="$1"
  local mode="$2"
  local pointer_recipient="$3"
  local case_directory="$artifact_directory/$scenario"
  local ready_file="$case_directory/report.json"
  local pid_file="$case_directory/demo.pid"
  local pointer_verified=false
  local launch_command

  mkdir -p "$case_directory"
  swaymsg workspace "$scenario" >/dev/null
  printf -v launch_command '%q ' \
    setsid "$repository/tools/launch-linux-visual-demo.sh" "$repository" "$scenario" \
    "$mode" "$output" "$case_directory" "$shared_texture"
  swaymsg exec "$launch_command" >/dev/null
  wait_for_file "$pid_file" "$scenario process ID"
  active_demo_pid="$(<"$pid_file")"
  wait_for_file "$ready_file" "$scenario readiness report"
  jq -e '.scenario == $scenario and .result == "pass"' --arg scenario "$scenario" "$ready_file" >/dev/null

  if [[ "$pointer_recipient" != none ]]; then
    grim -o "$output" "$case_directory/screenshot.before-click.png"
    xdotool mousemove --sync "$((width / 2))" "$((height / 2))" click 1
    wait_for_pointer_probe "$scenario" "$pointer_recipient"
    pointer_verified=true
  fi

  capture_stable_screenshot "$case_directory"
  if [[ "$pointer_recipient" != none ]] && cmp -s \
      "$case_directory/screenshot.before-click.png" "$case_directory/screenshot.png"; then
    printf '%s\n' "$scenario screenshot did not change after pointer injection." >&2
    return 1
  fi
  python3 "$repository/tools/verify-visual-demo-screenshot.py" \
    "$scenario" "$case_directory/screenshot.png" >"$case_directory/visual-assertions.log"
  local screenshot_sha256
  screenshot_sha256="$(sha256sum "$case_directory/screenshot.png" | cut -d' ' -f1)"
  jq -n \
    --arg output "$output" \
    --arg dimensions "${width}x${height}" \
    --arg sha256 "$screenshot_sha256" \
    --argjson pointerVerified "$pointer_verified" \
    --arg pointerRecipient "$pointer_recipient" \
    '{output: $output, dimensions: $dimensions, stableFrames: true, pointerVerified: $pointerVerified, pointerRecipient: $pointerRecipient, screenshotSha256: $sha256}' \
    >"$case_directory/verification.json"
  jq -n \
    --slurpfile report "$ready_file" \
    --slurpfile verification "$case_directory/verification.json" \
    '{report: $report[0], verification: $verification[0]}' >"$case_directory/case.json"
  stop_demo
}

while IFS=$'\t' read -r scenario mode pointer; do
  run_case "$scenario" "$mode" "$pointer"
done < <(jq -r '.[] | [.id, .mode, .pointer] | @tsv' "$repository/packages/demo/scenarios.json")

jq -n \
  --arg output "$output" \
  --arg dimensions "${width}x${height}" \
  --slurpfile cases <(jq -s '.' "$artifact_directory"/*/case.json) \
  '{
    schemaVersion: 2,
    compositor: "sway-headless",
    output: $output,
    dimensions: $dimensions,
    cases: $cases[0]
  }' >"$artifact_directory/summary.json"

printf '%s\n' "Visual demo suite passed. Artifacts: $artifact_directory"
