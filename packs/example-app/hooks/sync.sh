#!/usr/bin/env bash
# sync.sh — runs on `farmslot update` when this pack's content hash changed.
# Re-seeds the fixture repo if it disappeared; project re-registration is
# handled generically by farmslot update itself.
set -euo pipefail

bash "$(cd "$(dirname "$0")" && pwd)/pre-add.sh"
echo "example-app pack synced"
