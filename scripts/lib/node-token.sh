# Sourced by deploy-node.sh, never run on its own. Where an update finds the node
# token when no --node-token-file was given. Needs the deploy's `run`, REMOTE_OS,
# REMOTE_HOME, REMOTE_DIR, PLIST_NAME and UNIT_NAME. A token is only ever captured
# into a variable, never printed by these functions.

# The .env in or above the install dir whose FARMSLOT_NODE_TOKEN the node uses,
# if any. Matches the node's own reading (services/node/src/gateway-credential.ts):
# an optional `export`, spaces around the key and value, one pair of quotes, and a
# value that is not blank once those are removed.
node_env_token_file() {
  local pattern='^[[:space:]]*(export[[:space:]]+)?FARMSLOT_NODE_TOKEN[[:space:]]*=[[:space:]]*["'"'"']?[^"'"'"'[:space:]]'
  run "d=$(printf '%q' "$REMOTE_DIR"); while :; do if grep -qsE $(printf '%q' "$pattern") \"\$d/.env\"; then printf '%s\\n' \"\$d/.env\"; break; fi; [ \"\$d\" = / ] && break; d=\$(dirname \"\$d\"); done" 2>/dev/null || true
}

# The FARMSLOT_NODE_TOKEN the target's existing service definition carries, if any:
# the launchd plist on macOS, the systemd unit elsewhere.
service_definition_node_token() {
  if [[ "$REMOTE_OS" == Darwin ]]; then
    local plist key
    plist=$(printf '%q' "$REMOTE_HOME/Library/LaunchAgents/${PLIST_NAME}.plist")
    key=EnvironmentVariables.FARMSLOT_NODE_TOKEN
    if run "test -f $plist" && run "/usr/bin/plutil -extract $key raw -o /dev/null $plist" 2>/dev/null; then
      run "/usr/bin/plutil -extract $key raw -o - $plist"
    fi
  else
    local unit
    unit=$(printf '%q' "$REMOTE_HOME/.config/systemd/user/${UNIT_NAME}.service")
    # deploy-node writes Environment="FARMSLOT_NODE_TOKEN=..." with \ and " escaped.
    run "if test -f $unit; then sed -n 's/^Environment=\"FARMSLOT_NODE_TOKEN=\\(.*\\)\"\$/\\1/p' $unit | head -1; fi" 2>/dev/null |
      sed 's/\\"/"/g; s/\\\\/\\/g'
  fi
}
