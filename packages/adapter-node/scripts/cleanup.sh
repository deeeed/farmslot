#!/usr/bin/env bash
# cleanup.sh: remove a headless adapter's recipe-harness overlay.
#
# Inputs: --adapter <id> (required); --target <checkout> (default $PWD);
#         env RECIPE_HARNESS_ROOT (checkout-relative, default temp/recipe/harness).
# Outputs: removes <target>/<harness root>/<id>.
# Exit: 0 cleaned (idempotent); 1 invalid RECIPE_HARNESS_ROOT; 2 bad args.
# Never touches: product files. A headless install patches nothing in the
# checkout, so there are no backups to restore; a missing overlay is a success.
set -euo pipefail

ADAPTER=""
TARGET="$PWD"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --adapter) ADAPTER="$2"; shift 2 ;;
    --target) TARGET="$2"; shift 2 ;;
    -h|--help) echo "Usage: cleanup.sh --adapter <id> [--target <checkout>]"; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

case "$ADAPTER" in
  "") echo "cleanup.sh: --adapter <id> is required" >&2; exit 2 ;;
  .|..|*[!A-Za-z0-9._-]*) echo "cleanup.sh: invalid adapter id: '$ADAPTER'" >&2; exit 2 ;;
esac

# The checkout-relative overlay root. An empty value falls back to the default;
# a set value must be relative, use a safe charset and have no '.'/'..'
# components, so a hostile or mistyped value can't make rm -rf leave the target.
harness_root() {
  local root="${RECIPE_HARNESS_ROOT:-temp/recipe/harness}"
  case "$root" in
    /*) echo "RECIPE_HARNESS_ROOT must be a non-empty relative path: '$root'" >&2; return 1 ;;
    *[!A-Za-z0-9._/-]*) echo "RECIPE_HARNESS_ROOT may only contain A-Za-z0-9 and . _ / - : '$root'" >&2; return 1 ;;
  esac
  local IFS=/ part
  for part in $root; do
    case "$part" in
      .|..) echo "RECIPE_HARNESS_ROOT must not contain '.' or '..' path components: '$root'" >&2; return 1 ;;
    esac
  done
  printf '%s' "$root"
}

TARGET="$(cd "$TARGET" && pwd)"
HARNESS_ROOT="$(harness_root)"
HARNESS_DIR="$TARGET/$HARNESS_ROOT/$ADAPTER"

rm -rf "$HARNESS_DIR"
echo "Cleaned $ADAPTER recipe harness from $TARGET"
