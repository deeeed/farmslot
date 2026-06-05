#!/usr/bin/env bash
# deploy-node.sh — Deploy/update farmslot node to any fleet machine
# Usage: bash scripts/deploy-node.sh <machine> [gateway-ip]
#
# Supports:
#   macOS local  (runner-local) — launchd LaunchAgent
#   macOS remote (mini)    — launchd LaunchAgent
#   Linux remote (runner-a, runner-b) — systemd user service
#
# Same command for install and update. Rsyncs code and restarts the service.
#
# One-time prerequisites:
#   macOS: node installed + Screen Recording permission for `node` binary
#   Linux: node installed + loginctl enable-linger (for user services without login)

set -euo pipefail

MACHINE="${1:?Usage: deploy-node.sh <machine> [gateway-ip]}"
GATEWAY_IP="${2:-}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
NODE_SRC="$REPO_ROOT/services/node"
PROTOCOL_SRC="$REPO_ROOT/packages/protocol"
AUTH_ENV_FILE="$REPO_ROOT/.env.local-auth"

if [[ -f "$AUTH_ENV_FILE" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$AUTH_ENV_FILE"
  set +a
fi

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
REMOTE_DIR="$REMOTE_HOME/farmslot-node"

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
echo "[deploy] target=$MACHINE os=$REMOTE_OS gateway=ws://$GATEWAY_IP:7777"

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
run "cat > $REMOTE_DIR/package.json" << 'PKGJSON'
{
  "name": "@farmslot/node-standalone",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "ws": "^8.18.0",
    "tsx": "^4.19.0"
  },
  "optionalDependencies": {
    "@siteed/capture-helper": "^0.1.8"
  }
}
PKGJSON

echo "[deploy] installing dependencies..."
# Use yarn if available (with node-modules linker), otherwise npm
HAS_YARN=$(run "PATH=$NODE_DIR:\$PATH which yarn 2>/dev/null && echo yes || echo no")
if [[ "$HAS_YARN" == *"yes" ]]; then
  run "cd $REMOTE_DIR && echo 'nodeLinker: node-modules' > .yarnrc.yml && PATH=$NODE_DIR:\$PATH yarn install 2>&1 | tail -5"
else
  run "cd $REMOTE_DIR && PATH=$NODE_DIR:\$PATH npm install 2>&1 | tail -5"
fi
if [[ "$REMOTE_OS" == "Darwin" ]]; then
  run "test -x $REMOTE_DIR/node_modules/.bin/capture-helper"
fi

# --- rsync protocol AFTER yarn install (yarn wipes unmanaged node_modules) ---
echo "[deploy] syncing protocol..."
run "mkdir -p $REMOTE_DIR/node_modules/@farmslot/protocol"
rsync -a --delete "$PROTOCOL_SRC/src/" "${RSYNC_PREFIX}$REMOTE_DIR/node_modules/@farmslot/protocol/src/"
rsync -a --delete "$PROTOCOL_SRC/dist/" "${RSYNC_PREFIX}$REMOTE_DIR/node_modules/@farmslot/protocol/dist/"
rsync -a "$PROTOCOL_SRC/package.json" "${RSYNC_PREFIX}$REMOTE_DIR/node_modules/@farmslot/protocol/package.json"

# --- Install service (platform-specific) ---
CAPTURE_HELPER_REMOTE="$REMOTE_DIR/node_modules/.bin/capture-helper"

if [[ "$REMOTE_OS" == "Darwin" ]]; then
  PLIST_NAME="com.farmslot.node"
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
        <string>ws://${GATEWAY_IP}:7777</string>
        <key>MACHINE_NAME</key>
        <string>${MACHINE}</string>
        <key>CAPTURE_HELPER_PATH</key>
        <string>${CAPTURE_HELPER_REMOTE}</string>
$(launchd_auth_env_xml)        <key>PATH</key>
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
  run "launchctl list | grep farmslot || echo 'WARNING: service not running'"
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
  UNIT_NAME="farmslot-node"
  UNIT_DIR=".config/systemd/user"

  echo "[deploy] installing systemd user service..."
  run "mkdir -p ~/$UNIT_DIR && cat > ~/$UNIT_DIR/${UNIT_NAME}.service" << UNIT
[Unit]
Description=Farmslot Node (${MACHINE})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${REMOTE_DIR}
Environment=GATEWAY_URL=ws://${GATEWAY_IP}:7777
Environment=MACHINE_NAME=${MACHINE}
Environment=PATH=${NODE_DIR}:/usr/local/bin:/usr/bin:/bin
$(systemd_auth_env_lines)
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

echo "  Update: bash scripts/deploy-node.sh $MACHINE"
