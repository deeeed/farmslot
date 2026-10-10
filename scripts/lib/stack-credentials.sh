#!/usr/bin/env bash
# A newly selected stack loads credentials from its own files.
clear_inherited_gateway_credentials() {
  unset FARMSLOT_NODE_TOKEN FARMSLOT_GATEWAY_TOKEN FARMSLOT_GATEWAY_PASSWORD
}
