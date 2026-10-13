#!/usr/bin/env bash
# Promote recipe-run screenshots/video into task artifacts/ for PR publication.
#
# Usage:
#   bash projects/farmslot-farm/setup/sync-recipe-evidence.sh --task-dir <TASK_DIR> \
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
  helper="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)/packages/agent-runtime/scripts/retained-recipe-attempt.cjs"
  RECIPE_RUN_DIR="$(node -e '
    const path = require("node:path");
    const {readRecipeAttemptSelection} = require(process.argv[1]);
    const pointer = readRecipeAttemptSelection(process.argv[2]);
    console.log(path.join(process.argv[2], "artifacts", pointer?.relativeArtifactRoot ?? "recipe-run"));
  ' "$helper" "$TASK_DIR")"
fi

# Keep original attempt media; only the mutable selection manifest advances.
python3 - "$TASK_DIR" "$RECIPE_RUN_DIR" "$REQUIRE_VIDEO" <<'PY'
import json, os, sys
from pathlib import Path

task = Path(sys.argv[1]).resolve()
run = Path(sys.argv[2]).resolve()
require_video = sys.argv[3] == "1"
run.relative_to(task / "artifacts")
manifest_path = task / "artifacts" / "evidence-manifest.json"
manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {"version": 1}
standalone = manifest.setdefault("standalone", [])
known = {row.get("file") for row in standalone}
for source in sorted((run / "screenshots").glob("*")):
    if not source.is_file():
        continue
    relative = source.resolve().relative_to(task).as_posix()
    if relative not in known:
        standalone.append({"label": source.name, "file": relative})
video = run / "videos" / "recipe-run.mp4"
if video.is_file():
    if b"moov" not in video.read_bytes():
        raise SystemExit("recording is missing its moov atom")
    manifest.setdefault("videos", {}).update({"after": video.relative_to(task).as_posix(), "preferred": True})
elif require_video:
    raise SystemExit("required recording is missing from the retained attempt")
if standalone or manifest.get("videos"):
    temporary = manifest_path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(manifest, indent=2) + "\n")
    os.replace(temporary, manifest_path)
print("[sync-recipe-evidence] selection references retained attempt media")
PY
