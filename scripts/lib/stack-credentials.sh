#!/usr/bin/env bash
# A newly selected stack loads auth and bind policy from its own files.
# Credential keys match packages/agent-runtime/src/native/worker-launch.ts.
clear_inherited_gateway_credentials() {
  unset FARMSLOT_NODE_TOKEN FARMSLOT_GATEWAY_TOKEN FARMSLOT_GATEWAY_PASSWORD
  unset GATEWAY_HOST FARMSLOT_GATEWAY_AUTH_MODE
}

sandbox_runtime_dir() {
  printf '%s\n' "${FARMSLOT_RUNTIME_DIR:-$1/.sandbox/farmslot-farm/agent}"
}

pin_sandbox_home() {
  if [ -n "${FARMSLOT_SANDBOX_HOME:-}" ]; then
    export FARMSLOT_HOME="$FARMSLOT_SANDBOX_HOME"
  fi
}

# Sandbox services and their clients must never open the operator credential store.
isolate_sandbox_home() {
  mkdir -p "$1/home"
  export FARMSLOT_SANDBOX_HOME="$(cd "$1/home" && pwd -P)"
  pin_sandbox_home
  local home_guard
  home_guard="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/sandbox-home.cjs"
  case " ${NODE_OPTIONS:-} " in
    *" --require \"$home_guard\" "*) ;;
    *) export NODE_OPTIONS="--require \"$home_guard\"${NODE_OPTIONS:+ $NODE_OPTIONS}" ;;
  esac
}
