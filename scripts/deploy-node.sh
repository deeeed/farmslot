#!/usr/bin/env bash
# deploy-node.sh — Deploy/update farmslot node to any fleet machine
# Usage: bash scripts/deploy-node.sh <machine> [gateway-ip] [--instance dev|prod] [--node-token-file path] [--refresh-cli]
#
# Supports:
#   macOS local  (runner-local) — launchd LaunchAgent
#   macOS remote (mini)    — launchd LaunchAgent
#   Linux remote (runner-a, runner-b) — systemd user service
#
# Same command for install and update. Rsyncs code and restarts the service,
# then installs the same git revision as the machine's `farmslot` CLI (the one
# slot workers run) and verifies it reaches the gateway from a worker shell.
# When nothing listens on the instance's gateway port, the gateway check only
# warns: the CLI checks still fail the deploy.
# A local deploy leaves the CLI as is unless --refresh-cli is passed: there it
# is the operator's own CLI. CLI_LOCK_WAIT_SECONDS (default 600) bounds the wait
# for another deploy's CLI refresh on the same machine, and
# CLI_VERIFY_TIMEOUT_SECONDS (default 120) the worker-shell verify.
#
# Instances: a machine can run a prod node and a dev node side by side —
# distinct install dir, service name, gateway URL, and IPC state. Default
# instance is "prod" (identical to the original single-instance behavior).
# Select the other with --instance dev or FARMSLOT_NODE_INSTANCE=dev.
# Set CAPTURE_HELPER_PATH to select an existing helper executable on the target.
# An existing launchd capture-helper override is retained when this is unset.
# Set FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID to opt this node into native sessions
# for that gateway principal. Runner installation and login remain node-owned.
#
# One-time prerequisites:
#   macOS: node installed + Screen Recording permission for `node` binary
#   Linux: node installed + loginctl enable-linger (for user services without login)

set -euo pipefail

INSTANCE="${FARMSLOT_NODE_INSTANCE:-prod}"
NODE_TOKEN_FILE=""
NODE_TOKEN_FROM_FILE=false
REFRESH_CLI=false
ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --instance)
      INSTANCE="${2:?--instance requires a value (dev|prod)}"
      shift 2
      ;;
    --instance=*)
      INSTANCE="${1#--instance=}"
      shift
      ;;
    --refresh-cli)
      REFRESH_CLI=true
      shift
      ;;
    --node-token-file)
      NODE_TOKEN_FILE="${2:?--node-token-file requires a path}"
      shift 2
      ;;
    --node-token-file=*)
      NODE_TOKEN_FILE="${1#*=}"
      if [[ -z "$NODE_TOKEN_FILE" ]]; then
        echo "[deploy] ERROR: --node-token-file requires a path" >&2
        exit 1
      fi
      shift
      ;;
    *)
      ARGS+=("$1")
      shift
      ;;
  esac
done
set -- "${ARGS[@]}"

MACHINE="${1:?Usage: deploy-node.sh <machine> [gateway-ip] [--instance dev|prod] [--node-token-file path] [--refresh-cli]}"
GATEWAY_IP="${2:-}"

# --- Per-instance configuration (dev + prod coexist on the same machine) ---
# Single source of truth for everything that must not collide between a prod
# node and a dev node on the same box: install dir, service name, gateway
# port, and IPC socket. Prod is byte-identical to the pre-instance defaults.
case "$INSTANCE" in
  prod)
    INSTANCE_SUFFIX=""
    LAUNCHD_LABEL_SUFFIX=""
    DEFAULT_GATEWAY_PORT=7777
    ;;
  dev)
    INSTANCE_SUFFIX="-dev"
    LAUNCHD_LABEL_SUFFIX=".dev"
    DEFAULT_GATEWAY_PORT=7801
    ;;
  *)
    echo "[deploy] ERROR: --instance must be 'dev' or 'prod' (got '$INSTANCE')" >&2
    exit 1
    ;;
esac
GATEWAY_PORT="${GATEWAY_PORT:-$DEFAULT_GATEWAY_PORT}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
NODE_SRC="$REPO_ROOT/services/node"
PACKAGES_DIR="$REPO_ROOT/packages"
AUTH_ENV_FILE="$REPO_ROOT/.env.local-auth"

if [[ -f "$AUTH_ENV_FILE" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$AUTH_ENV_FILE"
  set +a
fi

if [[ -n "$NODE_TOKEN_FILE" ]]; then
  if [[ ! -r "$NODE_TOKEN_FILE" ]]; then
    echo "[deploy] ERROR: node token file is not readable: $NODE_TOKEN_FILE" >&2
    exit 1
  fi
  if [[ "$(awk 'END { print NR }' "$NODE_TOKEN_FILE")" -gt 1 ]]; then
    echo "[deploy] ERROR: node token file must contain exactly one line: $NODE_TOKEN_FILE" >&2
    exit 1
  fi
  FARMSLOT_NODE_TOKEN="$(tr -d '\r\n' < "$NODE_TOKEN_FILE")"
  if [[ -z "$FARMSLOT_NODE_TOKEN" ]]; then
    echo "[deploy] ERROR: node token file is empty: $NODE_TOKEN_FILE" >&2
    exit 1
  fi
  if [[ "$FARMSLOT_NODE_TOKEN" =~ [[:space:]] ]]; then
    echo "[deploy] ERROR: node token file contains whitespace: $NODE_TOKEN_FILE" >&2
    exit 1
  fi
  NODE_TOKEN_FROM_FILE=true
fi

# --- Resolve @farmslot/* workspace packages the node depends on (transitive) ---
# services/node's declared deps today are @farmslot/protocol + @farmslot/capabilities,
# but a hardcoded bundling list bit us before: a new @farmslot workspace package
# (capabilities) went unbundled and the deployed node crashed with
# ERR_MODULE_NOT_FOUND on startup. Walk the workspace graph from services/node's
# package.json instead, so any future @farmslot/* dependency — direct or
# transitive — is picked up automatically.
resolve_farmslot_deps() {
  local resolver
  resolver="$(mktemp "${TMPDIR:-/tmp}/deploy-node-resolve-XXXXXX.mjs")"
  trap 'rm -f "$resolver"' RETURN
  cat > "$resolver" <<'RESOLVER'
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const [, , repoRoot] = process.argv;
const packagesDir = path.join(repoRoot, 'packages');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

const dirByName = new Map();
for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  try {
    const pkg = readJson(path.join(packagesDir, entry.name, 'package.json'));
    dirByName.set(pkg.name, entry.name);
  } catch {
    // not a package directory
  }
}

const nodePkg = readJson(path.join(repoRoot, 'services/node/package.json'));
const queue = Object.keys(nodePkg.dependencies ?? {}).filter((name) =>
  name.startsWith('@farmslot/'),
);
const seen = new Set();
while (queue.length > 0) {
  const name = queue.shift();
  if (seen.has(name)) continue;
  const dir = dirByName.get(name);
  if (!dir) throw new Error(`deploy-node: unresolved workspace package ${name}`);
  seen.add(name);
  const pkg = readJson(path.join(packagesDir, dir, 'package.json'));
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    if (dep.startsWith('@farmslot/') && !seen.has(dep)) queue.push(dep);
  }
}

// A package "ships from dist/" if it declares a build script AND its main/exports
// point into dist/ (e.g. protocol). Source-only packages (e.g. capabilities, whose
// main/exports point straight at src/*.ts) never need a build. dist/ is gitignored
// and can be missing (fresh checkout) or STALE (edited source, no rebuild) even
// though the workspace resolves fine locally via tsx path aliasing — both ship
// broken, so every dist-shipping package builds on every deploy.
for (const name of seen) {
  const dir = dirByName.get(name);
  const pkg = readJson(path.join(packagesDir, dir, 'package.json'));
  const hasBuildScript = Boolean(pkg.scripts?.build);
  const mainIsDist = typeof pkg.main === 'string' && pkg.main.startsWith('dist/');
  const exportsIsDist = pkg.exports ? JSON.stringify(pkg.exports).includes('"dist/') : false;
  // Always rebuild dist-shipping packages: an EXISTING dist can be stale
  // (built before a source edit — e.g. a protocol version bump), and shipping
  // it produces exactly the node/gateway version mismatch this script exists
  // to prevent. Builds are incremental, so the always-build cost is seconds.
  const needsBuild = hasBuildScript && (mainIsDist || exportsIsDist);
  process.stdout.write(`${name}\t${dir}\t${needsBuild ? '1' : '0'}\n`);
}
RESOLVER
  node "$resolver" "$REPO_ROOT"
}

FARMSLOT_DEPS="$(resolve_farmslot_deps)"
echo "[deploy] workspace packages to bundle: $(echo "$FARMSLOT_DEPS" | cut -f1 | tr '\n' ' ')"

# --- Build every @farmslot/* dep that ships from dist/ ---
# A missing dist/ crashes the node at startup (ERR_MODULE_NOT_FOUND); a STALE
# dist/ is worse — it deploys cleanly and then mismatches the gateway at
# runtime (e.g. a protocol version bump built nowhere). Builds are incremental,
# so always building is cheap; fail loudly if one cannot build.
while IFS=$'\t' read -r pkg_name pkg_dir needs_build; do
  [[ -z "$pkg_name" || "$needs_build" != "1" ]] && continue
  echo "[deploy] building $pkg_name (ships from dist/)..."
  if ! (cd "$REPO_ROOT" && yarn workspace "$pkg_name" build < /dev/null); then
    echo "[deploy] ERROR: failed to build $pkg_name — refusing to deploy a missing or stale dist" >&2
    exit 1
  fi
  if [[ ! -d "$PACKAGES_DIR/$pkg_dir/dist" ]]; then
    echo "[deploy] ERROR: $pkg_name build reported success but dist/ is still missing — refusing to deploy" >&2
    exit 1
  fi
done <<< "$FARMSLOT_DEPS"

# --- Detect local vs remote ---
LOCAL_HOSTNAME=$(hostname -s)
IS_LOCAL=false
if [[ "$MACHINE" == "$LOCAL_HOSTNAME" ]]; then
  IS_LOCAL=true
  run() { eval "$@"; }
  RSYNC_PREFIX=""
else
  # ConnectTimeout: without it macOS ssh can fail outright on a host name whose
  # first address is a link-local IPv6 one instead of trying the next (F56).
  run() { ssh -o ConnectTimeout=10 "$MACHINE.local" "$@"; }
  RSYNC_PREFIX="$MACHINE.local:"
  export RSYNC_RSH="ssh -o ConnectTimeout=10"
fi

if [[ "$IS_LOCAL" != true && "$NODE_TOKEN_FROM_FILE" != true ]]; then
  echo "[deploy] ERROR: remote deployment requires --node-token-file with a credential bound to $MACHINE" >&2
  exit 1
fi

# --- Detect OS ---
REMOTE_OS=$(run uname -s)

# --- Resolve paths ---
REMOTE_HOME=$(run 'echo $HOME')
REMOTE_DIR="$REMOTE_HOME/farmslot-node${INSTANCE_SUFFIX}"
REMOTE_UID=$(run 'id -u')

# MACHINE_NAME must stay the bare physical machine name, NOT suffixed by
# instance: the gateway's "local node" detection matches it against its own
# os.hostname(), and pool slot ownership keys off that same real machine
# name. Dev and prod nodes talk to separate gateways (different
# GATEWAY_PORT), so identical machine names across instances don't collide —
# each is still "local" to its own gateway. (A "-dev" suffix here previously
# made the dev node register as a remote node to its gateway and left its
# pool slots unmanaged — confirmed live.)
NODE_MACHINE_NAME="${MACHINE}"

# The IPC socket the node's screen-control server binds defaults (in
# services/node/src) to a path keyed only by uid, so two instances on the
# same box would collide on the same socket file without this.
SCREEN_CONTROL_SOCKET_PATH="/tmp/farmslot-screen-control-${REMOTE_UID}${INSTANCE_SUFFIX}.sock"

if [[ -z "$GATEWAY_IP" ]]; then
  if [[ "$IS_LOCAL" == true ]]; then
    GATEWAY_IP="127.0.0.1"
  else
    # Use the gateway machine's mDNS hostname (e.g. runner.local) so the
    # baked URL survives DHCP lease changes. Override with GATEWAY_IP=<addr>.
    LOCAL_HOST=$(scutil --get LocalHostName 2>/dev/null || echo "")
    if [[ -n "$LOCAL_HOST" ]]; then
      GATEWAY_IP="${LOCAL_HOST}.local"
    else
      GATEWAY_IP=$(ipconfig getifaddr en0 2>/dev/null || echo "192.168.50.11")
    fi
  fi
fi
# The URL the node dials, and so the GW_URL its workers get from the gateway.
NODE_GATEWAY_URL="ws://${GATEWAY_IP}:${GATEWAY_PORT}"
echo "[deploy] target=$MACHINE instance=$INSTANCE os=$REMOTE_OS gateway=$NODE_GATEWAY_URL dir=$REMOTE_DIR"

NODE_DETECT='
source ~/.zshrc 2>/dev/null || true
source ~/.bashrc 2>/dev/null || true
if command -v asdf >/dev/null 2>&1; then
  candidate=$(asdf which node 2>/dev/null || true)
  if [[ -n "$candidate" && -x "$candidate" ]]; then echo "$candidate"; exit 0; fi
fi
candidate=$(command -v node 2>/dev/null || true)
if [[ -n "$candidate" && -x "$candidate" ]]; then echo "$candidate"; exit 0; fi
candidate=$(awk '"'"'/<key>ProgramArguments/{in_args=1; next} in_args && /<string>.*node<\/string>/{gsub(/^[[:space:]]*<string>|<\/string>[[:space:]]*$/, "", $0); print; exit}'"'"' "$HOME/Library/LaunchAgents/com.farmslot.node.plist" 2>/dev/null || true)
if [[ -n "$candidate" && -x "$candidate" ]]; then echo "$candidate"; exit 0; fi
candidate=$(find "$HOME/.asdf/installs/nodejs" -path "*/bin/node" -type f 2>/dev/null | awk -F/ '"'"'
function version_key(path,   version,n,i,parts,key) {
  version = $(NF - 2)
  n = split(version, parts, /[^0-9]+/)
  key = ""
  for (i = 1; i <= n; i += 1) {
    if (parts[i] != "") key = key sprintf("%09d.", parts[i])
  }
  return key "\t" path
}
{ print version_key($0) }
'"'"' | sort | tail -1 | cut -f2-)
if [[ -n "$candidate" && -x "$candidate" ]]; then echo "$candidate"; exit 0; fi
exit 1
'
if [[ -n "${FARMSLOT_NODE_PATH:-}" ]]; then
  NODE_PATH="$FARMSLOT_NODE_PATH"
elif [[ "$IS_LOCAL" == true ]]; then
  NODE_PATH=$(zsh -c "$NODE_DETECT")
else
  NODE_PATH=$(run "$NODE_DETECT")
fi
if ! run "test -x '$NODE_PATH'"; then
  echo "[deploy] ERROR: node path is not executable on $MACHINE: $NODE_PATH" >&2
  exit 1
fi
NODE_DIR=$(dirname "$NODE_PATH")
echo "[deploy] node: $NODE_PATH"

# FARMSLOT_ROOT adds an env-file search root to the node's credential lookup.
# The service runs with it unset whatever launchd/systemd (or, natively, the
# login shell) would hand down, and so does the token check below, which shares
# this invocation. Unset rather than set: the node's children inherit its env,
# and a FARMSLOT_ROOT there would repoint slot scripts and the CLI at the install dir.
NODE_TSX_ARGS=(/usr/bin/env -u FARMSLOT_ROOT "$NODE_PATH" --require "$REMOTE_DIR/node_modules/tsx/dist/preflight.cjs" --import "file://$REMOTE_DIR/node_modules/tsx/dist/loader.mjs")
NODE_SERVICE_ARGS=("${NODE_TSX_ARGS[@]}" "$REMOTE_DIR/src/index.ts")
NODE_TOKEN_CHECK_ARGS=("${NODE_TSX_ARGS[@]}" "$REMOTE_DIR/src/check-node-token.ts")
NODE_SERVICE_PATH="$NODE_DIR:/usr/local/bin:/usr/bin:/bin"
if [[ "$REMOTE_OS" == "Darwin" ]]; then
  NODE_SERVICE_PATH="$REMOTE_DIR/node_modules/.bin:$NODE_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/usr/sbin:/bin"
fi
if [[ -n "${FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID:-}" ]]; then
  # Native CLI configuration can depend on exports in the user's login shell.
  # Load those on the execution machine, without exporting credentials to the gateway.
  NATIVE_SHELL=$(run 'printf "%s" "${SHELL:-/bin/sh}"')
  if [[ "$NATIVE_SHELL" != /* ]]; then
    echo "[deploy] ERROR: native execution requires an absolute user shell path" >&2
    exit 1
  fi
  native_exec() { python3 -c 'import shlex,sys; print("exec " + shlex.join(sys.argv[1:]))' "$@"; }
  NODE_SERVICE_ARGS=("$NATIVE_SHELL" -lc "$(native_exec "${NODE_SERVICE_ARGS[@]}")")
  NODE_TOKEN_CHECK_ARGS=("$NATIVE_SHELL" -lc "$(native_exec "${NODE_TOKEN_CHECK_ARGS[@]}")")
  NODE_SERVICE_PATH="$REMOTE_HOME/.local/bin:$REMOTE_HOME/.npm-global/bin:$NODE_SERVICE_PATH"
fi
NODE_SERVICE_PATH=$(python3 -c 'import sys; print(":".join(dict.fromkeys(sys.argv[1].split(":"))))' "$NODE_SERVICE_PATH")

# Escapes stdin as Python's html.escape(quote=True) does, without a process per
# value. The backslashes keep `&` literal under bash 5.2's patsub_replacement.
xml_escape() {
  local value
  IFS= read -r -d '' value || true
  value=${value//&/\&amp;}
  value=${value//</\&lt;}
  value=${value//>/\&gt;}
  value=${value//\"/\&quot;}
  value=${value//\'/\&#x27;}
  printf '%s\n' "$value"
}

launchd_node_arguments() {
  local argument
  for argument in "${NODE_SERVICE_ARGS[@]}"; do
    printf '        <string>%s</string>\n' "$(printf '%s' "$argument" | xml_escape)"
  done
}

systemd_node_arguments() {
  python3 -c 'import sys; print(" ".join("\"" + arg.replace("\\", "\\\\").replace("\"", "\\\"").replace("%", "%%").replace("$", "$$") + "\"" for arg in sys.argv[1:]))' "${NODE_SERVICE_ARGS[@]}"
}

# The token the service definition carries as FARMSLOT_NODE_TOKEN, and that the
# shadowed-token check compares against.
DEPLOYED_NODE_TOKEN="${FARMSLOT_NODE_TOKEN:-${FARMSLOT_GATEWAY_TOKEN:-}}"

launchd_auth_env_xml() {
  if [[ -n "$DEPLOYED_NODE_TOKEN" ]]; then
    printf '        <key>FARMSLOT_NODE_TOKEN</key>
        <string>%s</string>
' "$(printf '%s' "$DEPLOYED_NODE_TOKEN" | xml_escape)"
  elif [[ -n "${FARMSLOT_GATEWAY_PASSWORD:-}" ]]; then
    printf '        <key>FARMSLOT_GATEWAY_PASSWORD</key>
        <string>%s</string>
' "$(printf '%s' "$FARMSLOT_GATEWAY_PASSWORD" | xml_escape)"
  fi
}

systemd_auth_env_lines() {
  if [[ -n "$DEPLOYED_NODE_TOKEN" ]]; then
    printf 'Environment="FARMSLOT_NODE_TOKEN=%s"
' "$(printf '%s' "$DEPLOYED_NODE_TOKEN" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  elif [[ -n "${FARMSLOT_GATEWAY_PASSWORD:-}" ]]; then
    printf 'Environment="FARMSLOT_GATEWAY_PASSWORD=%s"
' "$(printf '%s' "$FARMSLOT_GATEWAY_PASSWORD" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  fi
}

# Native ownership is opt-in for either instance. The dev instance also gets
# a separate home and screen-control socket; prod retains its existing defaults.
launchd_instance_env_xml() {
  if [[ -n "${FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID:-}" ]]; then
    printf '        <key>FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID</key>
        <string>%s</string>
' "$(printf '%s' "$FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID" | xml_escape)"
  fi
  if [[ -n "$INSTANCE_SUFFIX" ]]; then
    printf '        <key>FARMSLOT_HOME</key>
        <string>%s</string>
        <key>SCREEN_CONTROL_SOCKET</key>
        <string>%s</string>
' "$(printf '%s' "$REMOTE_HOME/.farmslot${INSTANCE_SUFFIX}" | xml_escape)" "$(printf '%s' "$SCREEN_CONTROL_SOCKET_PATH" | xml_escape)"
  fi
}

systemd_instance_env_lines() {
  if [[ -n "${FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID:-}" ]]; then
    printf 'Environment="FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID=%s"
' "$(printf '%s' "$FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID" | sed 's/\\/\\\\/g; s/"/\\"/g; s/%/%%/g')"
  fi
  if [[ -n "$INSTANCE_SUFFIX" ]]; then
    printf 'Environment="FARMSLOT_HOME=%s"
Environment="SCREEN_CONTROL_SOCKET=%s"
' "$REMOTE_HOME/.farmslot${INSTANCE_SUFFIX}" "$SCREEN_CONTROL_SOCKET_PATH"
  fi
}

# --- Migrate: remove old farmslot-agent service and dir ---
OLD_DIR="$REMOTE_HOME/farmslot-agent"
if run "test -d $OLD_DIR 2>/dev/null"; then
  echo "[deploy] migrating: removing old farmslot-agent service..."
  if [[ "$REMOTE_OS" == "Darwin" ]]; then
    OLD_PLIST="Library/LaunchAgents/com.farmslot.agent.plist"
    run "launchctl unload ~/$OLD_PLIST 2>/dev/null || true"
    run "rm -f ~/$OLD_PLIST"
  elif [[ "$REMOTE_OS" == "Linux" ]]; then
    run "systemctl --user stop farmslot-agent 2>/dev/null || true"
    run "systemctl --user disable farmslot-agent 2>/dev/null || true"
    run "rm -f ~/.config/systemd/user/farmslot-agent.service"
    run "systemctl --user daemon-reload 2>/dev/null || true"
  fi
  run "rm -rf $OLD_DIR"
  echo "[deploy] migration complete."
fi

# --- rsync node source ---
echo "[deploy] syncing node source..."
run "mkdir -p $REMOTE_DIR/src"
rsync -a --delete "$NODE_SRC/src/" "${RSYNC_PREFIX}$REMOTE_DIR/src/"
rsync -a "$NODE_SRC/tsconfig.json" "${RSYNC_PREFIX}$REMOTE_DIR/tsconfig.json"

# Framework scripts used by preflight/setup hooks via {{farmslot_dir}}/scripts/
echo "[deploy] syncing framework scripts..."
run "mkdir -p $REMOTE_DIR/scripts"
rsync -a --exclude='deploy-node.sh' "$REPO_ROOT/scripts/" "${RSYNC_PREFIX}$REMOTE_DIR/scripts/"

# Pool configs needed by lib/slot-common.sh (load_slot_vars)
echo "[deploy] syncing pool configs..."
run "mkdir -p $REMOTE_DIR/pool"
rsync -a "$REPO_ROOT/pool/" "${RSYNC_PREFIX}$REMOTE_DIR/pool/"

# Project dirs referenced by hooks via {{farmslot_dir}}/projects/<name>/
# Syncs project.json plus hook helper dirs used through {{farmslot_dir}}.
echo "[deploy] syncing project configs and hook scripts..."
for proj_dir in "$REPO_ROOT"/projects/*/; do
  proj_name=$(basename "$proj_dir")
  # project.json
  [[ -f "$proj_dir/project.json" ]] && {
    run "mkdir -p $REMOTE_DIR/projects/$proj_name"
    rsync -a "$proj_dir/project.json" "${RSYNC_PREFIX}$REMOTE_DIR/projects/$proj_name/project.json"
  }
  # setup/ dir
  [[ -d "$proj_dir/setup" ]] && {
    run "mkdir -p $REMOTE_DIR/projects/$proj_name/setup"
    rsync -a "$proj_dir/setup/" "${RSYNC_PREFIX}$REMOTE_DIR/projects/$proj_name/setup/"
  }
  # scripts/ dir
  [[ -d "$proj_dir/scripts" ]] && {
    run "mkdir -p $REMOTE_DIR/projects/$proj_name/scripts"
    rsync -a "$proj_dir/scripts/" "${RSYNC_PREFIX}$REMOTE_DIR/projects/$proj_name/scripts/"
  }
  echo "  → $proj_name"
done

# --- Install deps (before protocol rsync — yarn wipes unmanaged packages) ---
# Bundled capture-helper floor: a deployed lockfile kept 0.2.1, which rejects the
# node's `+match <app>\t<window>` probe; 0.2.6 is the known-compatible release.
# Raising the range is what makes a repeated install upgrade an old lock.
echo "[deploy] writing standalone package.json..."
if [[ "$REMOTE_OS" == "Darwin" ]]; then
  run "cat > $REMOTE_DIR/package.json" << 'PKGJSON'
{
  "name": "@farmslot/node-standalone",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "ws": "^8.18.0",
    "tsx": "^4.19.0",
    "@siteed/capture-helper": "^0.2.6",
    "@noble/hashes": "1.4.0"
  }
}
PKGJSON
else
  run "cat > $REMOTE_DIR/package.json" << 'PKGJSON'
{
  "name": "@farmslot/node-standalone",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "ws": "^8.18.0",
    "tsx": "^4.19.0",
    "@noble/hashes": "1.4.0"
  }
}
PKGJSON
fi

echo "[deploy] installing dependencies..."
# Use yarn if available (with node-modules linker), otherwise npm
HAS_YARN=$(run "PATH=$NODE_DIR:\$PATH which yarn 2>/dev/null && echo yes || echo no")
if [[ "$HAS_YARN" == *"yes" ]]; then
  run "cd $REMOTE_DIR && echo 'nodeLinker: node-modules' > .yarnrc.yml && PATH=$NODE_DIR:\$PATH yarn install 2>&1 | tail -5"
else
  run "cd $REMOTE_DIR && PATH=$NODE_DIR:\$PATH npm install 2>&1 | tail -5"
fi
CAPTURE_HELPER_REMOTE="${CAPTURE_HELPER_PATH:-}"
if [[ "$REMOTE_OS" == "Darwin" && -z "$CAPTURE_HELPER_REMOTE" ]]; then
  existing_plist="$REMOTE_HOME/Library/LaunchAgents/com.farmslot.node${LAUNCHD_LABEL_SUFFIX}.plist"
  if run "test -f $(printf '%q' "$existing_plist")"; then
    if ! run "/usr/bin/plutil -lint $(printf '%q' "$existing_plist")" >/dev/null; then
      echo "[deploy] cannot read a valid service plist: $existing_plist" >&2
      exit 1
    fi
    # A valid existing plist may omit the optional helper override.
    if existing_helper=$(run "/usr/bin/plutil -extract EnvironmentVariables.CAPTURE_HELPER_PATH raw -o - $(printf '%q' "$existing_plist")" 2>/dev/null); then
      CAPTURE_HELPER_REMOTE="$existing_helper"
    fi
  fi
fi
CAPTURE_HELPER_REMOTE="${CAPTURE_HELPER_REMOTE:-$REMOTE_DIR/node_modules/@siteed/capture-helper/native/capture-helper}"
CAPTURE_HELPER_REMOTE_QUOTED=$(printf '%q' "$CAPTURE_HELPER_REMOTE")
if [[ "$REMOTE_OS" == "Darwin" ]]; then
  [[ "$CAPTURE_HELPER_REMOTE" == /* ]] || { echo '[deploy] capture-helper path must be absolute' >&2; exit 1; }
  run "test -x $CAPTURE_HELPER_REMOTE_QUOTED"
  if run "PATH=$NODE_DIR:\$PATH $NODE_PATH -e 'const { spawnSync } = require(\"node:child_process\"); const bin = process.argv[1]; const result = spawnSync(bin, [\"doctor\", \"--json\"], { encoding: \"utf8\", timeout: 15000, maxBuffer: 1024 * 1024 }); if (result.status !== 0) { process.stderr.write(result.stderr || result.stdout || (result.error && result.error.message) || \"capture-helper doctor failed\"); process.exit(1); }' $CAPTURE_HELPER_REMOTE_QUOTED"; then
    echo "[deploy] capture-helper doctor ok"
  else
    echo "[deploy] WARNING: capture-helper doctor failed on $MACHINE; grant Screen Recording permission or run: $CAPTURE_HELPER_REMOTE_QUOTED doctor --open-permissions" >&2
  fi
fi

# --- rsync @farmslot/* workspace packages AFTER yarn install (yarn wipes unmanaged node_modules) ---
echo "[deploy] syncing workspace packages..."
while IFS=$'\t' read -r pkg_name pkg_dir needs_build; do
  [[ -z "$pkg_name" ]] && continue
  PKG_SRC="$PACKAGES_DIR/$pkg_dir"
  PKG_DEST="$REMOTE_DIR/node_modules/$pkg_name"
  # </dev/null: run() may be ssh, which otherwise consumes the loop's stdin
  # (the remaining FARMSLOT_DEPS rows) and silently drops every package after
  # the first — the node then crashes with ERR_MODULE_NOT_FOUND at startup.
  run "mkdir -p $PKG_DEST" < /dev/null
  # Source-based packages (e.g. @farmslot/capabilities) ship no dist/; built
  # packages (e.g. @farmslot/protocol) ship both — sync whichever exist.
  [[ -d "$PKG_SRC/src" ]] && rsync -a --delete "$PKG_SRC/src/" "${RSYNC_PREFIX}$PKG_DEST/src/"
  [[ -d "$PKG_SRC/dist" ]] && rsync -a --delete "$PKG_SRC/dist/" "${RSYNC_PREFIX}$PKG_DEST/dist/"
  # Ship what the package publishes beside dist/: agent-runtime's dist imports
  # its CJS helpers (dist/native/review-sandbox.js requires
  # ../../scripts/review-filesystem.cjs), so a dist-only copy crashes the node at
  # boot with MODULE_NOT_FOUND.
  [[ -d "$PKG_SRC/scripts" ]] && rsync -a --delete "$PKG_SRC/scripts/" "${RSYNC_PREFIX}$PKG_DEST/scripts/"
  [[ -d "$PKG_SRC/bin" ]] && rsync -a --delete "$PKG_SRC/bin/" "${RSYNC_PREFIX}$PKG_DEST/bin/"
  rsync -a "$PKG_SRC/package.json" "${RSYNC_PREFIX}$PKG_DEST/package.json"
  echo "  → $pkg_name"
done <<< "$FARMSLOT_DEPS"

# Task files rendered for remote slots call helper scripts under
# ~/farmslot-node/packages/agent-runtime/scripts/*. Keep that package tree in
# the remote agent dir for those task files; the node service imports its own
# copy under node_modules/@farmslot/agent-runtime (synced above).
echo "[deploy] syncing agent-runtime task helpers..."
run "mkdir -p $REMOTE_DIR/packages/agent-runtime"
rsync -a --delete \
  --exclude node_modules \
  --exclude dist \
  "$PACKAGES_DIR/agent-runtime/" \
  "${RSYNC_PREFIX}$REMOTE_DIR/packages/agent-runtime/"

# --- Refuse a deployed node token that an env file would shadow ---
# The node reads FARMSLOT_NODE_TOKEN from a .env.local-auth or .env in or above
# its install dir ahead of the token the service definition below carries, so a
# stale file kept nodes failing auth after a deploy that reported success. The
# synced node answers with the service's own invocation (FARMSLOT_ROOT unset
# included) and cwd, before the service is touched; the token goes over stdin.
if [[ -n "$DEPLOYED_NODE_TOKEN" ]]; then
  echo "[deploy] checking for an env file that shadows the node token..."
  if ! printf '%s' "$DEPLOYED_NODE_TOKEN" | run "cd $(printf '%q' "$REMOTE_DIR") && $(printf '%q ' "${NODE_TOKEN_CHECK_ARGS[@]}")"; then
    echo "[deploy] ERROR: node token check failed on $MACHINE; the service was not reloaded" >&2
    exit 1
  fi
fi

# --- Install service (platform-specific) ---

if [[ "$REMOTE_OS" == "Darwin" ]]; then
  PLIST_NAME="com.farmslot.node${LAUNCHD_LABEL_SUFFIX}"
  PLIST_REL="Library/LaunchAgents/${PLIST_NAME}.plist"

  echo "[deploy] installing launchd service..."
  run "umask 077; mkdir -p ~/Library/LaunchAgents && private_tmp=\$(mktemp ~/$PLIST_REL.tmp.XXXXXX) && trap 'rm -f \"\$private_tmp\"' EXIT && cat > \"\$private_tmp\" && chmod 600 \"\$private_tmp\" && mv \"\$private_tmp\" ~/$PLIST_REL && trap - EXIT" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_NAME}</string>
    <key>ProgramArguments</key>
    <array>
$(launchd_node_arguments)
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>GATEWAY_URL</key>
        <string>${NODE_GATEWAY_URL}</string>
        <key>MACHINE_NAME</key>
        <string>${NODE_MACHINE_NAME}</string>
        <key>CAPTURE_HELPER_PATH</key>
        <string>$(printf '%s' "$CAPTURE_HELPER_REMOTE" | xml_escape)</string>
$(launchd_auth_env_xml)$(launchd_instance_env_xml)        <key>PATH</key>
        <string>$(printf '%s' "$NODE_SERVICE_PATH" | xml_escape)</string>
    </dict>
    <key>WorkingDirectory</key>
    <string>${REMOTE_DIR}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>StandardOutPath</key>
    <string>${REMOTE_DIR}/node.log</string>
    <key>StandardErrorPath</key>
    <string>${REMOTE_DIR}/node.log</string>
    <key>LimitLoadToSessionType</key>
    <string>Aqua</string>
</dict>
</plist>
PLIST
  run "chmod 600 ~/$PLIST_REL"

  echo "[deploy] reloading launchd service..."
  # `launchctl load` silently fails for a previously disabled job and does not
  # reliably refresh changed environment variables. Re-bootstrap the service
  # definition, waiting briefly for bootout to leave the launchd domain.
  run "set -e; uid=\$(id -u); domain=gui/\$uid; label=$PLIST_NAME; plist=\$HOME/$PLIST_REL; \
launchctl bootout \"\$domain/\$label\" 2>/dev/null || true; \
wait_count=0; while launchctl print \"\$domain/\$label\" >/dev/null 2>&1; do \
  wait_count=\$((wait_count + 1)); \
  if [[ \$wait_count -ge 20 ]]; then echo '[deploy] ERROR: launchd service did not stop' >&2; exit 1; fi; \
  sleep 0.25; \
done; \
launchctl enable \"\$domain/\$label\"; \
attempt=1; until launchctl bootstrap \"\$domain\" \"\$plist\"; do \
  if [[ \$attempt -ge 5 ]]; then echo '[deploy] ERROR: launchd bootstrap failed after 5 attempts' >&2; exit 1; fi; \
  attempt=\$((attempt + 1)); sleep 1; \
done; \
launchctl kickstart -k \"\$domain/\$label\""
  sleep 2
  echo "[deploy] verifying..."
  run "launchctl print gui/\$(id -u)/$PLIST_NAME | grep -E 'state = running|pid ='"
  echo ""
  echo "[deploy] done."
  echo "  Logs:   tail -f $REMOTE_DIR/node.log"
  echo "  Stop:   launchctl stop $PLIST_NAME"
  echo "  Start:  launchctl start $PLIST_NAME"
  echo ""
  echo "  NOTE: Screen Recording TCC permission required for capture-helper."
  echo "  If streaming fails with -3801, run:"
  echo "    $CAPTURE_HELPER_REMOTE doctor --open-permissions"

elif [[ "$REMOTE_OS" == "Linux" ]]; then
  UNIT_NAME="farmslot-node${INSTANCE_SUFFIX}"
  UNIT_DIR=".config/systemd/user"

  echo "[deploy] installing systemd user service..."
  run "umask 077; mkdir -p ~/$UNIT_DIR && private_tmp=\$(mktemp ~/$UNIT_DIR/${UNIT_NAME}.service.tmp.XXXXXX) && trap 'rm -f \"\$private_tmp\"' EXIT && cat > \"\$private_tmp\" && chmod 600 \"\$private_tmp\" && mv \"\$private_tmp\" ~/$UNIT_DIR/${UNIT_NAME}.service && trap - EXIT" << UNIT
[Unit]
Description=Farmslot Node (${MACHINE}, ${INSTANCE})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${REMOTE_DIR}
Environment=GATEWAY_URL=${NODE_GATEWAY_URL}
Environment=MACHINE_NAME=${NODE_MACHINE_NAME}
Environment=PATH=${NODE_SERVICE_PATH}
$(systemd_auth_env_lines)
$(systemd_instance_env_lines)
Environment=HOME=${REMOTE_HOME}
ExecStart=$(systemd_node_arguments)
Restart=always
RestartSec=5
StandardOutput=append:${REMOTE_DIR}/node.log
StandardError=append:${REMOTE_DIR}/node.log

[Install]
WantedBy=default.target
UNIT
  run "chmod 600 ~/$UNIT_DIR/${UNIT_NAME}.service"

  echo "[deploy] reloading systemd service..."
  run "systemctl --user daemon-reload && systemctl --user enable $UNIT_NAME && systemctl --user restart $UNIT_NAME"
  sleep 2
  echo "[deploy] verifying..."
  run "systemctl --user is-active --quiet $UNIT_NAME && systemctl --user show $UNIT_NAME --property=ActiveState --property=SubState --property=MainPID"
  echo ""
  echo "[deploy] done."
  echo "  Logs:   tail -f $REMOTE_DIR/node.log"
  echo "  Stop:   systemctl --user stop $UNIT_NAME"
  echo "  Start:  systemctl --user start $UNIT_NAME"

else
  echo "[deploy] ERROR: unsupported OS '$REMOTE_OS'"
  exit 1
fi

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
  # falling back to plain `bash -lc` when no server is running; either way within
  # CLI_VERIFY_TIMEOUT_SECONDS. The worker prefix and the tmux lookup are the gateway's own
  # (scripts/lib/worker-env-prefix.sh, scripts/lib/tmux-bin.sh); the prefix puts
  # ~/.local/bin, where the links above live, first on PATH. GW_URL is the URL
  # this node dials, and no control-plane credential is set, so the CLI
  # authenticates with the stored profile for that URL exactly as a tmux worker
  # does. FARMSLOT_HOME is left as the shell has it for both instances. Native
  # workers instead inherit the node's FARMSLOT_HOME (~/.farmslot-dev for dev);
  # that is a known follow-up, and this verifies the tmux worker path only.
  echo "[deploy] verifying node CLI from a worker shell..."
  WORKER_ENV_PREFIX=$(< "$SCRIPT_DIR/lib/worker-env-prefix.sh")
  TMUX_BIN_LOOKUP=$(< "$SCRIPT_DIR/lib/tmux-bin.sh")
  if ! run "bash -s $(printf '%q ' "$CLI_ENTRY" "$NODE_GATEWAY_URL" "$WORKER_ENV_PREFIX" "$TMUX_BIN_LOOKUP" "${CLI_VERIFY_TIMEOUT_SECONDS:-120}" "$INSTANCE")" << 'VERIFY'
set -uo pipefail
entry=$1 gw_url=$2 prefix=$3 tmux_lookup=$4 timeout=$5 instance=$6
work=$(mktemp -d "${TMPDIR:-/tmp}/farmslot-cli-verify.XXXXXX")
session=""
fallback_pid=""
cleanup() {
  if [ -n "$session" ]; then "$TMUX_BIN" kill-session -t "=$session" 2> /dev/null || true; fi
  # The fallback runs as its own process group: stop the probe's CLI too.
  if [ -n "$fallback_pid" ]; then
    kill -TERM -- "-$fallback_pid" 2> /dev/null || true
    wait "$fallback_pid" 2> /dev/null || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT
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
if ! farmslot rpc gateway.status < /dev/null > /dev/null; then
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
  echo "  fix: store a gateway profile for that URL as this user:" >&2
  echo "    farmslot gateway add <name> $GW_URL && farmslot login <name>" >&2
  exit 1
fi
echo "  farmslot rpc gateway.status ok ($GW_URL)"
PROBE
probe="$prefix && export GW_URL=$(printf '%q' "$gw_url") && bash $(printf '%q' "$work/probe.sh") $(printf '%q ' "$entry" "$instance")"
launch="exec bash -lc $(printf '%q' "$probe > $(printf '%q' "$work/out") 2>&1; echo \$? > $(printf '%q' "$work/status")")"
eval "$tmux_lookup"
if [ -n "$TMUX_BIN" ] && "$TMUX_BIN" list-sessions > /dev/null 2>&1; then
  session="farmslot-cli-verify-$$"
  if ! "$TMUX_BIN" new-session -d -s "$session" "$launch"; then
    session=""
    echo "[deploy] ERROR: could not start a verify session on the tmux server ($TMUX_BIN)" >&2
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

if [[ "$INSTANCE" == "prod" ]]; then
  echo "  Update: bash scripts/deploy-node.sh $MACHINE"
else
  echo "  Update: bash scripts/deploy-node.sh $MACHINE --instance $INSTANCE"
fi
