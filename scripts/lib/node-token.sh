# Sourced by deploy-node.sh, never run on its own. Where an update finds the node
# token when no --node-token-file was given. Needs the deploy's `run`, REMOTE_OS,
# REMOTE_HOME, REMOTE_DIR, PLIST_NAME and UNIT_NAME. A token is only ever captured
# into a variable, never printed by these functions.

# The .env in or above the install dir whose FARMSLOT_NODE_TOKEN the node uses,
# if any. A line-for-line port of the node's reading
# (services/node/src/gateway-credential.ts readEnvFile and nonEmpty): trim the
# line, skip blanks and comments, drop a literal "export " prefix, split at the
# first "=", trim key and value, strip one pair of matching quotes, let a later
# line win, and take the value only when it is not blank. The value is never printed.
NODE_ENV_TOKEN_READER='import os, re, sys
# JavaScript String.prototype.trim: whitespace, line terminators and U+FEFF.
JS_SPACE = "[\t\n\x0b\x0c\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]"
def trim(text):
    return re.sub("^" + JS_SPACE + "+|" + JS_SPACE + "+$", "", text)
d = os.path.abspath(sys.argv[1])
while True:
    f = os.path.join(d, ".env")
    if os.path.exists(f):
        try:
            text = open(f, encoding="utf-8", errors="replace").read()
        except OSError as error:
            # The node reads this file too, and would fail on it at startup.
            print(f"cannot read {f}: {error.strerror}", file=sys.stderr)
            sys.exit(3)
        values = {}
        for raw in text.split("\n"):
            line = trim(raw)
            if not line or line.startswith("#"):
                continue
            if line.startswith("export "):
                line = trim(line[len("export "):])
            eq = line.find("=")
            if eq <= 0:
                continue
            key, value = trim(line[:eq]), trim(line[eq + 1:])
            if (value.startswith("\"") and value.endswith("\"")) or (
                value.startswith("\x27") and value.endswith("\x27")
            ):
                value = value[1:-1]
            values[key] = value
        if trim(values.get("FARMSLOT_NODE_TOKEN", "")):
            print(f)
            break
    parent = os.path.dirname(d)
    if parent == d:
        break
    d = parent'
# Fails when a .env the node would read cannot be read: the node would fail on it too.
node_env_token_file() {
  run "python3 -c $(printf '%q' "$NODE_ENV_TOKEN_READER") $(printf '%q' "$REMOTE_DIR")"
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
