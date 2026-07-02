#!/usr/bin/env bash
# sync-fixtures --team behavior: substitution when set, byte-identical fixtures
# when unset, and rejection of names outside the slug contract (they would
# otherwise land in sed replacement text and fixture paths).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Relocate the real scripts into a sandbox root so pool/ and projects/ are ours.
cp -R "$REPO_ROOT/scripts" "$TMP/scripts"
mkdir -p "$TMP/pool" "$TMP/projects/team-test-farm/fixtures" "$TMP/repo"
git init -q "$TMP/repo"

cat > "$TMP/pool/local.json" <<EOF
{"machine":"shelltest","project":"team-test-farm","platform":"cli","os":"darwin","host":"localhost","ssh_user":"x",
 "slots":[{"id":"tt-1","project":"team-test-farm","repo":"$TMP/repo","session":"tt1","enabled":true,"mode":"dispatch"}]}
EOF
cat > "$TMP/projects/team-test-farm/project.json" <<'EOF'
{"name":"team-test-farm",
 "fixtures":{"templates":[
   {"src":"with-team.md","dst":"WITH_TEAM.md"},
   {"src":"plain.md","dst":"PLAIN.md"}
 ]}}
EOF
printf 'team={{team}} TEAM={{TEAM}}\n' > "$TMP/projects/team-test-farm/fixtures/with-team.md"
printf 'no placeholders here\n' > "$TMP/projects/team-test-farm/fixtures/plain.md"

sync() { bash "$TMP/scripts/sync-fixtures.sh" "$@"; }

fail() { echo "FAIL: $*" >&2; exit 1; }

# 1. Valid team substitutes into fixture content (lowercase + uppercase forms).
sync --slot tt-1 --team blue >/dev/null
[ "$(cat "$TMP/repo/WITH_TEAM.md")" = "team=blue TEAM=blue" ] \
  || fail "expected team substitution, got: $(cat "$TMP/repo/WITH_TEAM.md")"

# 2. No --team: a fixture without placeholders is byte-identical to its source
#    (pre-team behavior), and {{team}} renders empty by contract.
rm -f "$TMP/repo/WITH_TEAM.md" "$TMP/repo/PLAIN.md"
env -u TEAM bash "$TMP/scripts/sync-fixtures.sh" --slot tt-1 >/dev/null
cmp -s "$TMP/projects/team-test-farm/fixtures/plain.md" "$TMP/repo/PLAIN.md" \
  || fail "plain fixture not byte-identical without --team"
[ "$(cat "$TMP/repo/WITH_TEAM.md")" = "team= TEAM=" ] \
  || fail "expected empty team substitution, got: $(cat "$TMP/repo/WITH_TEAM.md")"

# 3. Hostile names are rejected before anything runs: non-zero exit, an
#    'invalid --team' error, and no fixture written. The newline case guards
#    the whole-string anchoring: line-based matching (grep) would accept the
#    'blue' first line and smuggle the rest through.
NEWLINE_TEAM="$(printf 'blue\nEVIL')"
for hostile in '../evil' 'a b' 'a|b' 'a"b' 'Blue' 'a/../b' 'a&b' '.hidden' "$NEWLINE_TEAM"; do
  rm -f "$TMP/repo/WITH_TEAM.md" "$TMP/repo/PLAIN.md"
  set +e
  out=$(sync --slot tt-1 --team "$hostile" 2>&1)
  rc=$?
  set -e
  [ "$rc" -ne 0 ] || fail "team '$hostile' was accepted (exit 0)"
  printf '%s' "$out" | grep -q "invalid --team" || fail "no invalid-team error for '$hostile': $out"
  [ ! -e "$TMP/repo/WITH_TEAM.md" ] && [ ! -e "$TMP/repo/PLAIN.md" ] \
    || fail "fixtures were written despite rejected team '$hostile'"
done

# 4. Slug-contract names with inner dots/dashes stay accepted (e.g. a..b has no
#    path separator, so it cannot traverse once it lands in a path segment).
sync --slot tt-1 --team a..b >/dev/null
[ "$(cat "$TMP/repo/WITH_TEAM.md")" = "team=a..b TEAM=a..b" ] \
  || fail "expected a..b substitution, got: $(cat "$TMP/repo/WITH_TEAM.md")"

echo "sync-fixtures --team: all cases passed"
