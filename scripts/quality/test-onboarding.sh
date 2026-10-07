#!/usr/bin/env bash
# test-onboarding.sh — scratch-workspace E2E self-test for the onboarding layer.
#
#   install → doctor → project add example-app → re-add (no-op) → update → doctor
#
# Run before pushing onboarding changes: yarn test:onboarding (repo root).
# Everything runs in a throwaway FARMSLOT_WORKSPACE; the real workspace, pool
# files, and PATH are never touched.
#
# NOTE: install.sh dev mode clones the checkout's committed HEAD — uncommitted
# changes are not exercised. Commit before running.
set -euo pipefail

# Real tmux only on a private server: no $TMUX, and a TMUX_TMPDIR this test
# owns, so plain `tmux` here and in the scripts under test lands on it. Cleanup
# ends that server by its socket, never the operator's.
unset TMUX TMUX_PANE
TMUX_TMPDIR="$(mktemp -d "${TMPDIR:-/tmp}/fs-tmux-XXXXXX")"
export TMUX_TMPDIR
FARMSLOT_TMUX_SANDBOX="$TMUX_TMPDIR/tmux-$(id -u)/default"
export FARMSLOT_TMUX_SANDBOX
# With -S, tmux does not create the per-user socket directory it would under TMUX_TMPDIR.
mkdir -m 700 "$TMUX_TMPDIR/tmux-$(id -u)"
tmux_sandbox_close() {
  # The socket exists only if the test started a server.
  if [ -S "$FARMSLOT_TMUX_SANDBOX" ]; then
    tmux -S "$FARMSLOT_TMUX_SANDBOX" kill-server 2>/dev/null || true # the server may already be gone
  fi
  rm -rf "$TMUX_TMPDIR"
}

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRATCH="$(mktemp -d)"
export FARMSLOT_WORKSPACE="${SCRATCH}/fsw"
export FARMSLOT_BIN_DIR="${FARMSLOT_WORKSPACE}/bin"
export PATH="${FARMSLOT_BIN_DIR}:${PATH}"

# The pack is copied so the update stage can bump its content without touching
# the repo. The slot's tmux session lives on this run's private server, which
# cleanup ends.
PACK="${SCRATCH}/example-app"
cleanup() {
  rm -rf "$SCRATCH"
  tmux_sandbox_close
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
ws = '${FARMSLOT_WORKSPACE}'
state = json.load(open(f'{ws}/state.json'))
f = f\"{ws}/farmslot/{state['pool_file']}\"
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
