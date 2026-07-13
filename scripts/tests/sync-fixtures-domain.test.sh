#!/usr/bin/env bash
# sync-fixtures --domain behavior: substitution when set, byte-identical fixtures
# when unset, and rejection of names outside the slug contract (they would
# otherwise land in sed replacement text and fixture paths).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Relocate the real scripts into a sandbox root so pool/ and projects/ are ours.
cp -R "$REPO_ROOT/scripts" "$TMP/scripts"
# The relocated tree has no packages/cli — pin the checkout CLI and point the
# slot-config core at the sandbox pool/projects.
export FARMSLOT_CLI="$REPO_ROOT/packages/cli/bin/farmslot.mjs"
export FARMSLOT_POOL_DIR="$TMP/pool"
export FARMSLOT_PROJECTS_DIR="$TMP/projects"
mkdir -p "$TMP/pool" "$TMP/projects/domain-test-farm/fixtures" "$TMP/repo"
git init -q "$TMP/repo"

cat > "$TMP/pool/local.json" <<EOF
{"machine":"shelltest","project":"domain-test-farm","platform":"cli","os":"darwin","host":"localhost","ssh_user":"x",
 "slots":[{"id":"tt-1","project":"domain-test-farm","repo":"$TMP/repo","session":"tt1","enabled":true,"mode":"dispatch"}]}
EOF
cat > "$TMP/projects/domain-test-farm/project.json" <<'EOF'
{"name":"domain-test-farm",
 "fixtures":{"templates":[
   {"src":"with-domain.md","dst":"WITH_DOMAIN.md"},
   {"src":"plain.md","dst":"PLAIN.md"}
 ]}}
EOF
printf 'domain={{domain}} DOMAIN={{DOMAIN}}\n' > "$TMP/projects/domain-test-farm/fixtures/with-domain.md"
printf 'no placeholders here\n' > "$TMP/projects/domain-test-farm/fixtures/plain.md"

sync() { bash "$TMP/scripts/sync-fixtures.sh" "$@"; }

fail() { echo "FAIL: $*" >&2; exit 1; }

# 1. Valid domain substitutes into fixture content (lowercase + uppercase forms).
sync --slot tt-1 --domain blue >/dev/null
[ "$(cat "$TMP/repo/WITH_DOMAIN.md")" = "domain=blue DOMAIN=blue" ] \
  || fail "expected domain substitution, got: $(cat "$TMP/repo/WITH_DOMAIN.md")"

# 2. No --domain: a fixture without placeholders is byte-identical to its source
#    (pre-domain behavior), and {{domain}} renders empty by contract.
rm -f "$TMP/repo/WITH_DOMAIN.md" "$TMP/repo/PLAIN.md"
env -u DOMAIN bash "$TMP/scripts/sync-fixtures.sh" --slot tt-1 >/dev/null
cmp -s "$TMP/projects/domain-test-farm/fixtures/plain.md" "$TMP/repo/PLAIN.md" \
  || fail "plain fixture not byte-identical without --domain"
[ "$(cat "$TMP/repo/WITH_DOMAIN.md")" = "domain= DOMAIN=" ] \
  || fail "expected empty domain substitution, got: $(cat "$TMP/repo/WITH_DOMAIN.md")"

# 3. Hostile names are rejected before anything runs: non-zero exit, an
#    'invalid --domain' error, and no fixture written. The newline case guards
#    the whole-string anchoring: line-based matching (grep) would accept the
#    'blue' first line and smuggle the rest through.
NEWLINE_DOMAIN="$(printf 'blue\nEVIL')"
for hostile in '../evil' 'a b' 'a|b' 'a"b' 'Blue' 'a/../b' 'a&b' '.hidden' "$NEWLINE_DOMAIN"; do
  rm -f "$TMP/repo/WITH_DOMAIN.md" "$TMP/repo/PLAIN.md"
  set +e
  out=$(sync --slot tt-1 --domain "$hostile" 2>&1)
  rc=$?
  set -e
  [ "$rc" -ne 0 ] || fail "domain '$hostile' was accepted (exit 0)"
  printf '%s' "$out" | grep -q "invalid --domain" || fail "no invalid-domain error for '$hostile': $out"
  [ ! -e "$TMP/repo/WITH_DOMAIN.md" ] && [ ! -e "$TMP/repo/PLAIN.md" ] \
    || fail "fixtures were written despite rejected domain '$hostile'"
done

# 4. Slug-contract names with inner dots/dashes stay accepted (e.g. a..b has no
#    path separator, so it cannot traverse once it lands in a path segment).
sync --slot tt-1 --domain a..b >/dev/null
[ "$(cat "$TMP/repo/WITH_DOMAIN.md")" = "domain=a..b DOMAIN=a..b" ] \
  || fail "expected a..b substitution, got: $(cat "$TMP/repo/WITH_DOMAIN.md")"

echo "sync-fixtures --domain: all cases passed"
