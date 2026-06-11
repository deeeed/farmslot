#!/bin/bash
# run-project-hook.sh <slot-id> <hook-name>
# Expands hooks.<hook-name> from the slot's project.json with the full slot
# variable set (lib/slot-common.sh expand_hook) and runs it in the slot repo.
# Generic: no hook names or project behavior are hardcoded here.
#
# Usage:
#   bash scripts/run-project-hook.sh runner-app-1 preflight
set -euo pipefail

SLOT_ID="${1:?Usage: run-project-hook.sh <slot-id> <hook-name>}"
HOOK_NAME="${2:?Usage: run-project-hook.sh <slot-id> <hook-name>}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
POOL_DIR="${PROJECT_DIR}/pool"

source "${SCRIPT_DIR}/lib/slot-common.sh"
load_slot_vars "$SLOT_ID"
load_project_config || { echo "FAIL: no project config for ${SLOT_ID}"; exit 1; }

HOOK=$(expand_hook "$HOOK_NAME")
if [ -z "$HOOK" ]; then
  echo "no hooks.${HOOK_NAME} defined for ${PROJECT_NAME} — nothing to run"
  exit 0
fi

echo "[run-project-hook] ${SLOT_ID} ${HOOK_NAME}: ${HOOK}"
# Note: apply_project_command_env_current_shell ends in `[ -n ] && eval`, which
# returns 1 under errexit when no command_env is configured — guard explicitly.
ENV_PREFIX=$(project_command_env_shell_prefix)
if is_local "$HOST" "$MACHINE"; then
  if [ -n "$ENV_PREFIX" ]; then eval "$ENV_PREFIX"; fi
  cd "$REPO"
  eval "$HOOK"
else
  remote "cd '${REMOTE_REPO}' && ${ENV_PREFIX} ${HOOK}"
fi
