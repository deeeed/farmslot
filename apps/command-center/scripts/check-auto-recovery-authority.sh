#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TARGET="$ROOT/services/gateway/src/auto-recovery"
PATTERN="child_process|execSync|spawn\(|ssh |shell:"

scan_with_grep() {
  local found=0
  local output
  local status
  while IFS= read -r -d '' file; do
    if output="$(grep -n -E "$PATTERN" "$file")"; then
      while IFS= read -r line; do
        printf '%s:%s\n' "$file" "$line"
      done <<< "$output"
      found=1
    else
      status=$?
      if [[ "$status" -ne 1 ]]; then
        echo "auto-recovery authority scan failed while reading $file" >&2
        return "$status"
      fi
    fi
  done < <(find "$TARGET" -type f ! -name '*.test.ts' ! -path '*/fixtures/*' -print0)
  [[ "$found" -eq 1 ]]
}

if command -v rg >/dev/null 2>&1; then
  SCAN_CMD=(rg -n "$PATTERN" "$TARGET" --glob '!*.test.ts' --glob '!fixtures/**')
elif command -v grep >/dev/null 2>&1 && command -v find >/dev/null 2>&1; then
  SCAN_CMD=(scan_with_grep)
else
  echo "auto-recovery authority scan unavailable: install ripgrep or provide grep/find" >&2
  exit 1
fi

set +e
"${SCAN_CMD[@]}"
SCAN_STATUS=$?
set -e

if [[ "$SCAN_STATUS" -eq 0 ]]; then
  echo "auto-recovery authority violation: direct shell-out found" >&2
  exit 1
elif [[ "$SCAN_STATUS" -ne 1 ]]; then
  echo "auto-recovery authority scan failed" >&2
  exit "$SCAN_STATUS"
fi
