#!/bin/bash
set -euo pipefail
script_dir="$(cd "$(dirname "$0")" && pwd)"
checkout="$(cd "$script_dir/../../../.." && pwd)"
loader="$(node -e 'process.stdout.write(require.resolve("tsx", { paths: [process.argv[1]] }))' "$checkout")"
exec node --import "$loader" "$script_dir/driver.mjs" "$@"
