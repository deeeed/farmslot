#!/bin/bash
# download-jira-images.sh — Download image attachments from a Jira ticket.
#
# Usage:
#   bash scripts/download-jira-images.sh PROJ-2403 projects/example-mobile-farm/tasks/TASK-proj-2403-assets
#
# Reads JIRA_USERNAME and JIRA_API_TOKEN from the Atlassian MCP config
# in ~/.claude/settings.json. Downloads all image attachments to the
# specified output directory.
#
# Output (stdout): space-separated list of downloaded filenames, or empty if none.
# Exit codes: 0 = success (even if no images), 1 = error

set -euo pipefail

ISSUE_KEY="${1:?Usage: download-jira-images.sh <issue-key> <output-dir>}"
OUTPUT_DIR="${2:?Usage: download-jira-images.sh <issue-key> <output-dir>}"

# Resolve Jira credentials from Atlassian MCP config
CREDS=$(python3 -c "
import json, os
settings = os.path.expanduser('~/.claude/settings.json')
d = json.load(open(settings))
env = d['mcpServers']['atlassian']['env']
print(env['JIRA_USERNAME'])
print(env['JIRA_API_TOKEN'])
" 2>/dev/null) || { echo "ERROR: Cannot read Jira credentials from ~/.claude/settings.json" >&2; exit 1; }

JIRA_USER=$(echo "$CREDS" | head -1)
JIRA_TOKEN=$(echo "$CREDS" | tail -1)

# Resolve Jira base URL from env. Keep this project-neutral; private Jira hosts
# belong in local environment, not in the repository.
JIRA_URL="${JIRA_URL:?Set JIRA_URL to your Jira base URL, for example https://jira.example.com}"

# Fetch attachment metadata
ATTACHMENTS=$(curl -s -u "${JIRA_USER}:${JIRA_TOKEN}" \
  -H "Accept: application/json" \
  "${JIRA_URL}/rest/api/3/issue/${ISSUE_KEY}?fields=attachment" 2>/dev/null)

if [ -z "$ATTACHMENTS" ]; then
  echo "ERROR: Failed to fetch issue ${ISSUE_KEY}" >&2
  exit 1
fi

# Parse image attachments via jq (ported from Python heredoc)
IMAGE_DATA=$(echo "$ATTACHMENTS" | jq -r '
  .fields.attachment[]?
  | select(.mimeType | startswith("image/"))
  | "\(.id)|\(.filename | gsub(" "; "-") | gsub("'"'"'"; ""))|\(.size // 0)"
' 2>/dev/null)

if [ -z "$IMAGE_DATA" ]; then
  echo "No image attachments found for ${ISSUE_KEY}" >&2
  exit 0
fi

mkdir -p "$OUTPUT_DIR"
DOWNLOADED=""

while IFS='|' read -r att_id filename size; do
  [ -z "$att_id" ] && continue
  echo "  Downloading ${filename} (${size} bytes)..." >&2
  curl -L -s -u "${JIRA_USER}:${JIRA_TOKEN}" \
    -H "X-Atlassian-Token: no-check" \
    -H "Accept: */*" \
    "${JIRA_URL}/rest/api/3/attachment/content/${att_id}" \
    -o "${OUTPUT_DIR}/${filename}"

  if [ -s "${OUTPUT_DIR}/${filename}" ]; then
    DOWNLOADED="${DOWNLOADED} ${filename}"
  else
    echo "  WARNING: ${filename} downloaded as empty file" >&2
    rm -f "${OUTPUT_DIR}/${filename}"
  fi
done <<< "$IMAGE_DATA"

DOWNLOADED="${DOWNLOADED# }"
echo "$DOWNLOADED"
