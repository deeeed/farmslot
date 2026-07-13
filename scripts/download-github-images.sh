#!/bin/bash
# download-github-images.sh — Download images from a GitHub issue body.
#
# Usage:
#   bash scripts/download-github-images.sh example-org/example-mobile#12345 <output-dir>
#
# Parses the issue body for image URLs (![](url), <img src>, GitHub user-content).
# Downloads each image to the specified output directory.
#
# Output (stdout): space-separated list of downloaded filenames, or empty if none.
# Exit codes: 0 = success (even if no images), 1 = error

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Resolve farmslot CLI (copied from scripts/lib/slot-common.sh) ─────────────
# shellcheck disable=SC1091
source "$(dirname "$0")/lib/resolve-farmslot-cli.sh"

INPUT="${1:?Usage: download-github-images.sh <owner/repo#number> <output-dir>}"
OUTPUT_DIR="${2:?Usage: download-github-images.sh <owner/repo#number> <output-dir>}"

# Parse owner/repo#number
REPO="${INPUT%#*}"
NUMBER="${INPUT#*#}"

if [ -z "$REPO" ] || [ -z "$NUMBER" ] || [ "$REPO" = "$INPUT" ]; then
  echo "ERROR: Invalid format. Expected owner/repo#number, got: ${INPUT}" >&2
  exit 1
fi

# Fetch full issue JSON via gh CLI (title,body,labels,state,url needed by parse-bug-input)
GH_JSON=$(gh issue view "$NUMBER" --repo "$REPO" --json title,body,labels,state,url 2>/dev/null) || {
  echo "ERROR: Failed to fetch issue ${INPUT}" >&2
  exit 1
}

if [ -z "$GH_JSON" ]; then
  echo "No issue body found for ${INPUT}" >&2
  exit 0
fi

# Extract image URLs via CLI (ported from Python heredoc; shared extractImageUrls implementation)
IMAGE_URLS=$(echo "$GH_JSON" | "$FARMSLOT_CLI" internal parse-bug-input github | jq -r '.image_urls[]? // empty' 2>/dev/null)

if [ -z "$IMAGE_URLS" ]; then
  echo "No images found in issue body for ${INPUT}" >&2
  exit 0
fi

mkdir -p "$OUTPUT_DIR"
DOWNLOADED=""
COUNTER=0

while IFS= read -r url; do
  [ -z "$url" ] && continue
  COUNTER=$((COUNTER + 1))

  # Derive filename: use URL basename if meaningful, else numbered name
  BASENAME=$(echo "$url" | python3 -c "
import sys, os, re, uuid
from urllib.parse import urlparse, unquote
url = sys.stdin.read().strip()
path = unquote(urlparse(url).path)
name = os.path.basename(path)
# Sanitize
name = re.sub(r'[^a-zA-Z0-9._-]', '-', name)
# Detect UUID-only names (GitHub user-attachments use UUIDs as filenames)
bare = os.path.splitext(name)[0]
is_uuid = False
try:
    uuid.UUID(bare)
    is_uuid = True
except ValueError:
    pass
if is_uuid or '.' not in name or len(name) < 3:
    name = 'gh-${NUMBER}-${COUNTER}.png'
print(name)
" 2>/dev/null)

  [ -z "$BASENAME" ] && BASENAME="image-${COUNTER}.png"

  echo "  Downloading ${BASENAME}..." >&2
  curl -L -s -o "${OUTPUT_DIR}/${BASENAME}" "$url"

  if [ -s "${OUTPUT_DIR}/${BASENAME}" ]; then
    DOWNLOADED="${DOWNLOADED} ${BASENAME}"
  else
    echo "  WARNING: ${BASENAME} downloaded as empty file" >&2
    rm -f "${OUTPUT_DIR}/${BASENAME}"
  fi
done <<< "$IMAGE_URLS"

DOWNLOADED="${DOWNLOADED# }"
echo "$DOWNLOADED"
