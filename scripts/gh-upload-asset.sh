#!/bin/bash
# gh-upload-asset.sh — Upload file(s) to a per-project artifacts repo via git push.
#
# Usage:
#   bash scripts/gh-upload-asset.sh --file /path/to/file --artifacts-repo owner/repo --flow review --id 27409
#   bash scripts/gh-upload-asset.sh --dir /path/to/dir/  --artifacts-repo owner/repo --flow review --id 27409
#
# Output (stdout): raw.githubusercontent.com URL of the uploaded file (--file) or
#   github.com tree URL of the uploaded directory (--dir).
#
# The artifacts repo is cloned/cached at ~/.cache/farmslot/<owner>/<repo>.
# Files are placed under <flow_plural>/<id>/ in the repo.
# Uses SSH for git operations (git@github.com:owner/repo.git).

set -euo pipefail

FILE=""
DIR=""
ARTIFACTS_REPO=""
FLOW=""
ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --file)           FILE="$2"; shift 2 ;;
    --dir)            DIR="$2"; shift 2 ;;
    --artifacts-repo) ARTIFACTS_REPO="$2"; shift 2 ;;
    --flow)           FLOW="$2"; shift 2 ;;
    --id)             ID="$2"; shift 2 ;;
    *) echo "ERROR: Unknown arg: $1" >&2; exit 1 ;;
  esac
done

[ -z "$ARTIFACTS_REPO" ] && { echo "ERROR: --artifacts-repo required" >&2; exit 1; }
[ -z "$FLOW" ] && { echo "ERROR: --flow required" >&2; exit 1; }
[ -z "$ID" ] && { echo "ERROR: --id required" >&2; exit 1; }
[ -z "$FILE" ] && [ -z "$DIR" ] && { echo "ERROR: --file or --dir required" >&2; exit 1; }

if [ -n "$FILE" ] && [ ! -f "$FILE" ]; then
  echo "ERROR: file not found: $FILE" >&2; exit 1
fi
if [ -n "$DIR" ] && [ ! -d "$DIR" ]; then
  echo "ERROR: directory not found: $DIR" >&2; exit 1
fi

# Map flow to plural folder name
case "$FLOW" in
  review)  FLOW_DIR="reviews" ;;
  fix)     FLOW_DIR="fixes" ;;
  feature) FLOW_DIR="features" ;;
  *)       FLOW_DIR="${FLOW}s" ;;
esac

# Local clone cache
CACHE_DIR="${HOME}/.cache/farmslot/${ARTIFACTS_REPO}"
REPO_URL="git@github.com:${ARTIFACTS_REPO}.git"

# Clone or pull
if [ -d "${CACHE_DIR}/.git" ]; then
  echo "Pulling ${ARTIFACTS_REPO}..." >&2
  if ! git -C "$CACHE_DIR" pull --ff-only --quiet origin main 2>&1 >&2; then
    echo "Pull failed, re-cloning..." >&2
    trash "$CACHE_DIR" 2>/dev/null || rm -r "$CACHE_DIR"
    mkdir -p "$(dirname "$CACHE_DIR")"
    git clone --quiet "$REPO_URL" "$CACHE_DIR" 2>&1 >&2
  fi
else
  echo "Cloning ${ARTIFACTS_REPO}..." >&2
  mkdir -p "$(dirname "$CACHE_DIR")"
  git clone --quiet "$REPO_URL" "$CACHE_DIR" 2>&1 >&2
fi

# Target directory in the repo
TARGET="${CACHE_DIR}/${FLOW_DIR}/${ID}"
mkdir -p "$TARGET"

# Copy file(s)
FILENAME=""
if [ -n "$FILE" ]; then
  FILENAME=$(basename "$FILE")
  cp "$FILE" "${TARGET}/${FILENAME}"
  echo "Copied ${FILENAME} -> ${FLOW_DIR}/${ID}/" >&2
elif [ -n "$DIR" ]; then
  # Copy all contents preserving structure. Existing files must be overwritten:
  # publication replays may reuse the same PR/id path after screenshots change.
  # Directory uploads represent the full artifact set for this id, so remove
  # files that disappeared locally instead of leaving stale publish evidence.
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete "$DIR/" "$TARGET/" >&2
  else
    find "$TARGET" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
    cp -R "$DIR"/. "$TARGET/" >&2
  fi
  echo "Copied dir -> ${FLOW_DIR}/${ID}/" >&2
fi

# Git add + commit + push
cd "$CACHE_DIR"
git add "${FLOW_DIR}/${ID}/"

if git diff --cached --quiet; then
  echo "No changes (files already up to date)" >&2
else
  git commit --quiet -m "Add ${FLOW_DIR}/${ID} artifacts"
  git push --quiet origin HEAD 2>&1 >&2
  echo "Pushed to ${ARTIFACTS_REPO}" >&2
fi

# Output URL
if [ -n "$FILE" ]; then
  echo "https://raw.githubusercontent.com/${ARTIFACTS_REPO}/main/${FLOW_DIR}/${ID}/${FILENAME}"
else
  echo "https://github.com/${ARTIFACTS_REPO}/tree/main/${FLOW_DIR}/${ID}"
fi
