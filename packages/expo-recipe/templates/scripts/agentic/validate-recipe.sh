#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

RECIPE_PATH="scripts/agentic/recipe/recipes/expo.config.recipe.json"
ARTIFACTS_DIR=""
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
    --dry-run)
      DRY_RUN=1; shift ;;
    --runtime-dir|--platform|--metro-port|--simulator|--adb-serial)
      require_value "$1" "${2:-}" >/dev/null; shift 2 ;;
    --runtime-dir=*|--platform=*|--metro-port=*|--simulator=*|--adb-serial=*)
      shift ;;
    *)
      echo "ERROR: unknown recipe validation option '$1'." >&2
      exit 1 ;;
  esac
done

if [[ -z "${ARTIFACTS_DIR}" ]]; then
  echo "ERROR: --artifacts-dir is required." >&2
  exit 1
fi

ARGS=(farmslot-expo-recipe run "${RECIPE_PATH}" --artifacts-dir "${ARTIFACTS_DIR}")
if [[ "${DRY_RUN}" -eq 1 ]]; then
  ARGS+=(--dry-run)
fi

cd "${APP_DIR}"
yarn "${ARGS[@]}"
