#!/usr/bin/env bash
# A newly selected stack loads auth and bind policy from its own files.
# Credential keys match packages/agent-runtime/src/native/worker-launch.ts.
clear_inherited_gateway_credentials() {
  unset FARMSLOT_NODE_TOKEN FARMSLOT_GATEWAY_TOKEN FARMSLOT_GATEWAY_PASSWORD
  unset GATEWAY_HOST FARMSLOT_GATEWAY_AUTH_MODE
}

pin_sandbox_home() {
  if [ -n "${FARMSLOT_SANDBOX_HOME:-}" ]; then
    export FARMSLOT_HOME="$FARMSLOT_SANDBOX_HOME"
    # The guard owns option merging for shell launches and later Node reloads.
    local sandbox_node_options
    sandbox_node_options="$(NODE_OPTIONS= node "$FARMSLOT_SANDBOX_HOME_GUARD" "${NODE_OPTIONS:-}")" || return
    export NODE_OPTIONS="$sandbox_node_options"
  fi
}

# Sandbox services and their clients must never open the operator credential store.
isolate_sandbox_home() {
  mkdir -p "$1/home"
  export FARMSLOT_SANDBOX_HOME="$(cd "$1/home" && pwd -P)"
  local home_guard guard_tmp
  home_guard="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/sandbox-home.cjs"
  export FARMSLOT_SANDBOX_HOME_GUARD="$(cd "$1" && pwd -P)/sandbox-home.cjs"
  # Respawns use a runtime copy that survives checkout resets.
  guard_tmp="$(mktemp "$1/sandbox-home.XXXXXX")"
  cp "$home_guard" "$guard_tmp"
  mv -f "$guard_tmp" "$FARMSLOT_SANDBOX_HOME_GUARD"
  pin_sandbox_home
}
