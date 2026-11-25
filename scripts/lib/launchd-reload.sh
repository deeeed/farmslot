#!/usr/bin/env bash
# launchd-reload.sh — source it. Prints the shell deploy-node's run() executes on the target to
# restart a node service and confirm the new node registered.
#
# launchd_reload_script <label> <plist path relative to $HOME> <node log path>
#   `launchctl load` silently fails for a previously disabled job and does not reliably refresh
#   changed environment variables, so the job is booted out and bootstrapped again (RunAtLoad
#   starts it; no `kickstart -k`, which would stop the node bootstrap just started). bootout only
#   removes the job from launchd's domain, so as a backstop the previous pid must also be gone
#   (SIGKILL at the deadline, matched by start time so a reused pid is never signalled).
# systemd_restart_script <unit> <node log path>
# Both then wait up to 30 s for the new node's outcome in its log: registered, or refused because
# another process already holds the machine id at the gateway (the deploy fails, naming it).

# The node log check shared by both. Expects $log and $log_offset (bytes before this restart).
node_registration_check_fragment() {
  cat <<'SCRIPT'
outcome=''; check_count=0; \
while [[ -z "$outcome" && $check_count -lt ${FARMSLOT_DEPLOY_REGISTRATION_CHECKS:-60} ]]; do \
  recent=$(tail -c +$((log_offset + 1)) "$log" 2>/dev/null || true); \
  case "$recent" in \
    *NODE_ALREADY_CONNECTED*) outcome=refused ;; \
    *'Registered with gateway as'*) outcome=registered ;; \
  esac; \
  [[ -n "$outcome" ]] || { check_count=$((check_count + 1)); sleep 0.5; }; \
done; \
case "$outcome" in \
  refused) echo "[deploy] ERROR: the gateway refused the new node: $(printf '%s\n' "$recent" | grep NODE_ALREADY_CONNECTED | tail -1)" >&2; exit 1 ;; \
  registered) echo '[deploy] node registered with the gateway' ;; \
  *) echo '[deploy] WARN: the new node has not registered with the gateway after 30 s; check its log' >&2 ;; \
esac
SCRIPT
}

launchd_reload_script() {
  local label="$1" plist_rel="$2" log_path
  log_path=$(printf '%q' "$3")
  cat <<SCRIPT
set -e; uid=\$(id -u); domain=gui/\$uid; label=$label; plist=\$HOME/$plist_rel; log=$log_path; \\
old_pid=\$(launchctl print "\$domain/\$label" 2>/dev/null | awk '/^[[:space:]]*pid = [0-9]+/ { print \$3; exit }'); \\
old_start=''; if [[ -n "\$old_pid" ]]; then old_start=\$(ps -o lstart= -p "\$old_pid" 2>/dev/null || true); fi; \\
launchctl bootout "\$domain/\$label" 2>/dev/null || true; \\
same_old() { [[ -n "\$old_pid" && -n "\$old_start" ]] && [[ "\$(ps -o lstart= -p "\$old_pid" 2>/dev/null || true)" == "\$old_start" ]]; }; \\
wait_count=0; while launchctl print "\$domain/\$label" >/dev/null 2>&1 || same_old; do \\
  wait_count=\$((wait_count + 1)); \\
  if [[ \$wait_count -ge \${FARMSLOT_DEPLOY_STOP_CHECKS:-80} ]]; then \\
    if same_old; then echo "[deploy] WARN: previous node pid \$old_pid outlived launchd bootout; killing it" >&2; kill -9 "\$old_pid" 2>/dev/null || true; fi; \\
    break; \\
  fi; \\
  sleep 0.25; \\
done; \\
wait_count=0; while launchctl print "\$domain/\$label" >/dev/null 2>&1 || same_old; do \\
  wait_count=\$((wait_count + 1)); \\
  if [[ \$wait_count -ge 20 ]]; then echo '[deploy] ERROR: the previous node service did not stop' >&2; exit 1; fi; \\
  sleep 0.25; \\
done; \\
log_offset=\$(wc -c < "\$log" 2>/dev/null | tr -d ' ' || true); log_offset=\${log_offset:-0}; \\
launchctl enable "\$domain/\$label"; \\
attempt=1; until launchctl bootstrap "\$domain" "\$plist"; do \\
  if [[ \$attempt -ge 5 ]]; then echo '[deploy] ERROR: launchd bootstrap failed after 5 attempts' >&2; exit 1; fi; \\
  attempt=\$((attempt + 1)); sleep 1; \\
done; \\
$(node_registration_check_fragment)
SCRIPT
}

systemd_restart_script() {
  local unit="$1" log_path
  log_path=$(printf '%q' "$2")
  cat <<SCRIPT
set -e; log=$log_path; \\
log_offset=\$(wc -c < "\$log" 2>/dev/null | tr -d ' ' || true); log_offset=\${log_offset:-0}; \\
systemctl --user daemon-reload && systemctl --user enable $unit && systemctl --user restart $unit; \\
$(node_registration_check_fragment)
SCRIPT
}
