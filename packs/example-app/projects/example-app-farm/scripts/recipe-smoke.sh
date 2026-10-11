#!/usr/bin/env bash
set -euo pipefail
farm_dir="${1:?Farmslot directory required}"
checkout="${2:?Checkout required}"
source "$farm_dir/scripts/lib/resolve-farmslot-cli.sh"
exec node "$farm_dir/projects/example-app-farm/scripts/recipe-smoke.mjs" "$FARMSLOT_CLI" "$checkout"
