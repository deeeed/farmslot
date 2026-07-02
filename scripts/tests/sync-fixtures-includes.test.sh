#!/usr/bin/env bash
# Optional overlay fixtures: {file, optional} compose includes and
# placeholder-expanded src paths skip quietly when absent/unresolved, while
# required entries keep warning. Team resolution here uses a project var so
# the test is independent of how the TEAM env gets set.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cp -R "$REPO_ROOT/scripts" "$TMP/scripts"
mkdir -p "$TMP/pool" "$TMP/projects/inc-test-farm/fixtures/teams/blue" "$TMP/repo"
git init -q "$TMP/repo"

cat > "$TMP/pool/local.json" <<EOF
{"machine":"shelltest","project":"inc-test-farm","platform":"cli","os":"darwin","host":"localhost","ssh_user":"x",
 "slots":[{"id":"it-1","project":"inc-test-farm","repo":"$TMP/repo","session":"it1","enabled":true,"mode":"dispatch"}]}
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
     {"file":"teams/{{team}}/team.md","optional":true},
     {"file":"teams/{{team}}/absent.md","optional":true},
     "missing-required.md"
   ]}}}},
   {"src":"teams/{{team}}/review-patterns.md","dst":"REVIEW.md","optional":true},
   {"src":"plain.md","dst":"PLAIN.md"}
 ]}}
EOF
}
printf 'BASE\n' > "$TMP/projects/inc-test-farm/fixtures/base.md"
printf 'REQUIRED\n' > "$TMP/projects/inc-test-farm/fixtures/required.md"
printf 'TEAM OVERLAY\n' > "$TMP/projects/inc-test-farm/fixtures/teams/blue/team.md"
printf 'REVIEW PATTERNS\n' > "$TMP/projects/inc-test-farm/fixtures/teams/blue/review-patterns.md"
printf 'PLAIN\n' > "$TMP/projects/inc-test-farm/fixtures/plain.md"

fail() { echo "FAIL: $*" >&2; exit 1; }

# 1. Team resolvable: overlay include composed in order, optional src synced,
#    absent optional include skips quietly, missing required include warns.
write_project '{"team": "blue"}'
out=$(bash "$TMP/scripts/sync-fixtures.sh" --slot it-1 --flow-type fix-bug 2>&1)
printf 'BASE\n\nREQUIRED\n\nTEAM OVERLAY\n' | cmp -s - "$TMP/repo/COMPOSED.md" \
  || fail "composed content wrong: $(cat "$TMP/repo/COMPOSED.md")"
[ "$(cat "$TMP/repo/REVIEW.md")" = "REVIEW PATTERNS" ] || fail "optional src not synced"
printf '%s' "$out" | grep -q "\[SKIP\] optional include teams/blue/absent.md" \
  || fail "absent optional include did not skip quietly: $out"
printf '%s' "$out" | grep -q "\[WARN\] include missing-required.md not found" \
  || fail "missing required include did not warn: $out"

# 2. Team unresolved: every overlay entry skips quietly, required content
#    unchanged, no overlay destinations created.
write_project ''
rm -rf "$TMP/repo" && mkdir -p "$TMP/repo" && git init -q "$TMP/repo"
out=$(bash "$TMP/scripts/sync-fixtures.sh" --slot it-1 --flow-type fix-bug 2>&1)
printf 'BASE\n\nREQUIRED\n' | cmp -s - "$TMP/repo/COMPOSED.md" \
  || fail "no-team composed content wrong: $(cat "$TMP/repo/COMPOSED.md")"
[ ! -e "$TMP/repo/REVIEW.md" ] || fail "optional src synced despite unresolved team"
printf '%s' "$out" | grep -q "optional src teams/{{team}}/review-patterns.md not present" \
  || fail "unresolved optional src did not skip quietly: $out"
[ -f "$TMP/repo/PLAIN.md" ] || fail "required plain fixture missing"

echo "sync-fixtures optional includes: all cases passed"
