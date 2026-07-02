#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
EAS_CLI_VERSION="${EAS_CLI_VERSION:-18.13.0}"
VARIANT="preview"
PLATFORM="all"
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
  --platform ios|android|all
  --message <text>       EAS Update message
  --skip-build           Do not run EAS Build
  --skip-update          Do not run EAS Update
  --cut-release          Regenerate companion release proposal from farmslot root
  --submit               Submit latest matching build after build/update plan
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
  ios|android|all) ;;
  *) echo "ERROR: unsupported platform '${PLATFORM}'." >&2; exit 1 ;;
esac
if [[ "${VARIANT}" == "development" && "${SUBMIT}" -eq 1 ]]; then
  echo "ERROR: development builds are not store-submitted." >&2
  exit 1
fi

platforms=()
if [[ "${PLATFORM}" == "all" ]]; then
  platforms=(ios android)
else
  platforms=("${PLATFORM}")
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

REPO_ROOT="$(cd "${APP_DIR}/../.." && pwd)"

if [[ "${CUT_RELEASE}" -eq 1 ]]; then
  run_cmd node "${REPO_ROOT}/scripts/release/curate-changelog.mjs" --group companion --out .release-cut/proposal.json
  echo "[release] Review ${REPO_ROOT}/.release-cut/proposal.json, then run:"
  echo "[release]   yarn release:cut --group companion --from-proposal .release-cut/proposal.json --execute"
fi

cd "${APP_DIR}"
echo "[release] Variant: ${VARIANT}"
echo "[release] Platform: ${PLATFORM}"
if [[ "${EXECUTE}" -eq 1 ]]; then
  echo "[release] EXECUTE enabled; mutating EAS commands will run."
else
  echo "[release] DRY RUN; add --execute to run mutating EAS commands."
fi

for target_platform in "${platforms[@]}"; do
  if [[ "${SKIP_BUILD}" -eq 0 ]]; then
    build_args=(env APP_VARIANT="${VARIANT}" NODE_ENV="${VARIANT}" yarn dlx eas-cli@"${EAS_CLI_VERSION}" build --platform "${target_platform}" --profile "${VARIANT}")
    if [[ "${VARIANT}" == "development" && "${LOCAL_BUILD}" -eq 1 ]]; then
      build_args+=(--local)
    fi
    run_cmd "${build_args[@]}"
  fi
done

if [[ "${SKIP_UPDATE}" -eq 0 ]]; then
  update_message="${MESSAGE:-${VARIANT} release $(date -u +%Y-%m-%dT%H:%M:%SZ)}"
  run_cmd env APP_VARIANT="${VARIANT}" NODE_ENV="${VARIANT}" yarn dlx eas-cli@"${EAS_CLI_VERSION}" update --channel "${VARIANT}" --environment "${VARIANT}" --message "${update_message}"
fi

if [[ "${SUBMIT}" -eq 1 ]]; then
  for target_platform in "${platforms[@]}"; do
    run_cmd env APP_VARIANT="${VARIANT}" NODE_ENV="${VARIANT}" yarn dlx eas-cli@"${EAS_CLI_VERSION}" submit --platform "${target_platform}" --profile "${VARIANT}"
  done
fi

echo "[release] Planned ${COMMAND_COUNT} command(s)."
