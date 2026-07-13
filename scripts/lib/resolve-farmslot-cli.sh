#!/usr/bin/env bash
# resolve-farmslot-cli.sh — source this to set FARMSLOT_CLI.
# Checkout-local CLI first; relocated script trees (deploy-node copies, test
# sandboxes) fall back to the installed farmslot. Fails loudly when neither
# exists. Override by exporting FARMSLOT_CLI before sourcing.
if [ -z "${FARMSLOT_CLI:-}" ]; then
  _farmslot_cli_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../packages/cli" 2>/dev/null && pwd || true)"
  if [ -n "$_farmslot_cli_dir" ] && [ -f "${_farmslot_cli_dir}/bin/farmslot.mjs" ]; then
    FARMSLOT_CLI="${_farmslot_cli_dir}/bin/farmslot.mjs"
  elif command -v farmslot >/dev/null 2>&1; then
    FARMSLOT_CLI="$(command -v farmslot)"
  else
    echo "FAIL: farmslot CLI not found (no packages/cli next to scripts/ and no farmslot on PATH). Set FARMSLOT_CLI." >&2
    return 1 2>/dev/null || exit 1
  fi
fi
