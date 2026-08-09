#!/usr/bin/env bash
set -Eeuo pipefail

readonly repository="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
readonly machine="${ORB_TEST_MACHINE:-electron-overlay-visual-$$}"
readonly artifact_directory="${ORB_TEST_ARTIFACT_DIR:-$repository/artifacts/orbstack-visual/$timestamp}"
readonly keep_machine="${ORB_KEEP_VM:-false}"
readonly reuse_machine="${ORB_REUSE_VM:-false}"
readonly shared_texture="${VISUAL_DEMO_SHARED_TEXTURE:-false}"
readonly source_archive_name="electron-overlay-source.tgz"
readonly result_archive_name="electron-overlay-visual-artifacts.tgz"

temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/electron-overlay-orbstack.XXXXXX")"
source_archive="$temporary_directory/$source_archive_name"
created_machine=false
preserve_machine=false

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  rm -rf "$temporary_directory"
  if [[ "$created_machine" == true && "$keep_machine" != true && "$preserve_machine" != true ]]; then
    orbctl delete --force "$machine" >/dev/null 2>&1 || true
  elif [[ "$created_machine" == true ]]; then
    printf '%s\n' "Kept OrbStack machine: $machine"
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

command -v orbctl >/dev/null || { printf '%s\n' "OrbStack's orbctl command is required." >&2; exit 1; }
[[ "$shared_texture" == true || "$shared_texture" == false ]] || {
  printf '%s\n' "VISUAL_DEMO_SHARED_TEXTURE must be true or false." >&2
  exit 1
}
machine_exists=false
if orbctl info "$machine" >/dev/null 2>&1; then machine_exists=true; fi
if [[ "$machine_exists" == true && "$reuse_machine" != true ]]; then
  printf '%s\n' \
    "OrbStack machine '$machine' already exists. Choose another ORB_TEST_MACHINE or set ORB_REUSE_VM=true." >&2
  exit 1
fi

mkdir -p "$artifact_directory"
COPYFILE_DISABLE=1 tar \
  --no-xattrs \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='packages/*/node_modules' \
  --exclude='dist' \
  --exclude='build' \
  --exclude='artifacts' \
  --exclude='*.log' \
  -czf "$source_archive" -C "$repository" .

if [[ "$machine_exists" != true ]]; then
  printf '%s\n' "Creating disposable OrbStack machine '$machine' (Ubuntu 24.04, amd64)."
  orbctl create \
    --arch amd64 \
    --cpus "${ORB_TEST_CPUS:-4}" \
    --memory "${ORB_TEST_MEMORY:-6G}" \
    --disk "${ORB_TEST_DISK:-20G}" \
    ubuntu:24.04 "$machine" >/dev/null
  created_machine=true

  printf '%s\n' "Provisioning Linux visual-test dependencies."
  orbctl run -m "$machine" -u root bash -lc '
  set -Eeuo pipefail
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y \
    build-essential ca-certificates curl dbus-x11 fonts-liberation grim imagemagick jq \
    libasound2t64 libatk-bridge2.0-0 libcups2 libdrm2 libgbm1 libgtk-3-0 libnss3 \
    libwayland-dev libx11-dev libx11-xcb1 libxcomposite1 libxdamage1 libxext-dev \
    libxfixes-dev libxkbcommon0 libxrandr2 libxss1 pkg-config python3 ripgrep sway \
    python3-pil wayland-utils xdotool xwayland xz-utils
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
  node --version
  npm --version
'
else
  printf '%s\n' "Reusing provisioned OrbStack machine '$machine'."
fi

orbctl push -m "$machine" "$source_archive"
orbctl run -m "$machine" bash -lc "
  set -Eeuo pipefail
  rm -rf \"\$HOME/electron-overlay\"
  mkdir -p \"\$HOME/electron-overlay\"
  tar -xzf \"\$HOME/$source_archive_name\" -C \"\$HOME/electron-overlay\"
  cd \"\$HOME/electron-overlay\"
  npm ci
  npm run build
  npm run rebuild:electron
  node ./node_modules/electron/install.js
"

printf '%s\n' "Running visual scenarios in headless Sway."
set +e
orbctl run -m "$machine" bash -lc "
  cd \"\$HOME/electron-overlay\"
  VISUAL_DEMO_SHARED_TEXTURE=$shared_texture bash ./tools/run-linux-visual-demo-suite.sh
"
guest_status=$?
set -e

retrieval_status=0
orbctl run -m "$machine" bash -lc "
  set -Eeuo pipefail
  tar -czf \"\$HOME/$result_archive_name\" -C \"\$HOME/electron-overlay/artifacts/orbstack-visual\" .
" || retrieval_status=$?
if (( retrieval_status == 0 )); then
  orbctl pull -m "$machine" "$result_archive_name" "$artifact_directory/" || retrieval_status=$?
fi
if (( retrieval_status == 0 )); then
  tar -xzf "$artifact_directory/$result_archive_name" -C "$artifact_directory" || retrieval_status=$?
fi
rm -f "$artifact_directory/$result_archive_name"

if (( retrieval_status != 0 )); then
  preserve_machine=true
  printf '%s\n' \
    "Could not retrieve visual artifacts (status $retrieval_status); preserving OrbStack machine '$machine'." >&2
  if (( guest_status != 0 )); then
    printf '%s\n' "The guest visual suite also failed with status $guest_status." >&2
  fi
  exit "$retrieval_status"
fi

if (( guest_status != 0 )); then
  printf '%s\n' "OrbStack visual tests failed. Artifacts: $artifact_directory" >&2
  exit "$guest_status"
fi

printf '%s\n' "OrbStack visual tests passed. Artifacts: $artifact_directory"
printf '%s\n' "Summary: $artifact_directory/summary.json"
