#!/bin/bash
set -euo pipefail
script_dir="$(cd "$(dirname "$0")" && pwd)"
exec "$script_dir/run-driver.sh" state "$@"
