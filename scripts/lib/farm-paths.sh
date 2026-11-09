#!/usr/bin/env bash
# Caller-supplied paths have already passed through FarmPaths. Never infer a pool
# from a support bundle or this script's location.
farm_path() {
  local value
  if [ -n "${FARMSLOT_CLI:-}" ] && value=$("$FARMSLOT_CLI" paths get "$1") && [ -n "$value" ]; then
    printf '%s\n' "$value"
  else
    echo "FAIL: missing resolved $2; export $2 from FarmPaths or use a CLI with 'farmslot paths get $1'. Refusing to guess a farm root." >&2
    return 1
  fi
}

resolve_farm_shell_paths() {
  if [ -z "${FARMSLOT_POOL_DIR:-}" ]; then
    FARMSLOT_POOL_DIR=$(farm_path pool FARMSLOT_POOL_DIR) || return 1
  fi
  if [ -z "${FARMSLOT_PROJECTS_DIR:-}" ]; then
    FARMSLOT_PROJECTS_DIR=$(farm_path projects FARMSLOT_PROJECTS_DIR) || return 1
  fi
  if [ -z "${FARMSLOT_HOME:-}" ]; then
    FARMSLOT_HOME=$(farm_path home FARMSLOT_HOME) || return 1
  fi
  export FARMSLOT_POOL_DIR FARMSLOT_PROJECTS_DIR FARMSLOT_HOME
}
