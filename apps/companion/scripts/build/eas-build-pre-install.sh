#!/usr/bin/env bash
set -euo pipefail

echo "=== Farmslot Companion EAS pre-install: enabling Corepack ==="

corepack enable
corepack prepare yarn@4.5.3 --activate

echo "Using Yarn $(yarn --version)"
echo "=== Farmslot Companion EAS pre-install: done ==="
