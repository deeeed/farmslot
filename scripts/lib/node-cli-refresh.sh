#!/usr/bin/env bash
# Sourced by deploy-node.sh, never run on its own: it reads the deploy's MACHINE,
# INSTANCE, IS_LOCAL, REFRESH_CLI, REPO_ROOT, SCRIPT_DIR, REMOTE_HOME, NODE_PATH,
# NODE_DIR and NODE_GATEWAY_URL, and runs node commands through its run().

# --- Refresh the farmslot CLI slot workers run on this machine ---
# Workers call the gateway through `farmslot` on their PATH, so a node deployed
# without its CLI keeps running worker-side fixes from whatever revision that
# CLI was last installed at. Install the deployed revision as an immutable
# snapshot, ~/.local/share/farmslot-cli/<sha>/, and point the user's farmslot
# links at it. Links into a git checkout are switched too; the checkout is never
# touched, and the previous target is printed and kept for rollback. One CLI per machine:
# dev and prod workers resolve the same `farmslot`, so the last deploy wins. On
# a local deploy the CLI is the operator's own, so it is refreshed only on request.
if [[ "$IS_LOCAL" == true && "$REFRESH_CLI" != true ]]; then
  echo "[deploy] local deploy: node CLI left as is; pass --refresh-cli to install the deployed revision"
else
  CLI_SHA=$(git -C "$REPO_ROOT" rev-parse --verify HEAD 2>/dev/null || true)
  if [[ ! "$CLI_SHA" =~ ^[0-9a-f]{40,64}$ ]]; then
    echo "[deploy] ERROR: $REPO_ROOT is not a git checkout; the node CLI is installed from a committed revision" >&2
    exit 1
  fi
  if [[ -n "$(git -C "$REPO_ROOT" status --porcelain -- packages)" ]]; then
    echo "[deploy] WARNING: uncommitted changes under packages/ reach the node service but not the CLI snapshot of $CLI_SHA" >&2
  fi
  CLI_ROOT="$REMOTE_HOME/.local/share/farmslot-cli"
  CLI_SNAPSHOT="$CLI_ROOT/$CLI_SHA"
  CLI_ENTRY="$CLI_SNAPSHOT/packages/cli/bin/farmslot.mjs"
  # The archive is streamed only when the snapshot is missing; the node checks
  # again under its lock.
  CLI_ARCHIVE=/dev/null
  CLI_ARCHIVE_SHA256=""
  if run "test -f $(printf '%q' "$CLI_SNAPSHOT/DEPLOYED-REVISION.json")"; then
    echo "[deploy] node CLI snapshot $CLI_SHA already installed"
  else
    echo "[deploy] installing node CLI snapshot $CLI_SHA..."
    CLI_ARCHIVE=$(mktemp "${TMPDIR:-/tmp}/deploy-node-cli-XXXXXX")
    trap 'rm -f "$CLI_ARCHIVE"' EXIT
    git -C "$REPO_ROOT" archive --format=tar "$CLI_SHA" > "$CLI_ARCHIVE"
    CLI_ARCHIVE_SHA256=$(shasum -a 256 "$CLI_ARCHIVE" | cut -d' ' -f1)
  fi

  # Install, link swap and prune run as one script on the node, holding
  # $CLI_ROOT/.lock: overlapping deploys (dev and prod, or two revisions) never
  # prune a snapshot another deploy has just linked. A lock whose holder is gone
  # is stale and taken over, along with the partial directories it left.
  # The snapshot is built in a partial directory and renamed into place once the
  # install and DEPLOYED-REVISION.json are done, so live links never point at a
  # snapshot being rebuilt. Only the CLI and its workspace dependencies are
  # installed (about 100 MB; the full monorepo install is several GB and builds
  # native modules). When a link moves, snapshots nothing points at any more are
  # pruned; this one and the previous link targets stay for rollback.
  # install.sh links ~/.local/bin/farmslot; npm-style installs own ~/.npm-global/bin.
  echo "[deploy] pointing farmslot links at the node CLI snapshot..."
  CLI_REFRESH=$(cat << 'REFRESH'
set -euo pipefail
root=$1 sha=$2 sha256=$3 node_dir=$4 lock_wait=$5
snapshot="$root/$sha"
entry="$snapshot/packages/cli/bin/farmslot.mjs"
lock="$root/.lock"
partial=""
mkdir -p "$root"
# A holder that is gone, or one that never wrote its pid a minute on, is stale.
stale() {
  if [ -n "$1" ]; then
    ! kill -0 "$1" 2> /dev/null
  else
    [ -n "$(find "$lock" -maxdepth 0 -mmin +1 2> /dev/null)" ]
  fi
}
held=false
reaping=false
trap '[ "$reaping" != true ] || rmdir "$lock.reap" 2> /dev/null' EXIT
for _ in $(seq 1 "$lock_wait"); do
  if mkdir "$lock" 2> /dev/null; then
    held=true
    break
  fi
  holder=$(cat "$lock/pid" 2> /dev/null || true)
  if stale "$holder"; then
    # Reap under a second mutex, and only if the lock still belongs to the
    # holder seen above: two waiters that saw the same dead holder must not
    # both remove it, or the second removes the lock the first just took.
    if mkdir "$lock.reap" 2> /dev/null; then
      reaping=true
      if [ "$(cat "$lock/pid" 2> /dev/null || true)" = "$holder" ] && stale "$holder"; then
        echo "  removing stale lock $lock${holder:+ (pid $holder is gone)}"
        rm -rf "$lock"
      fi
      rmdir "$lock.reap"
      reaping=false
      continue
    fi
    # A reaper killed mid-reap leaves its mutex behind; it is stale a minute on.
    if [ -n "$(find "$lock.reap" -maxdepth 0 -mmin +1 2> /dev/null)" ]; then
      rmdir "$lock.reap" 2> /dev/null || true
      continue
    fi
  fi
  sleep 1
done
if [ "$held" != true ]; then
  echo "[deploy] ERROR: another deploy has held $lock for $lock_wait s (pid $(cat "$lock/pid" 2> /dev/null || echo unknown))" >&2
  echo "  fix: wait for it to finish, or remove $lock if no deploy is running, then redeploy" >&2
  exit 1
fi
trap 'rm -rf "$lock" ${partial:+"$partial"}' EXIT
echo "$$" > "$lock/pid"
# Snapshots are built only under the lock, so a partial directory now is left
# by a deploy that was killed.
for stale in "$root"/*.partial.*; do
  [ -e "$stale" ] || continue
  rm -rf "$stale"
  echo "  removed stale $stale"
done

if [ ! -f "$snapshot/DEPLOYED-REVISION.json" ]; then
  if [ -z "$sha256" ]; then
    echo "[deploy] ERROR: $snapshot disappeared after this deploy found it installed" >&2
    echo "  fix: redeploy" >&2
    exit 1
  fi
  log="$snapshot.yarn-install.log"
  partial=$(mktemp -d "$snapshot.partial.XXXXXX")
  tar -xf - -C "$partial"
  if [ ! -f "$partial/yarn.lock" ]; then
    echo "[deploy] ERROR: the archive of $sha has no yarn.lock; refusing an unpinned CLI install" >&2
    echo "  fix: commit yarn.lock at the repository root, then redeploy" >&2
    exit 1
  fi
  # The repo pins its Yarn in package.json (packageManager) and gets it through
  # corepack, as install.sh and CI do. A bare `yarn` first on the node's PATH can
  # be a global Yarn 1, which has no `workspaces focus`, so prefer corepack and
  # refuse any Yarn older than 2.
  export PATH="$node_dir:$PATH" COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  yarn_run=yarn
  if command -v corepack > /dev/null 2>&1; then yarn_run="corepack yarn"; fi
  yarn_version=$(cd "$partial" && $yarn_run --version 2> /dev/null | tail -1 || true)
  yarn_major=${yarn_version%%.*}
  if ! [[ "$yarn_major" =~ ^[0-9]+$ ]] || [ "$yarn_major" -lt 2 ]; then
    echo "[deploy] ERROR: the node CLI install needs the repo's pinned Yarn, but '$yarn_run --version' with $node_dir first on PATH gives '${yarn_version:-nothing}'" >&2
    echo "  fix: run 'corepack enable' with the node the service uses ($node_dir/node), then redeploy" >&2
    exit 1
  fi
  # Yarn 4 `workspaces focus` ignores immutable mode, so compare the lockfile it
  # leaves with the committed one.
  cp "$partial/yarn.lock" "$partial/.yarn.lock.deployed"
  if ! (cd "$partial" && YARN_ENABLE_IMMUTABLE_INSTALLS=1 $yarn_run workspaces focus @farmslot/cli) > "$log" 2>&1; then
    tail -20 "$log" >&2
    echo "[deploy] ERROR: $yarn_run workspaces focus @farmslot/cli failed for the node CLI; full log: $log" >&2
    echo "  fix: resolve the error in that log, then redeploy" >&2
    exit 1
  fi
  if ! cmp -s "$partial/yarn.lock" "$partial/.yarn.lock.deployed"; then
    echo "[deploy] ERROR: installing the node CLI changed yarn.lock, so $sha's lockfile is out of date; full log: $log" >&2
    echo "  fix: commit the yarn.lock that yarn install produces, then redeploy" >&2
    exit 1
  fi
  # The CLI runs from source, but task tooling retained from this snapshot is
  # loaded by plain node (QA finalize, farmslot-agent) through package exports
  # that name dist/. The recipe-cli build builds the packages it depends on.
  if ! (cd "$partial" && $yarn_run workspace @farmslot/recipe-cli build) >> "$log" 2>&1; then
    tail -20 "$log" >&2
    echo "[deploy] ERROR: building the node CLI's packages failed; full log: $log" >&2
    echo "  fix: resolve the error in that log, then redeploy" >&2
    exit 1
  fi
  rm -f "$log" "$partial/.yarn.lock.deployed"
  printf '{\n  "sha": "%s",\n  "sha256": "%s"\n}\n' "$sha" "$sha256" > "$partial/DEPLOYED-REVISION.json"
  # Without the marker, a directory here is an install that never finished.
  rm -rf "$snapshot"
  mv "$partial" "$snapshot"
  partial=""
fi

keep=" $sha "
moved=false
for link in "$HOME/.local/bin/farmslot" "$HOME/.npm-global/bin/farmslot"; do
  previous=""
  if [[ -L "$link" ]]; then
    previous=$(readlink "$link")
    [[ "$previous" == "$entry" ]] && continue
    if [[ "$previous" == "$root"/* ]]; then
      kept=${previous#"$root"/}
      keep="$keep${kept%%/*} "
    fi
  elif [[ -e "$link" ]]; then
    echo "[deploy] ERROR: $link is not a symlink; move it aside so workers run the deployed CLI" >&2
    exit 1
  elif [[ "$link" != "$HOME/.local/bin/farmslot" ]]; then
    continue
  fi
  mkdir -p "$(dirname "$link")"
  ln -s "$entry" "$link.tmp.$$"
  mv -f "$link.tmp.$$" "$link"
  moved=true
  echo "  → $link${previous:+ (was $previous)}"
done
[[ "$moved" == true ]] || exit 0
for dir in "$root"/*/; do
  name=$(basename "$dir")
  [[ "$name" =~ ^[0-9a-f]{40,64}$ ]] || continue
  [[ "$keep" == *" $name "* ]] && continue
  rm -rf "${root:?}/$name"
  echo "  pruned $root/$name"
done
REFRESH
)
  if ! run "bash -c $(printf '%q ' "$CLI_REFRESH" _ "$CLI_ROOT" "$CLI_SHA" "$CLI_ARCHIVE_SHA256" "$NODE_DIR" "${CLI_LOCK_WAIT_SECONDS:-600}")" < "$CLI_ARCHIVE"; then
    echo "[deploy] ERROR: could not refresh the node CLI on $MACHINE; see the fix above" >&2
    exit 1
  fi

  # Verify the way a tmux slot worker runs: `exec bash -lc '<worker prefix> &&
  # export GW_URL=… && …'` in a throwaway session on the node user's tmux server,
  # falling back to plain `bash -lc` when no server is running. The CLI body uses
  # CLI_VERIFY_TIMEOUT_SECONDS; each tmux client is bounded to at most five seconds. The worker prefix and the tmux lookup are the gateway's own
  # (scripts/lib/worker-env-prefix.sh, scripts/lib/tmux-bin.sh); the prefix puts
  # ~/.local/bin, where the links above live, first on PATH. GW_URL is the URL
  # this node dials, and no control-plane credential is set, so the CLI
  # authenticates with the stored profile for that URL exactly as a tmux worker
  # does. Honor the selected pool's explicit FARMSLOT_HOME, as worker launches
  # already do. Without an override, retain the login-shell home; native workers
  # retain their node's home.
  echo "[deploy] verifying node CLI from a worker shell..."
  WORKER_ENV_PREFIX=$(< "$SCRIPT_DIR/lib/worker-env-prefix.sh")
  TMUX_BIN_LOOKUP=$(< "$SCRIPT_DIR/lib/tmux-bin.sh")
  WORKER_FARMSLOT_HOME=$(node --input-type=module - "$REPO_ROOT" "$MACHINE" << 'WORKER_HOME'
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [root, machine] = process.argv.slice(2);
const poolDir = path.join(root, 'pool');
if (existsSync(poolDir)) {
  const { readPoolFiles } = await import(pathToFileURL(path.join(root, 'packages/protocol/dist/node/slot-by-repo.js')));
  const pool = readPoolFiles(poolDir).find(({ pool }) => pool.machine === machine)?.pool;
  const home = pool?.env?.FARMSLOT_HOME;
  if (home !== undefined && (typeof home !== 'string' || !home.trim()))
    throw new Error('pool.env.FARMSLOT_HOME must be a nonempty string');
  process.stdout.write(home ?? '');
}
WORKER_HOME
  )
  WORKER_CLI_HEALTH_FILE=""
  if [[ "$INSTANCE" == dev ]]; then
    WORKER_CLI_HEALTH_FILE="$REMOTE_HOME/.farmslot-dev/node-worker-cli-health.json"
  fi
  if ! run "bash -s $(printf '%q ' "$CLI_ENTRY" "$NODE_GATEWAY_URL" "$WORKER_ENV_PREFIX" "$TMUX_BIN_LOOKUP" "${CLI_VERIFY_TIMEOUT_SECONDS:-120}" "$INSTANCE" "$WORKER_FARMSLOT_HOME" "$NODE_PATH" "$MACHINE" "$WORKER_CLI_HEALTH_FILE")" << 'VERIFY'
set -uo pipefail
entry=$1 gw_url=$2 prefix=$3 tmux_lookup=$4 timeout=$5 instance=$6 worker_home=$7
node=$8 machine=$9 health_file=${10}
failure_reason=""
tmux_with_timeout() {
  "$node" - "$TMUX_BIN" "$timeout" "$@" << 'TMUX_TIMEOUT'
const { spawnSync } = require('node:child_process');
const [command, budget, ...args] = process.argv.slice(2);
const result = spawnSync(command, args, {
  timeout: Math.min(5_000, Number(budget) * 1_000),
  killSignal: 'SIGKILL',
  stdio: 'inherit',
});
if (result.error?.code === 'ETIMEDOUT') process.exit(124);
if (result.error) process.stderr.write(result.error.message + '\n');
process.exit(result.status ?? 1);
TMUX_TIMEOUT
}
tmux_unresponsive() {
  failure_reason="tmux server unresponsive on $machine"
  echo "[deploy] ERROR: $failure_reason" >&2
}
write_health() {
  [ -n "$health_file" ] || return 0
  "$node" - "$health_file" "$1" "$failure_reason" "$machine" << 'WORKER_HEALTH'
const fs = require('node:fs');
const path = require('node:path');
const [file, status, detail, machine] = process.argv.slice(2);
const ok = status === '0';
fs.mkdirSync(path.dirname(file), { recursive: true });
const temporary = file + '.' + process.pid + '.tmp';
fs.writeFileSync(temporary, JSON.stringify({
  ok,
  checkedAt: new Date().toISOString(),
  ...(ok ? {} : { reason: detail || 'Worker CLI verification failed on ' + machine }),
}) + '\n', { mode: 0o600 });
fs.renameSync(temporary, file);
WORKER_HEALTH
}
work=$(mktemp -d "${TMPDIR:-/tmp}/farmslot-cli-verify.XXXXXX")
session=""
fallback_pid=""
cleanup() {
  local failed=0 result=0
  if [ -n "$session" ]; then
    tmux_with_timeout kill-session -t "=$session" > /dev/null 2>&1 || result=$?
    if [ "$result" = 124 ]; then tmux_unresponsive; failed=1; fi
  fi
  # The fallback runs as its own process group: stop the probe's CLI too.
  if [ -n "$fallback_pid" ]; then
    kill -TERM -- "-$fallback_pid" 2> /dev/null || true
    wait "$fallback_pid" 2> /dev/null || true
  fi
  rm -rf "$work"
  return "$failed"
}
finish() {
  local result=$?
  trap - EXIT
  cleanup || result=1
  write_health "$result" || result=1
  exit "$result"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cat > "$work/probe.sh" << 'PROBE'
entry=$1 instance=$2
unset FARMSLOT_NODE_TOKEN FARMSLOT_GATEWAY_TOKEN FARMSLOT_GATEWAY_PASSWORD
cd "$HOME" || exit 1
resolved=$(command -v farmslot) || {
  echo "[deploy] ERROR: no farmslot on the worker PATH, though the worker prefix puts $HOME/.local/bin first" >&2
  echo "  fix: check that $HOME/.local/bin/farmslot links to $entry, then redeploy" >&2
  exit 1
}
if [ ! "$resolved" -ef "$entry" ]; then
  echo "[deploy] ERROR: farmslot on the worker PATH is $resolved, not the deployed $entry" >&2
  echo "  fix: remove $resolved from the worker PATH, or point it at $entry" >&2
  exit 1
fi
version=$(farmslot --version < /dev/null) || {
  echo "[deploy] ERROR: $entry --version failed" >&2
  echo "  fix: delete the snapshot directory and redeploy" >&2
  exit 1
}
echo "  farmslot $version"
echo "  farmslot profile home: ${FARMSLOT_HOME:-$HOME/.farmslot}"
# A stopped gateway is classified below, so this check does not wait out a reload.
if ! FARMSLOT_GATEWAY_RECONNECT_MS=0 farmslot rpc gateway.status < /dev/null > /dev/null; then
  # Nothing listening on the gateway's port (the instance's gateway is down) is
  # not a CLI fault: the checks above passed, so warn and let the deploy finish.
  # Node runs the CLI, so it is on this PATH; GW_URL always carries the port
  # (NODE_GATEWAY_URL); exit 2 means no TCP connection.
  node -e '
    const url = new URL(process.argv[1]);
    const socket = require("node:net").connect({ host: url.hostname, port: Number(url.port) });
    const unreachable = () => process.exit(2);
    socket.setTimeout(5000, unreachable);
    socket.on("error", unreachable);
    socket.on("connect", () => process.exit(0));
  ' "$GW_URL" < /dev/null
  connect_status=$?
  if [ "$connect_status" = 2 ]; then
    echo "[deploy] WARNING: $instance gateway unreachable at $GW_URL; CLI installed and verified; rerun the deploy to verify when it is up"
    exit 0
  fi
  echo "[deploy] ERROR: farmslot rpc gateway.status failed against $GW_URL" >&2
  echo "  fix: store a service gateway profile for that URL in ${FARMSLOT_HOME:-$HOME/.farmslot}/gateways.json:" >&2
  profile_home="${FARMSLOT_HOME:-$HOME/.farmslot}"
  printf '    FARMSLOT_HOME=%q farmslot gateway add <name> %q && FARMSLOT_HOME=%q farmslot login <name>\n' "$profile_home" "$GW_URL" "$profile_home" >&2
  exit 1
fi
echo "  farmslot rpc gateway.status ok ($GW_URL)"
PROBE
if [ -n "$worker_home" ]; then prefix="$prefix; export FARMSLOT_HOME=$(printf '%q' "$worker_home")"; fi
probe="$prefix && export GW_URL=$(printf '%q' "$gw_url") && bash $(printf '%q' "$work/probe.sh") $(printf '%q ' "$entry" "$instance")"
launch="exec bash -lc $(printf '%q' "$probe > $(printf '%q' "$work/out") 2>&1; echo \$? > $(printf '%q' "$work/status")")"
eval "$tmux_lookup"
list_status=1
if [ -n "$TMUX_BIN" ]; then
  list_status=0
  tmux_with_timeout list-sessions > /dev/null 2>&1 || list_status=$?
fi
if [ "$list_status" = 124 ]; then tmux_unresponsive; exit 1; fi
if [ "$list_status" = 0 ]; then
  session="farmslot-cli-verify-$$"
  launch_status=0
  tmux_with_timeout new-session -d -s "$session" "$launch" || launch_status=$?
  if [ "$launch_status" != 0 ]; then
    if [ "$launch_status" = 124 ]; then
      tmux_unresponsive
    else
      echo "[deploy] ERROR: could not start a verify session on the tmux server ($TMUX_BIN)" >&2
    fi
    exit 1
  fi
else
  echo "  (no tmux server running; probing in bash -lc)"
  set -m
  bash -c "$launch" &
  fallback_pid=$!
  set +m
fi
for _ in $(seq 1 "$((timeout * 2))"); do
  [ -s "$work/status" ] && break
  sleep 0.5
done
if [ ! -s "$work/status" ]; then
  cat "$work/out" >&2 2> /dev/null
  echo "[deploy] ERROR: the worker-shell verify did not finish within $timeout s" >&2
  exit 1
fi
status=$(cat "$work/status")
if [ "$status" = 0 ]; then cat "$work/out"; else cat "$work/out" >&2; fi
exit "$status"
VERIFY
  then
    echo "[deploy] ERROR: workers on $MACHINE cannot use the deployed farmslot CLI; see the fix above" >&2
    exit 1
  fi
fi
