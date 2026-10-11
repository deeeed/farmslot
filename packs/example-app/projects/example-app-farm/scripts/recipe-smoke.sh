#!/usr/bin/env bash
set -euo pipefail
farm_dir="${1:?Farmslot directory required}"
checkout="${2:?Checkout required}"
source "$farm_dir/scripts/lib/resolve-farmslot-cli.sh"
exec "$FARMSLOT_CLI" recipe run smoke --project example-app-farm --target "$checkout" --json
