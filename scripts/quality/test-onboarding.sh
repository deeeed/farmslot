#!/usr/bin/env bash
# test-onboarding.sh — scratch-workspace E2E self-test for the onboarding layer.
#
#   install → doctor → project add example-app → re-add (no-op) → update → doctor
#
# Pre-push guard. Everything runs in a throwaway FARMSLOT_WORKSPACE; the real
# workspace, pool files, and PATH are never touched.
#
# NOTE: install.sh dev mode clones the checkout's committed HEAD — uncommitted
# changes are not exercised. Commit before running.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRATCH="$(mktemp -d)"
export FARMSLOT_WORKSPACE="${SCRATCH}/fsw"
export FARMSLOT_BIN_DIR="${FARMSLOT_WORKSPACE}/bin"
export PATH="${FARMSLOT_BIN_DIR}:${PATH}"

# The pack is copied so the update stage can bump its content without touching
# the repo. The slot's tmux session is scratch-specific — clean it up, but only
# if this run created it (never kill an operator's pre-existing session).
PACK="${SCRATCH}/example-app"
SESSION_PRE_EXISTING=0
tmux has-session -t '=example-app-1' 2>/dev/null && SESSION_PRE_EXISTING=1
cleanup() {
  if [ "$SESSION_PRE_EXISTING" = 0 ]; then
    # =name forces exact match — plain -t prefix-matches other sessions.
    tmux kill-session -t '=example-app-1' 2>/dev/null || true # best-effort: session may not exist
  fi
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

step() { printf '\n\033[1m=== %s ===\033[0m\n' "$1"; }
die() { printf '\033[0;31mFAIL: %s\033[0m\n' "$1"; exit 1; }

slot_count() {
  python3 -c "
import glob, json, sys
count = 0
for f in glob.glob('${FARMSLOT_WORKSPACE}/farmslot/pool/*.json'):
    with open(f) as fh:
        count += sum(1 for s in json.load(fh)['slots'] if 'example-app' in s['id'])
print(count)
"
}

step "1. install (dev/test mode)"
bash "${ROOT}/install.sh"

step "2. doctor"
farmslot doctor

step "3. project add example-app"
cp -R "${ROOT}/packs/example-app" "$PACK"
farmslot project add "$PACK"
[ "$(slot_count)" = "1" ] || die "expected 1 example-app slot after add, got $(slot_count)"

step "4. re-add (idempotent no-op)"
add_out="$(farmslot project add "$PACK")"
echo "$add_out" | grep -q 'example-app: noop' || die "re-add was not a no-op"
[ "$(slot_count)" = "1" ] || die "re-add duplicated slots: $(slot_count)"

step "5. update (pack content bump + pool schema fixture)"
echo "# content bump $(date +%s)" >> "${PACK}/README.bump.md"
# Project-dir content edits must propagate to the registered copy on update.
MARKER="E2E_SYNC_MARKER_$(date +%s)"
echo "# ${MARKER}" >> "${PACK}/projects/example-app-farm/fixtures/app.env.template"
python3 -c "
import json
path = '${FARMSLOT_WORKSPACE}/farmslot/pool'
import glob
f = [p for p in glob.glob(path + '/*.json') if 'demo' not in p and 'example' not in p][0]
with open(f) as fh: pool = json.load(fh)
pool['schema_version'] = 0
with open(f, 'w') as fh: json.dump(pool, fh, indent=2)
print(f'downgraded {f} to schema_version 0')
"
update_out="$(farmslot update)"
echo "$update_out" | tail -20
echo "$update_out" | grep -q '001-init-schema-version' || die "pool migration did not run"
echo "$update_out" | grep -q 'pack example-app re-synced' || die "pack was not re-synced"
grep -q "$MARKER" "${FARMSLOT_WORKSPACE}/farmslot/projects/example-app-farm/fixtures/app.env.template" \
  || die "project-dir content edit did not propagate to the registered copy"

step "6. final doctor"
farmslot doctor
[ "$(slot_count)" = "1" ] || die "slot count drifted: $(slot_count)"

printf '\n\033[0;32m\033[1m=== onboarding E2E passed ===\033[0m\n'
