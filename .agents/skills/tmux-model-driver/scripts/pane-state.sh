#!/bin/bash
set -euo pipefail
script_dir="$(cd "$(dirname "$0")" && pwd)"
exec node --import tsx "$script_dir/driver.mjs" state "$@"
