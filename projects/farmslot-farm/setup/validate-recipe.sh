#!/usr/bin/env bash
# Unified Recipe v1 runner for the farmslot project.
# Routes CLI/gateway slots to Command Center CDP replay; mobile slots to Companion.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRIMARY_REPO="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# Honor explicit helper overrides first, normalizing npm/Homebrew wrapper shims
# to the package native binary so doctor/record do not recurse through shims.
# Without an override, prefer the standalone package's native binary.
# shellcheck disable=SC1091
. "${PRIMARY_REPO}/scripts/lib/capture-helper.sh"
if helper_bin="$(FARMSLOT_CAPTURE_HELPER_REPO_ROOT="${PRIMARY_REPO}" resolve_capture_helper_bin)"; then
  export CAPTURE_HELPER_PATH="${helper_bin}"
  export SITEED_CAPTURE_HELPER_BIN="${helper_bin}"
fi

RECIPE_PATH=""
ARTIFACTS_DIR=""
RUNTIME_DIR=""
PLATFORM_VALUE="${PLATFORM:-cli}"
CDP_PORT_VALUE="${CDP_PORT:-${FARMSLOT_CDP_PORT:-9323}}"
GATEWAY_PORT_VALUE="${GATEWAY_PORT:-${WATCHER_PORT:-}}"
METRO_PORT_VALUE="${METRO_PORT:-${WATCHER_PORT:-7677}}"
SIMULATOR_VALUE="${IOS_SIMULATOR:-${SIMULATOR:-}}"
ADB_SERIAL_VALUE="${ADB_SERIAL:-${ANDROID_SERIAL:-${ANDROID_DEVICE:-}}}"
SLOW_MS=""
RECORD_VIDEO=0
TASK_DIR=""
SYNC_EVIDENCE=0
SLOT_ID_VALUE="${SLOT_ID:-${FARMSLOT_SLOT_ID:-}}"
DRY_RUN=0

value_from_equals() {
  local option="$1"
  local value="${option#*=}"
  if [[ -z "${value}" ]]; then
    echo "ERROR: ${option%%=*} requires a value." >&2
    exit 1
  fi
  printf '%s' "${value}"
}

require_value() {
  local option="$1"
  local value="${2:-}"
  if [[ -z "${value}" || "${value}" == --* ]]; then
    echo "ERROR: ${option} requires a value." >&2
    exit 1
  fi
  printf '%s' "${value}"
}

# Gateway hooks may emit bare --simulator/--adb-serial when slot resources are unset.
# Treat the next token as a value only when it is not another flag.
optional_flag_value() {
  local value="${1:-}"
  if [[ -n "${value}" && "${value}" != --* ]]; then
    printf '%s' "${value}"
    return 0
  fi
  return 1
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --recipe)
      RECIPE_PATH="$(require_value "$1" "${2:-}")"; shift 2 ;;
    --recipe=*)
      RECIPE_PATH="$(value_from_equals "$1")"; shift ;;
    --artifacts-dir)
      ARTIFACTS_DIR="$(require_value "$1" "${2:-}")"; shift 2 ;;
    --artifacts-dir=*)
      ARTIFACTS_DIR="$(value_from_equals "$1")"; shift ;;
    --runtime-dir)
      RUNTIME_DIR="$(require_value "$1" "${2:-}")"; shift 2 ;;
    --runtime-dir=*)
      RUNTIME_DIR="$(value_from_equals "$1")"; shift ;;
    --platform)
      PLATFORM_VALUE="$(require_value "$1" "${2:-}")"; shift 2 ;;
    --platform=*)
      PLATFORM_VALUE="$(value_from_equals "$1")"; shift ;;
    --cdp-port)
      CDP_PORT_VALUE="$(require_value "$1" "${2:-}")"; shift 2 ;;
    --cdp-port=*)
      CDP_PORT_VALUE="$(value_from_equals "$1")"; shift ;;
    --gateway-port)
      GATEWAY_PORT_VALUE="$(require_value "$1" "${2:-}")"; shift 2 ;;
    --gateway-port=*)
      GATEWAY_PORT_VALUE="$(value_from_equals "$1")"; shift ;;
    --metro-port)
      METRO_PORT_VALUE="$(require_value "$1" "${2:-}")"; shift 2 ;;
    --metro-port=*)
      METRO_PORT_VALUE="$(value_from_equals "$1")"; shift ;;
    --simulator)
      if optional_flag_value "${2:-}"; then
        SIMULATOR_VALUE="${2}"; shift 2
      else
        shift
      fi ;;
    --simulator=*)
      SIMULATOR_VALUE="$(value_from_equals "$1")"; shift ;;
    --adb-serial)
      if optional_flag_value "${2:-}"; then
        ADB_SERIAL_VALUE="${2}"; shift 2
      else
        shift
      fi ;;
    --adb-serial=*)
      ADB_SERIAL_VALUE="$(value_from_equals "$1")"; shift ;;
    --slot-id)
      SLOT_ID_VALUE="$(require_value "$1" "${2:-}")"; shift 2 ;;
    --slot-id=*)
      SLOT_ID_VALUE="$(value_from_equals "$1")"; shift ;;
    --slow)
      SLOW_MS="$(require_value "$1" "${2:-}")"; shift 2 ;;
    --slow=*)
      SLOW_MS="$(value_from_equals "$1")"; shift ;;
    --record-video=*)
      RECORD_VIDEO=1; shift ;;
    --record-video)
      RECORD_VIDEO=1; shift ;;
    --task-dir)
      TASK_DIR="$(require_value "$1" "${2:-}")"; shift 2 ;;
    --task-dir=*)
      TASK_DIR="$(value_from_equals "$1")"; shift ;;
    --sync-evidence)
      SYNC_EVIDENCE=1; shift ;;
    --dry-run)
      DRY_RUN=1; shift ;;
    *)
      echo "ERROR: unknown recipe validation option '$1'." >&2
      exit 1 ;;
  esac
done

if [[ -z "${RECIPE_PATH}" || -z "${ARTIFACTS_DIR}" ]]; then
  echo "ERROR: --recipe and --artifacts-dir are required." >&2
  exit 1
fi

REPO_ROOT="${FARMSLOT_SLOT_REPO:-${REPO:-$PRIMARY_REPO}}"
MANIFEST_PATH="${PRIMARY_REPO}/docs/examples/recipes/farmslot-v1.action-manifest.json"

case "${PLATFORM_VALUE}" in
  ios|android)
    COMPANION_SCRIPT="${REPO_ROOT}/apps/companion/scripts/agentic/validate-recipe.sh"
    if [[ ! -f "${COMPANION_SCRIPT}" ]]; then
      echo "ERROR: companion recipe runner missing at ${COMPANION_SCRIPT}" >&2
      exit 1
    fi
    ARGS=(
      bash "${COMPANION_SCRIPT}"
      --recipe "${RECIPE_PATH}"
      --artifacts-dir "${ARTIFACTS_DIR}"
      --platform "${PLATFORM_VALUE}"
      --metro-port "${METRO_PORT_VALUE}"
    )
    if [[ -n "${RUNTIME_DIR}" ]]; then
      ARGS+=(--runtime-dir "${RUNTIME_DIR}")
    fi
    if [[ -n "${SIMULATOR_VALUE}" ]]; then
      ARGS+=(--simulator "${SIMULATOR_VALUE}")
    fi
    if [[ -n "${ADB_SERIAL_VALUE}" ]]; then
      ARGS+=(--adb-serial "${ADB_SERIAL_VALUE}")
    fi
    if [[ "${RECORD_VIDEO}" -eq 1 ]]; then
      ARGS+=(--record-video=full-run)
    fi
    ;;
  *)
    # Runner + harness always live in the farmslot monorepo (primary_repo), not the slot
    # worktree. --project-root points at the checkout under test (FARMSLOT_SLOT_REPO).
    RUNNER="${PRIMARY_REPO}/apps/command-center/scripts/agentic/run-recipe.mjs"
    if [[ ! -f "${RUNNER}" ]]; then
      echo "ERROR: command-center recipe runner missing at ${RUNNER}" >&2
      exit 1
    fi
    ARGS=(
      node "${RUNNER}" "${RECIPE_PATH}"
      --artifacts-dir "${ARTIFACTS_DIR}"
      --action-manifest "${MANIFEST_PATH}"
      --project-root "${REPO_ROOT}"
      --input=farmslot_dir="${PRIMARY_REPO}"
      --input=primary_repo="${PRIMARY_REPO}"
      --cdp-port "${CDP_PORT_VALUE}"
    )
    if [[ -n "${GATEWAY_PORT_VALUE}" ]]; then
      ARGS+=(--gateway-port "${GATEWAY_PORT_VALUE}")
    fi
    if [[ -n "${SLOT_ID_VALUE}" ]]; then
      ARGS+=(--slot-id "${SLOT_ID_VALUE}")
    fi
    if [[ -n "${SLOW_MS}" ]]; then
      ARGS+=(--slow "${SLOW_MS}")
    fi
    if [[ "${RECORD_VIDEO}" -eq 1 ]]; then
      ARGS+=(--record-video=full-run --record-max-fps 15 --record-max-size 1080)
    fi
    ;;
esac

if [[ "${DRY_RUN}" -eq 1 ]]; then
  printf '%q ' "${ARGS[@]}"
  printf '\n'
  exit 0
fi

if [[ -z "${TASK_DIR}" && "${ARTIFACTS_DIR}" == */artifacts/recipe-run ]]; then
  TASK_DIR="${ARTIFACTS_DIR%/artifacts/recipe-run}"
fi

if [[ "${SYNC_EVIDENCE}" -eq 1 || "${RECORD_VIDEO}" -eq 1 ]]; then
  SYNC_EVIDENCE=1
fi

"${ARGS[@]}"
exit_code=$?

if [[ "${exit_code}" -eq 0 && "${SYNC_EVIDENCE}" -eq 1 && -n "${TASK_DIR}" ]]; then
  sync_args=(
    bash "${PRIMARY_REPO}/projects/farmslot-farm/setup/sync-recipe-evidence.sh"
    --task-dir "${TASK_DIR}"
    --recipe-run-dir "${ARTIFACTS_DIR}"
  )
  if [[ "${RECORD_VIDEO}" -eq 1 ]]; then
    sync_args+=(--require-video)
  fi
  "${sync_args[@]}"
fi

exit "${exit_code}"