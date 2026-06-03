#!/usr/bin/env bash
# Validate pool and project JSON configs against their schemas.
#
# Usage:
#   bash scripts/validate-config.sh                    # validate all configs
#   bash scripts/validate-config.sh pool/example.json  # validate one file
#   bash scripts/validate-config.sh --quiet            # suppress success messages
#
# Requires: pip3 install jsonschema

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if ! python3 -c "import jsonschema" 2>/dev/null; then
  echo "ERROR: python3 jsonschema package required. Install with: pip3 install jsonschema" >&2
  exit 1
fi

QUIET=false
TARGETS=()

for arg in "$@"; do
  case "$arg" in
    --quiet|-q) QUIET=true ;;
    *) TARGETS+=("$arg") ;;
  esac
done

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

ERRORS=0
VALIDATED=0

validate_one() {
  local config_file="$1" schema_file="$2"
  python3 - "$config_file" "$schema_file" <<'PYEOF'
import json, sys
from jsonschema import validate, ValidationError, SchemaError

config_path, schema_path = sys.argv[1], sys.argv[2]
with open(config_path) as f:
    config = json.load(f)
with open(schema_path) as f:
    schema = json.load(f)

try:
    validate(instance=config, schema=schema)
except ValidationError as e:
    path = ".".join(str(p) for p in e.absolute_path) if e.absolute_path else "(root)"
    print(f"  {path}: {e.message}", file=sys.stderr)
    sys.exit(1)
except SchemaError as e:
    print(f"  Schema error: {e.message}", file=sys.stderr)
    sys.exit(2)
PYEOF
}

validate_file() {
  local config_file="$1"
  local rel_path="${config_file#$ROOT_DIR/}"

  # Determine schema
  local schema_file=""
  case "$rel_path" in
    pool/*.json)              schema_file="$ROOT_DIR/schemas/pool.schema.json" ;;
    projects/*/project.json)  schema_file="$ROOT_DIR/schemas/project.schema.json" ;;
    *)
      echo -e "${YELLOW}SKIP${NC} $rel_path (no matching schema)"
      return 0
      ;;
  esac

  if validate_one "$config_file" "$schema_file" 2>&1; then
    $QUIET || echo -e "${GREEN}PASS${NC} $rel_path"
    VALIDATED=$((VALIDATED + 1))
  else
    local output
    output=$(validate_one "$config_file" "$schema_file" 2>&1) || true
    echo -e "${RED}FAIL${NC} $rel_path"
    echo "$output"
    ERRORS=$((ERRORS + 1))
  fi
}

# --- Main ---

if [ ${#TARGETS[@]} -gt 0 ]; then
  for target in "${TARGETS[@]}"; do
    if [[ "$target" != /* ]]; then
      target="$ROOT_DIR/$target"
    fi
    if [ ! -f "$target" ]; then
      echo -e "${RED}ERROR${NC} File not found: $target"
      ERRORS=$((ERRORS + 1))
      continue
    fi
    validate_file "$target"
  done
else
  for f in "$ROOT_DIR"/pool/*.json; do
    [ -f "$f" ] && validate_file "$f"
  done
  for f in "$ROOT_DIR"/projects/*/project.json; do
    [ -f "$f" ] && validate_file "$f"
  done
fi

echo ""
if [ $ERRORS -gt 0 ]; then
  echo -e "${RED}$ERRORS failed${NC}, $VALIDATED passed"
  exit 1
else
  echo -e "${GREEN}All $VALIDATED configs valid${NC}"
fi
