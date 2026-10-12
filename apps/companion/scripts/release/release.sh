#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
EAS_CLI_VERSION="${EAS_CLI_VERSION:-18.13.0}"
VARIANT="production"
PLATFORM="android"
MESSAGE=""
EXECUTE=0
SKIP_BUILD=0
SKIP_UPDATE=0
SUBMIT=0
LOCAL_BUILD=0
CUT_RELEASE=0
COMMAND_COUNT=0

usage() {
  cat <<USAGE
Usage: bash scripts/release/release.sh [options]

Dry-run by default. Add --execute to run EAS commands.

Options:
  --variant development|preview|production
  --platform ios|android (default: android; iOS must be explicit)
  --message <text>       EAS Update message
  --skip-build           Do not run EAS Build
  --skip-update          Do not run EAS Update
  --cut-release          Regenerate companion release proposal from farmslot root
  --submit               Submit matching build (automatic for production Android)
  --local                Use local build for development profiles only
  --execute              Actually run the mutating commands
  -h, --help             Show this help
USAGE
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --variant)
      VARIANT="${2:-}"; shift 2 ;;
    --variant=*)
      VARIANT="${1#*=}"; shift ;;
    --platform)
      PLATFORM="${2:-}"; shift 2 ;;
    --platform=*)
      PLATFORM="${1#*=}"; shift ;;
    --message)
      MESSAGE="${2:-}"; shift 2 ;;
    --message=*)
      MESSAGE="${1#*=}"; shift ;;
    --skip-build)
      SKIP_BUILD=1; shift ;;
    --skip-update)
      SKIP_UPDATE=1; shift ;;
    --cut-release)
      CUT_RELEASE=1; shift ;;
    --submit)
      SUBMIT=1; shift ;;
    --local)
      LOCAL_BUILD=1; shift ;;
    --execute)
      EXECUTE=1; shift ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      echo "ERROR: unknown release option '$1'." >&2
      usage >&2
      exit 1 ;;
  esac
done

case "${VARIANT}" in
  development|preview|production) ;;
  *) echo "ERROR: unsupported variant '${VARIANT}'." >&2; exit 1 ;;
esac
case "${PLATFORM}" in
  ios|android) ;;
  *) echo "ERROR: unsupported platform '${PLATFORM}'." >&2; exit 1 ;;
esac
if [[ "${VARIANT}" == "development" && "${SUBMIT}" -eq 1 ]]; then
  echo "ERROR: development builds are not store-submitted." >&2
  exit 1
fi

platforms=("${PLATFORM}")
PLAY_RELEASE=0
if [[ "${VARIANT}" == "production" && "${PLATFORM}" == "android" ]]; then
  PLAY_RELEASE=1
  SUBMIT=1
fi

print_command() {
  local arg
  for arg in "$@"; do
    printf '%q ' "${arg}"
  done
  printf '\n'
}

run_cmd() {
  COMMAND_COUNT=$((COMMAND_COUNT + 1))
  printf '[release] '
  print_command "$@"
  if [[ "${EXECUTE}" -eq 1 ]]; then
    "$@"
  fi
}

capture_cmd() {
  local output="$1"
  shift
  COMMAND_COUNT=$((COMMAND_COUNT + 1))
  printf '[release] '
  print_command "$@"
  if [[ "${EXECUTE}" -eq 1 ]]; then
    "$@" > "$output"
  fi
}

REPO_ROOT="$(cd "${APP_DIR}/../.." && pwd)"

if [[ "${CUT_RELEASE}" -eq 1 ]]; then
  run_cmd node "${REPO_ROOT}/scripts/release/curate-changelog.mjs" --group companion --out .release-cut/proposal.json
  echo "[release] Review ${REPO_ROOT}/.release-cut/proposal.json, then run:"
  echo "[release]   yarn release:cut --group companion --from-proposal .release-cut/proposal.json --execute"
fi

cd "${APP_DIR}"
RELEASE_TMP="<private-release-state>"
if [[ "${PLAY_RELEASE}" -eq 1 && "${EXECUTE}" -eq 1 ]]; then
  RELEASE_TMP="$(mktemp -d "${TMPDIR:-/tmp}/companion-release.XXXXXX")"
  trap 'rm -rf "$RELEASE_TMP"' EXIT
fi
BUILD_JSON="${RELEASE_TMP}/build.json"
PLAY_STATE="${RELEASE_TMP}/tracks-before.json"
echo "[release] Variant: ${VARIANT}"
echo "[release] Platform: ${PLATFORM}"
if [[ "${EXECUTE}" -eq 1 ]]; then
  echo "[release] EXECUTE enabled; mutating EAS commands will run."
else
  echo "[release] DRY RUN; add --execute to run mutating EAS commands."
fi

for target_platform in "${platforms[@]}"; do
  if [[ "${SKIP_BUILD}" -eq 0 ]]; then
    build_args=(env APP_VARIANT="${VARIANT}" NODE_ENV="${VARIANT}" yarn dlx --quiet eas-cli@"${EAS_CLI_VERSION}" build --platform "${target_platform}" --profile "${VARIANT}" --non-interactive)
    if [[ "${VARIANT}" == "development" && "${LOCAL_BUILD}" -eq 1 ]]; then
      build_args+=(--local)
    fi
    if [[ "${PLAY_RELEASE}" -eq 1 ]]; then
      capture_cmd "$BUILD_JSON" "${build_args[@]}" --wait --json
    else
      run_cmd "${build_args[@]}"
    fi
  fi
done

if [[ "${PLAY_RELEASE}" -eq 1 && "${SKIP_BUILD}" -eq 1 ]]; then
  capture_cmd "$BUILD_JSON" env APP_VARIANT=production NODE_ENV=production yarn dlx --quiet eas-cli@"${EAS_CLI_VERSION}" build:list --platform android --build-profile production --distribution store --status finished --limit 1 --json --non-interactive
fi

if [[ "${SKIP_UPDATE}" -eq 0 ]]; then
  update_message="${MESSAGE:-${VARIANT} release $(date -u +%Y-%m-%dT%H:%M:%SZ)}"
  run_cmd env APP_VARIANT="${VARIANT}" NODE_ENV="${VARIANT}" yarn dlx eas-cli@"${EAS_CLI_VERSION}" update --platform "${PLATFORM}" --channel "${VARIANT}" --environment "${VARIANT}" --message "${update_message}"
fi

if [[ "${SUBMIT}" -eq 1 ]]; then
  for target_platform in "${platforms[@]}"; do
    if [[ "${PLAY_RELEASE}" -eq 1 ]]; then
      run_cmd bash "${SCRIPT_DIR}/ensure-play-service-account.sh"
      run_cmd node "${SCRIPT_DIR}/play-tracks.mjs" snapshot "$BUILD_JSON" "$PLAY_STATE"
      build_id="<built-production-android-id>"
      if [[ "${EXECUTE}" -eq 1 ]]; then
        build_id="$(node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(s.buildId)' "$PLAY_STATE")"
      fi
      submit_source=(--id "$build_id" --wait)
    else
      submit_source=(--latest)
    fi
    submit_args=(
      env APP_VARIANT="${VARIANT}" NODE_ENV="${VARIANT}"
      yarn dlx eas-cli@"${EAS_CLI_VERSION}" submit
      --platform "${target_platform}"
      --profile "${VARIANT}"
      "${submit_source[@]}"
      --non-interactive
    )
    if [[ "${target_platform}" == "android" ]]; then
      if [[ "${PLAY_RELEASE}" -eq 1 ]]; then
        echo "[release] Upload once to internal, promote that versionCode to alpha, then verify both tracks."
        echo "[release] Public production-track publication remains manual."
      elif [[ "${EXECUTE}" -eq 1 ]]; then
        bash "${SCRIPT_DIR}/ensure-play-service-account.sh"
      else
        echo "[release] Android submit uses .eas/google-play-service-account.json (symlinked at execute time)."
      fi
    fi
    run_cmd "${submit_args[@]}"
    if [[ "${PLAY_RELEASE}" -eq 1 ]]; then
      run_cmd node "${SCRIPT_DIR}/play-tracks.mjs" promote "$BUILD_JSON" "$PLAY_STATE"
    fi
  done
fi

echo "[release] Planned ${COMMAND_COUNT} command(s)."
