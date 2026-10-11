#!/usr/bin/env bash
# A newly selected stack loads auth and bind policy from its own files.
# Credential keys match packages/agent-runtime/src/native/worker-launch.ts.
clear_inherited_gateway_credentials() {
  unset FARMSLOT_NODE_TOKEN FARMSLOT_GATEWAY_TOKEN FARMSLOT_GATEWAY_PASSWORD
  unset GATEWAY_HOST FARMSLOT_GATEWAY_AUTH_MODE
}
