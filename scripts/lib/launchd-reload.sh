#!/usr/bin/env bash
# launchd-reload.sh — source it. Prints the shell deploy-node's run() executes on the target to
# restart a node service and confirm the new node registered. run() is either ssh to the target's
# login shell (zsh on macOS, any POSIX sh on Linux) or a local eval inside deploy-node's
# `set -euo pipefail`, so each script runs in its own subshell and tolerates failing pipelines.
#
# launchd_reload_script <label> <plist path relative to $HOME> <node log path>
#   `launchctl load` silently fails for a previously disabled job and does not reliably refresh
#   changed environment variables, so the job is booted out and bootstrapped again (RunAtLoad
#   starts it; no `kickstart -k`, which would stop the node bootstrap just started). bootout only
#   removes the job from launchd's domain, so as a backstop the previous pid must also be gone
#   (SIGKILL at the deadline, matched by start time so a reused pid is never signalled).
# systemd_restart_script <unit> <node log path>
# Both then wait for the new node's outcome in its log, matched by its pid: registered, or refused
# because another process already holds the machine id at the gateway (the deploy fails, naming it).

# The node log check shared by both (POSIX sh). Expects $log, $log_offset (bytes before this
# restart), $new_pid and current_pid (the node's pid now: a node restarted at boot gets a new one;
# empty when unknown, and then any registration or refusal counts).
node_registration_check_fragment() {
  cat <<'SCRIPT'
checks=${FARMSLOT_DEPLOY_REGISTRATION_CHECKS:-60}; outcome=''; check_count=0; refused_line=''; \
while [ -z "$outcome" ] && [ "$check_count" -lt "$checks" ]; do \
  new_pid=$(current_pid); \
  recent=$(tail -c +$((log_offset + 1)) "$log" 2>/dev/null || true); \
  if [ -n "$new_pid" ]; then \
    refused_line=$(printf '%s\n' "$recent" | grep NODE_ALREADY_CONNECTED | grep "refused pid $new_pid\$" | tail -n 1 || true); \
    registered_line=$(printf '%s\n' "$recent" | grep -F 'Registered with gateway as' | grep -F "pid $new_pid)" | tail -n 1 || true); \
  else \
    refused_line=$(printf '%s\n' "$recent" | grep NODE_ALREADY_CONNECTED | tail -n 1 || true); \
    registered_line=$(printf '%s\n' "$recent" | grep -F 'Registered with gateway as' | tail -n 1 || true); \
  fi; \
  if [ -n "$refused_line" ]; then outcome=refused; \
  elif [ -n "$registered_line" ]; then outcome=registered; \
  else check_count=$((check_count + 1)); sleep 0.5; fi; \
done; \
case "$outcome" in \
  refused) echo "[deploy] ERROR: the gateway refused the new node: $refused_line" >&2; exit 1 ;; \
  registered) echo '[deploy] node registered with the gateway' ;; \
  *) echo "[deploy] WARN: the new node has not registered with the gateway after $((checks / 2)) s; check its log" >&2 ;; \
esac
SCRIPT
}

launchd_reload_script() {
  local label="$1" plist_rel="$2" log_path
  log_path=$(printf '%q' "$3")
  cat <<SCRIPT
( set -e; uid=\$(id -u); domain=gui/\$uid; label=$label; plist=\$HOME/$plist_rel; log=$log_path; \\
job_pid() { launchctl print "\$domain/\$label" 2>/dev/null | awk '/^[[:space:]]*pid = [0-9]+/ { print \$3; exit }' || true; }; \\
old_pid=\$(job_pid); \\
old_start=''; if [ -n "\$old_pid" ]; then old_start=\$(ps -o lstart= -p "\$old_pid" 2>/dev/null || true); fi; \\
launchctl bootout "\$domain/\$label" 2>/dev/null || true; \\
same_old() { [ -n "\$old_pid" ] && [ -n "\$old_start" ] && [ "\$(ps -o lstart= -p "\$old_pid" 2>/dev/null || true)" = "\$old_start" ]; }; \\
loaded() { launchctl print "\$domain/\$label" >/dev/null 2>&1; }; \\
wait_count=0; while loaded || same_old; do \\
  wait_count=\$((wait_count + 1)); \\
  if [ "\$wait_count" -ge "\${FARMSLOT_DEPLOY_STOP_CHECKS:-80}" ]; then \\
    if same_old; then echo "[deploy] WARN: previous node pid \$old_pid outlived launchd bootout; killing it" >&2; kill -9 "\$old_pid" 2>/dev/null || true; fi; \\
    break; \\
  fi; \\
  sleep 0.25; \\
done; \\
wait_count=0; while loaded || same_old; do \\
  wait_count=\$((wait_count + 1)); \\
  if [ "\$wait_count" -ge 20 ]; then echo '[deploy] ERROR: the previous node service did not stop' >&2; exit 1; fi; \\
  sleep 0.25; \\
done; \\
log_offset=0; if [ -f "\$log" ]; then log_offset=\$(wc -c < "\$log" | tr -d ' '); fi; \\
launchctl enable "\$domain/\$label"; \\
attempt=1; until launchctl bootstrap "\$domain" "\$plist"; do \\
  if [ "\$attempt" -ge 5 ]; then echo '[deploy] ERROR: launchd bootstrap failed after 5 attempts' >&2; exit 1; fi; \\
  attempt=\$((attempt + 1)); sleep 1; \\
done; \\
new_pid=''; wait_count=0; while [ -z "\$new_pid" ] && [ "\$wait_count" -lt 20 ]; do new_pid=\$(job_pid); [ -n "\$new_pid" ] || { wait_count=\$((wait_count + 1)); sleep 0.25; }; done; \\
current_pid() { p=\$(job_pid); [ -n "\$p" ] && echo "\$p" || echo "\$new_pid"; }; \\
$(node_registration_check_fragment) )
SCRIPT
}

systemd_restart_script() {
  local unit="$1" log_path
  log_path=$(printf '%q' "$2")
  cat <<SCRIPT
( set -e; log=$log_path; \\
log_offset=0; if [ -f "\$log" ]; then log_offset=\$(wc -c < "\$log" | tr -d ' '); fi; \\
systemctl --user daemon-reload; \\
systemctl --user enable $unit; \\
systemctl --user restart $unit; \\
main_pid() { p=\$(systemctl --user show -p MainPID --value $unit 2>/dev/null || true); [ "\$p" != 0 ] || p=''; echo "\$p"; }; \\
new_pid=\$(main_pid); current_pid() { p=\$(main_pid); [ -n "\$p" ] && echo "\$p" || echo "\$new_pid"; }; \\
$(node_registration_check_fragment) )
SCRIPT
}
