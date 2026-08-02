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
# The artifacts repo is opened through a disposable blobless sparse checkout.
# Unrelated artifact blobs are never downloaded and concurrent uploads never
# share a mutable Git worktree.
# Files are placed under <flow_plural>/<id>/ in the repo.
# Uses SSH for git operations. Override host with FARMSLOT_GITHUB_SSH_HOST; otherwise
# maps known owners (deeeed → github.com-deeeed, abretonc7s → github.com-abretonc7s).
#
# PR screenshot embeds use raw.githubusercontent.com — the artifacts repo MUST be public.

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

# Disposable partial checkout. A normal clone scales with every artifact ever
# published; a shared cache also corrupts when two finalize steps overlap.
UPLOAD_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/farmslot-artifacts.XXXXXX")
CACHE_DIR="${UPLOAD_ROOT}/repo"
cleanup() {
  [ ! -d "$UPLOAD_ROOT" ] || rm -rf -- "$UPLOAD_ROOT"
}
trap cleanup EXIT INT TERM

ARTIFACTS_OWNER="${ARTIFACTS_REPO%%/*}"
if [ -n "${FARMSLOT_GITHUB_SSH_HOST:-}" ]; then
  SSH_HOST="${FARMSLOT_GITHUB_SSH_HOST}"
else
  case "$ARTIFACTS_OWNER" in
    deeeed) SSH_HOST="github.com-deeeed" ;;
    abretonc7s) SSH_HOST="github.com-abretonc7s" ;;
    *) SSH_HOST="github.com" ;;
  esac
fi
REPO_URL="git@${SSH_HOST}:${ARTIFACTS_REPO}.git"

# Fetch only the current commit/tree and materialize this publication path.
echo "Opening sparse checkout for ${ARTIFACTS_REPO}..." >&2
HAS_MAIN=true
if ! git clone --quiet --filter=blob:none --no-checkout --depth 1 --single-branch --branch main \
  "$REPO_URL" "$CACHE_DIR" >&2; then
  HAS_MAIN=false
  rm -rf -- "$CACHE_DIR"
  git clone --quiet --filter=blob:none --no-checkout --depth 1 --single-branch \
    "$REPO_URL" "$CACHE_DIR" >&2
fi
git -C "$CACHE_DIR" sparse-checkout init --cone
git -C "$CACHE_DIR" sparse-checkout set "${FLOW_DIR}/${ID}"
if $HAS_MAIN; then
  git -C "$CACHE_DIR" checkout --quiet main
elif git -C "$CACHE_DIR" rev-parse --verify HEAD >/dev/null 2>&1; then
  git -C "$CACHE_DIR" checkout --quiet -B main
else
  git -C "$CACHE_DIR" checkout --quiet --orphan main
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
  # Two independent sparse checkouts may publish concurrently. Rebase once on
  # a non-fast-forward race; distinct publication paths merge without sharing
  # or locking a local cache.
  if ! git push --quiet origin HEAD:main >&2; then
    echo "Push raced with another artifact publication; rebasing once..." >&2
    git pull --rebase --quiet origin main >&2
    git push --quiet origin HEAD:main >&2
  fi
  echo "Pushed to ${ARTIFACTS_REPO}" >&2
fi

# Output URL
if [ -n "$FILE" ]; then
  echo "https://raw.githubusercontent.com/${ARTIFACTS_REPO}/main/${FLOW_DIR}/${ID}/${FILENAME}"
else
  echo "https://github.com/${ARTIFACTS_REPO}/tree/main/${FLOW_DIR}/${ID}"
fi
