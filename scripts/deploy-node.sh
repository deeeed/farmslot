#!/usr/bin/env bash
# deploy-node.sh — Deploy/update farmslot node to any fleet machine
# Usage: bash scripts/deploy-node.sh <machine> [gateway-ip] [--instance dev|prod]
#
# Supports:
#   macOS local  (runner-local) — launchd LaunchAgent
#   macOS remote (mini)    — launchd LaunchAgent
#   Linux remote (runner-a, runner-b) — systemd user service
#
# Same command for install and update. Rsyncs code and restarts the service.
#
# Instances: a machine can run a prod node and a dev node side by side —
# distinct install dir, service name, gateway URL, and IPC state. Default
# instance is "prod" (identical to the original single-instance behavior).
# Select the other with --instance dev or FARMSLOT_NODE_INSTANCE=dev.
#
# One-time prerequisites:
#   macOS: node installed + Screen Recording permission for `node` binary
#   Linux: node installed + loginctl enable-linger (for user services without login)

set -euo pipefail

INSTANCE="${FARMSLOT_NODE_INSTANCE:-prod}"
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
    *)
      ARGS+=("$1")
      shift
      ;;
  esac
done
set -- "${ARGS[@]}"

MACHINE="${1:?Usage: deploy-node.sh <machine> [gateway-ip] [--instance dev|prod]}"
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
// main/exports point straight at src/*.ts) never need a build. dist/ is gitignored,
// so on a fresh checkout — or after protocol changes without a rebuild — it can be
// missing even though the workspace resolves fine locally via tsx path aliasing.
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
    echo "[deploy] ERROR: failed to build $pkg_name — refusing to deploy a distless package" >&2
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
  run() { ssh "$MACHINE.local" "$@"; }
  RSYNC_PREFIX="$MACHINE.local:"
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
echo "[deploy] target=$MACHINE instance=$INSTANCE os=$REMOTE_OS gateway=ws://$GATEWAY_IP:$GATEWAY_PORT dir=$REMOTE_DIR"

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

xml_escape() {
  python3 -c 'import html,sys; print(html.escape(sys.stdin.read().rstrip("\n"), quote=True))'
}

launchd_auth_env_xml() {
  if [[ -n "${FARMSLOT_GATEWAY_TOKEN:-}" ]]; then
    printf '        <key>FARMSLOT_NODE_TOKEN</key>
        <string>%s</string>
' "$(printf '%s' "$FARMSLOT_GATEWAY_TOKEN" | xml_escape)"
  elif [[ -n "${FARMSLOT_GATEWAY_PASSWORD:-}" ]]; then
    printf '        <key>FARMSLOT_GATEWAY_PASSWORD</key>
        <string>%s</string>
' "$(printf '%s' "$FARMSLOT_GATEWAY_PASSWORD" | xml_escape)"
  fi
}

systemd_auth_env_lines() {
  if [[ -n "${FARMSLOT_GATEWAY_TOKEN:-}" ]]; then
    printf 'Environment="FARMSLOT_NODE_TOKEN=%s"
' "$(printf '%s' "$FARMSLOT_GATEWAY_TOKEN" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  elif [[ -n "${FARMSLOT_GATEWAY_PASSWORD:-}" ]]; then
    printf 'Environment="FARMSLOT_GATEWAY_PASSWORD=%s"
' "$(printf '%s' "$FARMSLOT_GATEWAY_PASSWORD" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  fi
}

# Non-prod-only env: keeps the dev instance's home dir and screen-control IPC
# socket from colliding with prod's when both run on the same machine. Prod
# stays unset here, so services/node falls back to its original defaults
# unchanged (~/.farmslot, /tmp/farmslot-screen-control-<uid>.sock).
launchd_instance_env_xml() {
  if [[ -n "$INSTANCE_SUFFIX" ]]; then
    printf '        <key>FARMSLOT_HOME</key>
        <string>%s</string>
        <key>SCREEN_CONTROL_SOCKET</key>
        <string>%s</string>
' "$(printf '%s' "$REMOTE_HOME/.farmslot${INSTANCE_SUFFIX}" | xml_escape)" "$(printf '%s' "$SCREEN_CONTROL_SOCKET_PATH" | xml_escape)"
  fi
}

systemd_instance_env_lines() {
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
    "@siteed/capture-helper": "^0.2.1",
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
CAPTURE_HELPER_REMOTE="$REMOTE_DIR/node_modules/@siteed/capture-helper/native/capture-helper"
if [[ "$REMOTE_OS" == "Darwin" ]]; then
  run "test -x $CAPTURE_HELPER_REMOTE"
  if run "PATH=$NODE_DIR:\$PATH $NODE_PATH -e 'const { spawnSync } = require(\"node:child_process\"); const bin = process.argv[1]; const result = spawnSync(bin, [\"doctor\", \"--json\"], { encoding: \"utf8\", timeout: 15000, maxBuffer: 1024 * 1024 }); if (result.status !== 0) { process.stderr.write(result.stderr || result.stdout || (result.error && result.error.message) || \"capture-helper doctor failed\"); process.exit(1); }' $CAPTURE_HELPER_REMOTE"; then
    echo "[deploy] capture-helper doctor ok"
  else
    echo "[deploy] WARNING: capture-helper doctor failed on $MACHINE; grant Screen Recording permission or run: $CAPTURE_HELPER_REMOTE doctor --open-permissions" >&2
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
  rsync -a "$PKG_SRC/package.json" "${RSYNC_PREFIX}$PKG_DEST/package.json"
  echo "  → $pkg_name"
done <<< "$FARMSLOT_DEPS"

# Task files rendered for remote slots call helper scripts under
# ~/farmslot-node/packages/agent-runtime/scripts/*. Keep that package tree in
# the remote agent dir even though the node service itself does not import it.
echo "[deploy] syncing agent-runtime task helpers..."
run "mkdir -p $REMOTE_DIR/packages/agent-runtime"
rsync -a --delete \
  --exclude node_modules \
  --exclude dist \
  "$PACKAGES_DIR/agent-runtime/" \
  "${RSYNC_PREFIX}$REMOTE_DIR/packages/agent-runtime/"

# --- Install service (platform-specific) ---

if [[ "$REMOTE_OS" == "Darwin" ]]; then
  PLIST_NAME="com.farmslot.node${LAUNCHD_LABEL_SUFFIX}"
  PLIST_REL="Library/LaunchAgents/${PLIST_NAME}.plist"

  echo "[deploy] installing launchd service..."
  run "mkdir -p ~/Library/LaunchAgents && cat > ~/$PLIST_REL" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_NAME}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_PATH}</string>
        <string>--require</string>
        <string>${REMOTE_DIR}/node_modules/tsx/dist/preflight.cjs</string>
        <string>--import</string>
        <string>file://${REMOTE_DIR}/node_modules/tsx/dist/loader.mjs</string>
        <string>${REMOTE_DIR}/src/index.ts</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>GATEWAY_URL</key>
        <string>ws://${GATEWAY_IP}:${GATEWAY_PORT}</string>
        <key>MACHINE_NAME</key>
        <string>${NODE_MACHINE_NAME}</string>
        <key>CAPTURE_HELPER_PATH</key>
        <string>${CAPTURE_HELPER_REMOTE}</string>
$(launchd_auth_env_xml)$(launchd_instance_env_xml)        <key>PATH</key>
        <string>${REMOTE_DIR}/node_modules/.bin:${NODE_DIR}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/usr/sbin:/bin</string>
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

  echo "[deploy] reloading launchd service..."
  run "launchctl unload ~/$PLIST_REL 2>/dev/null; launchctl load ~/$PLIST_REL"
  sleep 2
  echo "[deploy] verifying..."
  run "launchctl list | grep $PLIST_NAME || echo 'WARNING: service not running'"
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
  run "mkdir -p ~/$UNIT_DIR && cat > ~/$UNIT_DIR/${UNIT_NAME}.service" << UNIT
[Unit]
Description=Farmslot Node (${MACHINE}, ${INSTANCE})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${REMOTE_DIR}
Environment=GATEWAY_URL=ws://${GATEWAY_IP}:${GATEWAY_PORT}
Environment=MACHINE_NAME=${NODE_MACHINE_NAME}
Environment=PATH=${NODE_DIR}:/usr/local/bin:/usr/bin:/bin
$(systemd_auth_env_lines)
$(systemd_instance_env_lines)
Environment=HOME=${REMOTE_HOME}
ExecStart=${NODE_PATH} --require ${REMOTE_DIR}/node_modules/tsx/dist/preflight.cjs --import file://${REMOTE_DIR}/node_modules/tsx/dist/loader.mjs ${REMOTE_DIR}/src/index.ts
Restart=always
RestartSec=5
StandardOutput=append:${REMOTE_DIR}/node.log
StandardError=append:${REMOTE_DIR}/node.log

[Install]
WantedBy=default.target
UNIT

  echo "[deploy] reloading systemd service..."
  run "systemctl --user daemon-reload && systemctl --user enable $UNIT_NAME && systemctl --user restart $UNIT_NAME"
  sleep 2
  echo "[deploy] verifying..."
  run "systemctl --user status $UNIT_NAME --no-pager 2>&1 | head -5"
  echo ""
  echo "[deploy] done."
  echo "  Logs:   tail -f $REMOTE_DIR/node.log"
  echo "  Stop:   systemctl --user stop $UNIT_NAME"
  echo "  Start:  systemctl --user start $UNIT_NAME"

else
  echo "[deploy] ERROR: unsupported OS '$REMOTE_OS'"
  exit 1
fi

if [[ "$INSTANCE" == "prod" ]]; then
  echo "  Update: bash scripts/deploy-node.sh $MACHINE"
else
  echo "  Update: bash scripts/deploy-node.sh $MACHINE --instance $INSTANCE"
fi
