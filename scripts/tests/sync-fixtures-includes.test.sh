#!/usr/bin/env bash
# Optional overlay fixtures: {file, optional} compose includes and
# placeholder-expanded src paths skip quietly when absent/unresolved, while
# required entries refuse sync. Domain resolution here uses a project var so
# the test is independent of how the DOMAIN env gets set.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export TMPDIR="$TMP"

cp -R "$REPO_ROOT/scripts" "$TMP/scripts"
# The relocated tree has no packages/cli — pin the checkout CLI and point the
# slot-config core at the sandbox pool/projects.
export FARMSLOT_CLI="$REPO_ROOT/packages/cli/bin/farmslot.mjs"
export FARMSLOT_POOL_DIR="$TMP/pool"
export FARMSLOT_PROJECTS_DIR="$TMP/projects"
mkdir -p "$TMP/pool" "$TMP/projects/inc-test-farm/fixtures/domains/blue" "$TMP/repo"
git init -q "$TMP/repo"

DEV_SERVER_PORT=$((1024 + BASHPID % 30000))
METRO_PORT=$((DEV_SERVER_PORT + 30000))
cat > "$TMP/pool/local.json" <<EOF
{"machine":"shelltest","project":"inc-test-farm","platform":"cli","os":"darwin","host":"localhost","ssh_user":"x",
 "slots":[{"id":"it-1","project":"inc-test-farm","repo":"$TMP/repo","session":"it1","enabled":true,"mode":"dispatch",
 "resources":{"dev-server":{"port":$DEV_SERVER_PORT,"metro_port":$METRO_PORT}}}]}
EOF
write_project() { # $1 = optional project vars JSON object ("" for none)
  local vars_line=""
  [ -n "$1" ] && vars_line="\"vars\": $1,"
  cat > "$TMP/projects/inc-test-farm/project.json" <<EOF
{"name":"inc-test-farm",
 $vars_line
 "fixtures":{"templates":[
   {"dst":"COMPOSED.md","compose":{"var":"FLOW_TYPE","variants":{"fix-bug":{"file":"base.md","includes":[
     "required.md",
     {"file":"domains/{{domain}}/domain.md","optional":true},
     {"file":"domains/{{domain}}/absent.md","optional":true}
   ]}}}},
   {"src":"domains/{{domain}}/review-patterns.md","dst":"REVIEW.md","optional":true},
   {"src":"plain.md","dst":"PLAIN.md"}
 ]}}
EOF
}
printf 'BASE\n' > "$TMP/projects/inc-test-farm/fixtures/base.md"
printf 'REQUIRED\n' > "$TMP/projects/inc-test-farm/fixtures/required.md"
printf 'DOMAIN OVERLAY\n' > "$TMP/projects/inc-test-farm/fixtures/domains/blue/domain.md"
printf 'REVIEW PATTERNS\n' > "$TMP/projects/inc-test-farm/fixtures/domains/blue/review-patterns.md"
printf 'PLAIN\n' > "$TMP/projects/inc-test-farm/fixtures/plain.md"

fail() { echo "FAIL: $*" >&2; exit 1; }

# 1. Domain resolvable: overlay include composed in order, optional src synced,
#    absent optional include skips quietly.
write_project '{"domain": "blue"}'
out=$(bash "$TMP/scripts/sync-fixtures.sh" --slot it-1 --flow-type fix-bug 2>&1)
printf 'BASE\n\nREQUIRED\n\nDOMAIN OVERLAY\n' | cmp -s - "$TMP/repo/COMPOSED.md" \
  || fail "composed content wrong: $(cat "$TMP/repo/COMPOSED.md")"
[ "$(cat "$TMP/repo/REVIEW.md")" = "REVIEW PATTERNS" ] || fail "optional src not synced"
printf '%s' "$out" | grep -q "\[SKIP\] optional include domains/blue/absent.md" \
  || fail "absent optional include did not skip quietly: $out"

# 2. Domain unresolved: every overlay entry skips quietly, required content
#    unchanged, no overlay destinations created.
write_project ''
rm -rf "$TMP/repo" && mkdir -p "$TMP/repo" && git init -q "$TMP/repo"
out=$(bash "$TMP/scripts/sync-fixtures.sh" --slot it-1 --flow-type fix-bug 2>&1)
printf 'BASE\n\nREQUIRED\n' | cmp -s - "$TMP/repo/COMPOSED.md" \
  || fail "no-domain composed content wrong: $(cat "$TMP/repo/COMPOSED.md")"
[ ! -e "$TMP/repo/REVIEW.md" ] || fail "optional src synced despite unresolved domain"
printf '%s' "$out" | grep -q "optional src domains/{{domain}}/review-patterns.md not present" \
  || fail "unresolved optional src did not skip quietly: $out"
[ -f "$TMP/repo/PLAIN.md" ] || fail "required plain fixture missing"

# 3. Missing required inputs must refuse before any destination is overwritten.
#    Each scenario reaches the real fixture-plan CLI through sync-fixtures.sh.
for source_kind in template variant include directory; do
  python3 - "$TMP/projects/inc-test-farm/project.json" "$source_kind" <<'PY'
import json,sys
kind=sys.argv[2]
fixture={
 'template': {'templates':[{'src':'absent.md','dst':'PLAIN.md'}]},
 'variant': {'templates':[{'dst':'PLAIN.md','compose':{'var':'FLOW_TYPE','variants':{'fix-bug':'absent.md'}}}]},
 'include': {'templates':[{'dst':'PLAIN.md','compose':{'var':'FLOW_TYPE','variants':{'fix-bug':{'includes':['absent.md']}}}}]},
 'directory': {'directories':[{'src':'absent-directory','dst':'.agent'}]},
}[kind]
with open(sys.argv[1],'w') as f:json.dump({'name':'inc-test-farm','fixtures':fixture},f)
PY
  printf 'RETAINED\n' > "$TMP/repo/PLAIN.md"
  if out=$(bash "$TMP/scripts/sync-fixtures.sh" --slot it-1 --flow-type fix-bug 2>&1); then
    fail "missing required $source_kind succeeded: $out"
  fi
  printf '%s' "$out" | grep -q 'Required fixture absent' \
    || fail "missing required $source_kind did not identify its source: $out"
  [ "$(cat "$TMP/repo/PLAIN.md")" = RETAINED ] || fail "failed plan overwrote existing work"
  ! printf '%s' "$out" | grep -q 'fixtures synced to' || fail "failed plan reported success"
done

echo "sync-fixtures optional includes: all cases passed"
