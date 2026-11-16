#!/usr/bin/env bash
# Sourced by deploy-node.sh, never run on its own: it reads the deploy's MACHINE,
# INSTANCE, IS_LOCAL, REFRESH_CLI, REPO_ROOT, SCRIPT_DIR, REMOTE_HOME, NODE_PATH,
# NODE_DIR, NODE_GATEWAY_URL and resolved CLI_ROOT/CLI_BIN/CLI_USER_BINS/TARGET_HOME/FARM_LAYOUT.
# It runs node commands through the deploy's run().

# --- Refresh the farmslot CLI slot workers run on this machine ---
# Workers call the gateway through `farmslot` on their PATH, so a node deployed
# without its CLI keeps running worker-side fixes from whatever revision that
# CLI was last installed at. Install the deployed revision as an immutable
# snapshot, ~/.local/share/farmslot-cli/<sha>/, and point the user's farmslot
# links at it. Links into a git checkout are switched too; the checkout is never
# touched, and the previous target is printed and kept for rollback. Layout 2
# snapshots and links belong to the selected instance. On
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
  # deploy-paths.mts supplies code.cli/code.bin and the shared user bin directories.
  : "${CLI_ROOT:?missing resolved code.cli}" "${CLI_BIN:?missing resolved code.bin}"
  : "${TARGET_HOME:?missing resolved FARMSLOT_HOME}" "${FARM_LAYOUT:?missing target layout}"
  CLI_SNAPSHOT="$CLI_ROOT/$CLI_SHA"
  CLI_ENTRY="$CLI_SNAPSHOT/packages/cli/bin/farmslot.mjs"
  # The agent bin that belongs to the same snapshot. Derived once, here: the
  # refresh body and the worker probe both need it and run as separate
  # processes on the node, so each gets it as an argument rather than
  # repeating the suffix strip.
  CLI_AGENT_ENTRY="$CLI_SNAPSHOT/packages/agent-runtime/bin/farmslot-agent.mjs"
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
instance_home=$6 instance_bin=$7 layout=$8
shift 8
user_bins=("$@")
: "${user_bins[0]:?missing resolved user bin directories}"
snapshot="$root/$sha"
entry="$snapshot/packages/cli/bin/farmslot.mjs"
# The engine's own refusals tell a worker to run `farmslot-agent` (the escape
# hatch in checklist-target.cjs, the mark help), and the farmslot-farm recipe
# fixture tells it to run `farmslot-agent ac`. That bin was never linked here,
# so it kept resolving to whatever npm installed globally — on mini an
# agent-runtime 0.4.0 predating every worker-side fix in this revision, and a
# worker calling it directly re-opened terminal signals the wrapper refuses. It
# is linked from the same snapshot as the CLI, by the same rules.
# The agent bin that belongs beside a given CLI bin. Two callers below ask it:
# this snapshot, and whatever target a first layout-2 deploy preserves.
agent_bin_for() {
  printf '%s\n' "${1%/packages/cli/bin/farmslot.mjs}/packages/agent-runtime/bin/farmslot-agent.mjs"
}
agent_entry=$(agent_bin_for "$entry")
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
  # Each CLI call then loads JavaScript built once here instead of transforming its TypeScript
  # (packages/cli/bin/build-prebuilt.mjs); the launcher uses it only for this revision. A
  # revision from before the prebuilt CLI has no build script and runs from source.
  if [ -f "$partial/packages/cli/bin/build-prebuilt.mjs" ] &&
    ! (cd "$partial" && node packages/cli/bin/build-prebuilt.mjs "$sha") >> "$log" 2>&1; then
    tail -20 "$log" >&2
    echo "[deploy] ERROR: prebuilding the node CLI failed; full log: $log" >&2
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
link_entry() {
  local link="$1" target="$2" previous="" kept
  if [[ -L "$link" ]]; then
    previous=$(readlink "$link")
    [[ "$previous" == "$target" ]] && return 0
    if [[ "$previous" == "$root"/* ]]; then
      kept=${previous#"$root"/}
      keep="$keep${kept%%/*} "
    fi
  elif [[ -e "$link" ]]; then
    echo "[deploy] ERROR: $link is not a symlink; move it aside so workers run the deployed CLI" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$link")"
  ln -s "$target" "$link.tmp.$$"
  mv -f "$link.tmp.$$" "$link"
  moved=true
  echo "  → $link${previous:+ (was $previous)}"
}

export PATH="$node_dir:$PATH"

# Resolve a link through the node this deploy installs with, which is on the
# PATH above by construction. There is one resolver, used for links and
# prefixes alike, and a failure here is a real fault worth stopping for rather
# than something to guess around.
resolve_path() {
  node -e 'process.stdout.write(require("fs").realpathSync(process.argv[1]))' "$1" 2> /dev/null
}

# One install only. A global @farmslot package shadows the snapshot through the
# bins npm owns, so it goes before the links below are written: npm's uninstall
# removes those bins, and doing this afterwards would delete ours.
#
# A failure here does not exit. Each uninstall is permanent before the next is
# attempted, so exiting would leave a node whose global agent bin is already
# gone and whose snapshot link does not exist yet - no working farmslot-agent
# at all. The failure is remembered, the links are written, and the
# verification at the end fails the deploy naming the package.
if command -v npm > /dev/null 2>&1; then
  npm_root=$(npm root -g 2> /dev/null || true)
else
  # No npm to ask, and none to uninstall with. The conventional prefix is still
  # readable, so a global package that is there is still reported below rather
  # than passing in silence, and a node that simply has no npm still deploys.
  npm_root="$HOME/.npm-global/lib/node_modules"
  echo "  no npm on this PATH; checking $npm_root directly"
fi
uninstall_failed=""
if [ -n "$npm_root" ] && [ -d "$npm_root/@farmslot" ]; then
  for pkg in "$npm_root"/@farmslot/*; do
    [ -e "$pkg/package.json" ] || continue
    name="@farmslot/$(basename "$pkg")"
    if ! command -v npm > /dev/null 2>&1; then
      echo "[deploy] WARNING: global $name shadows $snapshot and there is no npm here to remove it" >&2
      uninstall_failed="$uninstall_failed $name"
      continue
    fi
    echo "  removing global $name (the snapshot is the only install)"
    if ! npm uninstall -g "$name" > /dev/null 2>&1; then
      echo "[deploy] WARNING: could not uninstall global $name; linking first, then failing" >&2
      uninstall_failed="$uninstall_failed $name"
    fi
  done
fi

shared="$HOME/.local/share/farmslot-cli"
shim="$shared/farmslot-shim"
agent_shim="$shared/farmslot-agent-shim"
if [[ "$layout" != 2 && ! -f "$shim" ]]; then
  # Unmigrated machines keep their original direct snapshot links byte for byte.
  for bin in "${user_bins[@]}"; do
    link="$bin/farmslot"
    agent_link="$bin/farmslot-agent"
    # Either bin already living here makes this a directory we own: one that
    # holds only farmslot-agent used to be skipped, leaving that bin stale.
    if [[ "$bin" != "${user_bins[0]}" && ! -L "$link" && ! -e "$link" &&
      ! -L "$agent_link" && ! -e "$agent_link" ]]; then continue; fi
    link_entry "$link" "$entry"
    link_entry "$agent_link" "$agent_entry"
  done
else
mkdir -p "$shared"
if [[ "$layout" == 2 ]]; then
  link_entry "$instance_bin/farmslot" "$entry"
  link_entry "$instance_bin/farmslot-agent" "$agent_entry"
else
  # Legacy deploys retain the same immutable snapshot target as before migration.
  link_entry "$shared/legacy" "$entry"
  link_entry "$shared/legacy-agent" "$agent_entry"
fi
# A first layout-2 deploy preserves any previously installed legacy snapshot.
for bin in "${user_bins[@]}"; do
  legacy_link="$bin/farmslot"
  [[ ! -e "$shared/legacy" && -L "$legacy_link" ]] || continue
  previous=$(readlink "$legacy_link")
  if [[ "$previous" != "$shim" ]]; then
    # Another instance can bootstrap the shared shim at the same time.
    if ! ln -s "$previous" "$shared/legacy"; then
      [[ -L "$shared/legacy" ]] || exit 1
    fi
    previous_agent=$(agent_bin_for "$previous")
    [[ "$previous_agent" != "$previous" && -e "$previous_agent" ]] || previous_agent="$agent_entry"
    if ! ln -s "$previous_agent" "$shared/legacy-agent"; then
      [[ -L "$shared/legacy-agent" ]] || exit 1
    fi
    break
  fi
done
# A node migrated before this change has the legacy CLI route but no agent one.
if [[ -e "$shared/legacy" && ! -e "$shared/legacy-agent" ]]; then
  link_entry "$shared/legacy-agent" "$agent_entry"
fi
# One generator for both shims: they differ only in the bin they dispatch to,
# and two copies of the home expansion is the duplication this repo refuses.
# printf rather than a heredoc: this body is already inside a heredoc inside a
# command substitution, and bash 3.2 parses that as code.
write_shim() {
  local path="$1" bin_name="$2" legacy_name="$3"
  {
    printf '%s\n' '#!/usr/bin/env bash'
    printf '%s\n' 'set -euo pipefail'
    printf '%s\n' 'farm_home="${FARMSLOT_HOME:-$HOME/.farmslot}"'
    # Double quotes, not single: tilde expansion happens in neither, and a
    # line with no single quotes in it survives being emitted by printf.
    printf '%s\n' 'if [[ "$farm_home" == "~" ]]; then farm_home="$HOME"; elif [[ "$farm_home" == "~/"* ]]; then farm_home="$HOME/${farm_home#"~/"}"; fi'
    printf '%s\n' 'if [[ -f "$farm_home/config/instance.json" ]]; then'
    printf '  exec "$farm_home/code/bin/%s" "$@"\n' "$bin_name"
    printf '%s\n' 'fi'
    printf 'exec "$HOME/.local/share/farmslot-cli/%s" "$@"\n' "$legacy_name"
  } > "$path.tmp.$$"
  chmod 755 "$path.tmp.$$"
  mv -f "$path.tmp.$$" "$path"
}
write_shim "$shim" farmslot legacy
write_shim "$agent_shim" farmslot-agent legacy-agent
for bin in "${user_bins[@]}"; do
  link="$bin/farmslot"
  agent_link="$bin/farmslot-agent"
  if [[ "$bin" != "${user_bins[0]}" && ! -L "$link" && ! -e "$link" &&
    ! -L "$agent_link" && ! -e "$agent_link" ]]; then continue; fi
  link_entry "$link" "$shim"
  link_entry "$agent_link" "$agent_shim"
done
fi

# Fail loudly rather than leave a worker on a stale engine: no global @farmslot
# package may remain, and both bins must resolve inside this install.
if [ -n "$uninstall_failed" ]; then
  echo "[deploy] ERROR: could not uninstall global$uninstall_failed; the links are in place, but a global package shadows $snapshot. Remove it by hand and redeploy." >&2
  exit 1
fi
# A remaining package, not a remaining directory: npm can remove the last
# scoped package and leave its empty @farmslot directory, which would fail the
# deploy of the node that had just been cleaned.
if [ -n "$npm_root" ]; then
  for pkg in "$npm_root"/@farmslot/*; do
    [ -e "$pkg/package.json" ] || continue
    echo "[deploy] ERROR: global @farmslot/$(basename "$pkg") is still installed at $npm_root/@farmslot; it shadows $snapshot" >&2
    exit 1
  done
fi
verify_bins=("${user_bins[@]}")
# The shims exec these, so verifying the shim file alone proves nothing: it
# always sits under $shared and passes while dispatching somewhere else.
[ -n "$instance_bin" ] && verify_bins+=("$instance_bin")
if [ -e "$shared/legacy" ] || [ -L "$shared/legacy" ]; then verify_bins+=("$shared"); fi
for bin in "${verify_bins[@]}"; do
  for name in farmslot farmslot-agent legacy legacy-agent; do
    link="$bin/$name"
    # -L as well as -e: -e is false for a dangling symlink, so a broken agent
    # link used to be skipped silently by the check meant to catch it.
    if [ ! -e "$link" ] && [ ! -L "$link" ]; then continue; fi
    if [ ! -e "$link" ]; then
      echo "[deploy] ERROR: $link is a broken link to $(readlink "$link" 2> /dev/null); workers would get no CLI" >&2
      exit 1
    fi
    resolved=$(resolve_path "$link" || true)
    if [ -z "$resolved" ]; then
      echo "[deploy] ERROR: could not resolve $link with $node_dir/node; the link may be a cycle, or this node's node is broken" >&2
      exit 1
    fi
    # The legacy pair deliberately preserves whatever the pre-migration link
    # pointed at, and install.sh points it at the operator's checkout, which is
    # outside this install by definition. Requiring it inside would refuse a
    # first layout-2 deploy on any node installed that way, and refuse it again
    # on every retry, since layout 2 never repoints an existing legacy link.
    # It must resolve to something real, which is checked above; where it
    # resolves is not this deploy's business.
    if [ "$name" = legacy ] || [ "$name" = legacy-agent ]; then continue; fi
    # Prefix tests rather than `case`: bash 3.2, which is what these nodes run,
    # parses this heredoc body as code inside the surrounding $( ), and a `;;`
    # there is a syntax error that stops the whole deploy script from loading.
    inside=false
    for prefix in "$root" "$shared" "$instance_home"; do
      [ -n "$prefix" ] || continue
      # Resolve the prefix too. The link resolves through /private/var on macOS,
      # where /var is a symlink, while these variables hold the /var form, so
      # comparing a resolved path against an unresolved prefix rejects a
      # perfectly good link.
      prefix_resolved=$(resolve_path "$prefix" || echo "$prefix")
      if [ "${resolved#"$prefix_resolved"/}" != "$resolved" ] ||
        [ "${resolved#"$prefix"/}" != "$resolved" ]; then
        inside=true
        break
      fi
    done
    if [ "$inside" != true ]; then
      echo "[deploy] ERROR: $link resolves to ${resolved:-unknown}, outside this install ($root)" >&2
      exit 1
    fi
  done
done
# Retention follows the links, and the preserved legacy pair is the one route
# link_entry never repoints: layout 2 creates it once and then leaves it alone,
# so its snapshot never enters `keep` the way a repointed link's does. A legacy
# route into this install is read here instead. Without it the fallback survives
# verification and dangles two deploys later, when the snapshot it names stops
# being either the current or the previous instance target and is pruned below.
if [[ -n "$shared" ]]; then
  for link in "$shared/legacy" "$shared/legacy-agent"; do
    [[ -L "$link" ]] || continue
    legacy_target=$(readlink "$link")
    [[ "$legacy_target" == "$root"/* ]] || continue
    legacy_kept=${legacy_target#"$root"/}
    keep="$keep${legacy_kept%%/*} "
  done
fi
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
  if ! run "bash -c $(printf '%q ' "$CLI_REFRESH" _ "$CLI_ROOT" "$CLI_SHA" "$CLI_ARCHIVE_SHA256" "$NODE_DIR" "${CLI_LOCK_WAIT_SECONDS:-600}" "$TARGET_HOME" "$CLI_BIN" "$FARM_LAYOUT" "${CLI_USER_BINS[@]}")" < "$CLI_ARCHIVE"; then
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
const poolDir = process.env.FARMSLOT_POOL_DIR;
if (!poolDir) throw new Error('missing resolved FARMSLOT_POOL_DIR');
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
  if [[ "$FARM_LAYOUT" == 2 ]]; then WORKER_FARMSLOT_HOME="$TARGET_HOME"; fi
  WORKER_CLI_HEALTH_FILE=""
  if [[ "$INSTANCE" == dev ]]; then
    WORKER_CLI_HEALTH_FILE="$TARGET_HOME/node-worker-cli-health.json"
  fi
  if ! run "bash -s $(printf '%q ' "$CLI_ENTRY" "$NODE_GATEWAY_URL" "$WORKER_ENV_PREFIX" "$TMUX_BIN_LOOKUP" "${CLI_VERIFY_TIMEOUT_SECONDS:-120}" "$INSTANCE" "$WORKER_FARMSLOT_HOME" "$NODE_PATH" "$MACHINE" "$WORKER_CLI_HEALTH_FILE" "$CLI_AGENT_ENTRY")" << 'VERIFY'
set -uo pipefail
entry=$1 gw_url=$2 prefix=$3 tmux_lookup=$4 timeout=$5 instance=$6 worker_home=$7
node=$8 machine=$9 health_file=${10} agent_entry=${11}
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
entry=$1 instance=$2 agent_entry=$3
unset FARMSLOT_NODE_TOKEN FARMSLOT_GATEWAY_TOKEN FARMSLOT_GATEWAY_PASSWORD
cd "$HOME" || exit 1
resolved=$(command -v farmslot) || {
  echo "[deploy] ERROR: no farmslot on the worker PATH, though the worker prefix puts $HOME/.local/bin first" >&2
  echo "  fix: check that $HOME/.local/bin/farmslot links to $entry, then redeploy" >&2
  exit 1
}
effective="$resolved"
profile_home="${FARMSLOT_HOME:-$HOME/.farmslot}"
if [ "$resolved" -ef "$HOME/.local/share/farmslot-cli/farmslot-shim" ]; then
  if [ -f "$profile_home/config/instance.json" ]; then
    effective="$profile_home/code/bin/farmslot"
  else
    effective="$HOME/.local/share/farmslot-cli/legacy"
  fi
fi
if [ ! "$effective" -ef "$entry" ]; then
  echo "[deploy] ERROR: farmslot on the worker PATH is $resolved, not the deployed $entry" >&2
  echo "  fix: remove $resolved from the worker PATH, or point it at $entry" >&2
  exit 1
fi
agent_resolved=$(command -v farmslot-agent) || {
  echo "[deploy] ERROR: no farmslot-agent on the worker PATH, though the worker prefix puts $HOME/.local/bin first" >&2
  echo "  fix: check that $HOME/.local/bin/farmslot-agent links into the deployed snapshot, then redeploy" >&2
  exit 1
}
agent_effective="$agent_resolved"
if [ "$agent_resolved" -ef "$HOME/.local/share/farmslot-cli/farmslot-agent-shim" ]; then
  if [ -f "$profile_home/config/instance.json" ]; then
    agent_effective="$profile_home/code/bin/farmslot-agent"
  else
    agent_effective="$HOME/.local/share/farmslot-cli/legacy-agent"
  fi
fi
if [ ! "$agent_effective" -ef "$agent_entry" ]; then
  echo "[deploy] ERROR: farmslot-agent on the worker PATH is $agent_resolved, not the deployed $agent_entry" >&2
  echo "  fix: remove $agent_resolved from the worker PATH, or point it at $agent_entry" >&2
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
probe="$prefix && export GW_URL=$(printf '%q' "$gw_url") && bash $(printf '%q' "$work/probe.sh") $(printf '%q ' "$entry" "$instance" "$agent_entry")"
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
