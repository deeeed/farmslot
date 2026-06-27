#!/usr/bin/env bash
# Promote recipe-run screenshots/video into task artifacts/ for PR publication.
#
# Usage:
#   bash projects/farmslot/setup/sync-recipe-evidence.sh --task-dir <TASK_DIR> \
#     [--recipe-run-dir <dir>] [--require-video]
set -euo pipefail

TASK_DIR=""
RECIPE_RUN_DIR=""
REQUIRE_VIDEO=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --task-dir)
      TASK_DIR="${2:-}"
      shift 2
      ;;
    --task-dir=*)
      TASK_DIR="${1#*=}"
      shift
      ;;
    --recipe-run-dir)
      RECIPE_RUN_DIR="${2:-}"
      shift 2
      ;;
    --recipe-run-dir=*)
      RECIPE_RUN_DIR="${1#*=}"
      shift
      ;;
    --require-video)
      REQUIRE_VIDEO=1
      shift
      ;;
    *)
      echo "ERROR: unknown option '$1'" >&2
      exit 1
      ;;
  esac
done

[[ -n "$TASK_DIR" ]] || { echo "ERROR: --task-dir is required" >&2; exit 1; }

ARTIFACTS_DIR="$TASK_DIR/artifacts"
if [[ -z "$RECIPE_RUN_DIR" ]]; then
  RECIPE_RUN_DIR="$ARTIFACTS_DIR/recipe-run"
fi

mkdir -p "$ARTIFACTS_DIR"

if [[ -d "$RECIPE_RUN_DIR/screenshots" ]]; then
  for src in "$RECIPE_RUN_DIR/screenshots"/*; do
    [[ -f "$src" ]] || continue
    base="$(basename "$src")"
    dest="$ARTIFACTS_DIR/$base"
    if [[ "$base" == before-* ]]; then
      cp -f "$src" "$dest"
    elif [[ "$base" == after-* || "$base" == demo-* || "$base" == evidence-* ]]; then
      cp -f "$src" "$dest"
    else
      cp -f "$src" "$ARTIFACTS_DIR/after-${base}"
    fi
    echo "[sync-recipe-evidence] screenshot -> artifacts/$(basename "$dest")"
  done
fi

VIDEO_SRC="$RECIPE_RUN_DIR/videos/recipe-run.mp4"
if [[ -f "$VIDEO_SRC" ]]; then
  cp -f "$VIDEO_SRC" "$ARTIFACTS_DIR/after.mp4"
  echo "[sync-recipe-evidence] video -> artifacts/after.mp4"
  if command -v python3 >/dev/null 2>&1; then
    python3 - <<'PY' "$ARTIFACTS_DIR/after.mp4"
import sys
path = sys.argv[1]
data = open(path, "rb").read()
if b"moov" not in data:
    raise SystemExit(f"after.mp4 missing moov atom: {path}")
print(f"ok: {path} ({len(data)} bytes, moov present)")
PY
  fi
elif [[ "$REQUIRE_VIDEO" -eq 1 ]]; then
  echo "ERROR: required video missing at $VIDEO_SRC" >&2
  exit 1
fi

if [[ -f "$RECIPE_RUN_DIR/summary.json" ]]; then
  cp -f "$RECIPE_RUN_DIR/summary.json" "$ARTIFACTS_DIR/recipe-run-summary.json"
fi

echo "[sync-recipe-evidence] done"