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

INPUT="${1:?Usage: download-github-images.sh <owner/repo#number> <output-dir>}"
OUTPUT_DIR="${2:?Usage: download-github-images.sh <owner/repo#number> <output-dir>}"

# Parse owner/repo#number
REPO="${INPUT%#*}"
NUMBER="${INPUT#*#}"

if [ -z "$REPO" ] || [ -z "$NUMBER" ] || [ "$REPO" = "$INPUT" ]; then
  echo "ERROR: Invalid format. Expected owner/repo#number, got: ${INPUT}" >&2
  exit 1
fi

# Fetch issue body via gh CLI
BODY=$(gh issue view "$NUMBER" --repo "$REPO" --json body --jq '.body' 2>/dev/null) || {
  echo "ERROR: Failed to fetch issue ${INPUT}" >&2
  exit 1
}

if [ -z "$BODY" ]; then
  echo "No issue body found for ${INPUT}" >&2
  exit 0
fi

# Extract image URLs from markdown body
IMAGE_URLS=$(echo "$BODY" | python3 -c "
import re, sys

body = sys.stdin.read()
urls = set()

# ![alt](url)
for m in re.finditer(r'!\[[^\]]*\]\(([^)]+)\)', body):
    urls.add(m.group(1))

# <img src=\"url\">
for m in re.finditer(r'<img[^>]+src=[\"\\']([^\"\\'>]+)[\"\\']', body):
    urls.add(m.group(1))

# Bare GitHub user-content URLs on their own line
for m in re.finditer(r'(https://(?:user-images\.githubusercontent\.com|github\.com/user-attachments/assets)/[^\s)\"\\'>]+)', body):
    urls.add(m.group(1))

for url in sorted(urls):
    # Only keep image-like URLs
    lower = url.lower()
    is_image = any(lower.endswith(ext) for ext in ('.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'))
    is_gh_content = 'githubusercontent.com' in lower or 'github.com/user-attachments' in lower
    if is_image or is_gh_content:
        print(url)
" 2>/dev/null)

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
