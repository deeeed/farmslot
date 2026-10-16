#!/usr/bin/env bash
# sync-fixtures --node-support-dir: template and directory fixtures render the
# gateway-selected node-support bundle as {{node_support_dir}}, direct callers
# fall back to farmslot_dir, and values that would break sed or quoting are refused.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cp -R "$REPO_ROOT/scripts" "$TMP/scripts"
export FARMSLOT_CLI="$REPO_ROOT/packages/cli/bin/farmslot.mjs"
export FARMSLOT_POOL_DIR="$TMP/pool"
export FARMSLOT_PROJECTS_DIR="$TMP/projects"
mkdir -p "$TMP/pool" "$TMP/projects/support-test-farm/fixtures/tree" "$TMP/repo"
git init -q "$TMP/repo"

DEV_SERVER_PORT=$((1024 + BASHPID % 30000))
METRO_PORT=$((DEV_SERVER_PORT + 30000))
cat > "$TMP/pool/local.json" <<EOF
{"machine":"shelltest","project":"support-test-farm","platform":"cli","os":"darwin","host":"localhost","ssh_user":"x",
 "slots":[{"id":"ns-1","project":"support-test-farm","repo":"$TMP/repo","session":"ns1","enabled":true,"mode":"dispatch",
 "resources":{"dev-server":{"port":$DEV_SERVER_PORT,"metro_port":$METRO_PORT}}}]}
EOF
cat > "$TMP/projects/support-test-farm/project.json" <<'EOF'
{"name":"support-test-farm",
 "fixtures":{
   "templates":[{"src":"ci-parity","dst":"temp/ci-parity"}],
   "directories":[{"src":"tree","dst":"temp/tree"}]
 }}
EOF
printf 'root={{node_support_dir}}/projects/support-test-farm\n' > "$TMP/projects/support-test-farm/fixtures/ci-parity"
printf 'ROOT={{NODE_SUPPORT_DIR}}\n' > "$TMP/projects/support-test-farm/fixtures/tree/run.sh"

sync() { bash "$TMP/scripts/sync-fixtures.sh" --slot ns-1 "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

# 1. The gateway-selected bundle reaches template and directory fixtures.
BUNDLE="/home/node/farmslot-node/support/$(printf 'a%.0s' {1..64})"
sync --node-support-dir "$BUNDLE" >/dev/null
[ "$(cat "$TMP/repo/temp/ci-parity")" = "root=$BUNDLE/projects/support-test-farm" ] \
  || fail "template fixture: $(cat "$TMP/repo/temp/ci-parity")"
[ "$(cat "$TMP/repo/temp/tree/run.sh")" = "ROOT=$BUNDLE" ] \
  || fail "directory fixture: $(cat "$TMP/repo/temp/tree/run.sh")"

# 2. Without the flag a direct caller renders farmslot_dir: the CLI checkout
#    for a local slot (the sandbox's copied scripts for directory fixtures).
sync >/dev/null
[ "$(cat "$TMP/repo/temp/ci-parity")" = "root=$REPO_ROOT/projects/support-test-farm" ] \
  || fail "default template fixture: $(cat "$TMP/repo/temp/ci-parity")"
[ "$(cat "$TMP/repo/temp/tree/run.sh")" = "ROOT=$TMP" ] \
  || fail "default directory fixture: $(cat "$TMP/repo/temp/tree/run.sh")"

# 3. The bash drift check (preflight-slot.sh) renders the same default, so a
#    direct sync followed by preflight matches.
"$FARMSLOT_CLI" internal render-fixture-template ns-1 "$TMP/projects/support-test-farm/fixtures/ci-parity" \
  | cmp -s - "$TMP/repo/temp/ci-parity" || fail "render-fixture-template differs from the synced default"

# 4. Relative, quoted, sed-delimiter and multi-line values are refused before any write.
NEWLINE_DIR="$(printf '/ok\n/evil')"
for hostile in 'relative/dir' '/a|b' "/a'b" '/a"b' '/a b' '/a$b' "$NEWLINE_DIR"; do
  rm -f "$TMP/repo/temp/ci-parity"
  set +e
  out=$(sync --node-support-dir "$hostile" 2>&1)
  rc=$?
  set -e
  [ "$rc" -ne 0 ] || fail "node support dir '$hostile' was accepted"
  printf '%s' "$out" | grep -q "invalid --node-support-dir" || fail "no error for '$hostile': $out"
  [ ! -e "$TMP/repo/temp/ci-parity" ] || fail "fixture written despite rejected '$hostile'"
done

echo "sync-fixtures --node-support-dir: all cases passed"
