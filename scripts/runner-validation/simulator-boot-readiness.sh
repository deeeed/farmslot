#!/bin/sh
set -eu

slot_id=$1
gateway_port=$2
resource_args="{\"slotId\":\"$slot_id\",\"resourceId\":\"ios-sim\"}"
boot_args="{\"slotId\":\"$slot_id\",\"resourceId\":\"ios-sim\",\"action\":\"boot\"}"
shutdown_args="{\"slotId\":\"$slot_id\",\"resourceId\":\"ios-sim\",\"action\":\"shutdown\"}"
boot_attempted=no

rpc() {
  FARMSLOT_RPC_TIMEOUT_MS=$3 FARMSLOT_GATEWAY="ws://127.0.0.1:$gateway_port/ws" \
    node apps/command-center/scripts/cdp.mjs gateway "$1" "$2"
}

health() {
  rpc resource.health "$resource_args" 15000 | jq -ec '.resources[] | select(.id == "ios-sim") | {id,status}'
}

ready() {
  rpc fleet.status '{}' 15000 |
    jq -ec --arg slot "$slot_id" '.fleet.slots[] | select(.slot == $slot and .lifecycle == "ready" and .currentRunId == null and .agent == "idle")' >/dev/null
}

shutdown() {
  result=$(rpc resource.control "$shutdown_args" 45000)
  printf '%s\n' "$result" | jq -e '.ok == true' >/dev/null
  printf 'shutdown:%s\n' "$(printf '%s\n' "$result" | jq -c '.')"
}

cleanup() {
  if [ "$boot_attempted" = yes ]; then shutdown >/dev/null; fi
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
ready
health | jq -e '.status == "stopped"' >/dev/null
boot_attempted=yes
result=$(rpc resource.control "$boot_args" 150000)
printf '%s\n' "$result" | jq -e '.ok == true' >/dev/null
printf 'boot:%s\n' "$(printf '%s\n' "$result" | jq -c '.')"

observed=no
for attempt in 1 2 3 4 5 6; do
  snapshot=$(health)
  if printf '%s\n' "$snapshot" | jq -e '.status == "running"' >/dev/null; then
    printf 'running:%s\n' "$snapshot"
    observed=yes
    break
  fi
  sleep 2
done
[ "$observed" = yes ] || exit 1

shutdown
for attempt in 1 2 3 4 5 6; do
  snapshot=$(health)
  if printf '%s\n' "$snapshot" | jq -e '.status == "stopped"' >/dev/null; then
    printf 'stopped:%s\n' "$snapshot"
    boot_attempted=no
    exit 0
  fi
  sleep 2
done
exit 1
