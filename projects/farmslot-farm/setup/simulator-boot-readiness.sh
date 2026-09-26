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
  health_result=$(rpc resource.health "$resource_args" 15000) || return
  printf '%s\n' "$health_result" | jq -ec '.resources[] | select(.id == "ios-sim") | {id,status}'
}

ready() {
  rpc fleet.status '{}' 15000 |
    jq -ec --arg slot "$slot_id" '.fleet.slots[] | select(.slot == $slot and .lifecycle == "ready" and .currentRunId == null and .agent == "idle")' >/dev/null
}

shutdown() {
  result=$(rpc resource.control "$shutdown_args" 45000)
  printf '%s\n' "$result" | jq -e '.ok == true' >/dev/null
  printf 'shutdown:ok:%s\n' "$(printf '%s\n' "$result" | jq -c '.')"
}

cleanup() {
  if [ "$boot_attempted" != yes ]; then return 0; fi
  attempt=0
  while [ "$attempt" -lt 60 ]; do
    attempt=$((attempt + 1))
    inventory=$(rpc resource.device.inventory "{\"slotId\":\"$slot_id\",\"refresh\":true}" 15000) || return 1
    state=$(printf '%s\n' "$inventory" | jq -er --arg slot "$slot_id" '.devices[] | select(.platform == "ios" and (.configuredForSlots | index($slot))) | .state') || return 1
    case "$state" in
      Shutdown) return 0 ;;
      Booted) shutdown >/dev/null || return 1 ;;
      Booting|"Shutting Down") sleep 2 ;;
      *) printf 'Simulator cleanup cannot resolve state: %s\n' "$state" >&2; return 1 ;;
    esac
  done
  printf 'Simulator cleanup could not observe a stopped device\n' >&2
  return 1
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
ready
health | jq -e '.status == "stopped"' >/dev/null
boot_attempted=yes
result=$(rpc resource.control "$boot_args" 150000)
printf '%s\n' "$result" | jq -e '.ok == true' >/dev/null
printf 'boot:ok:%s\n' "$(printf '%s\n' "$result" | jq -c '.')"

observed=no
for attempt in 1 2 3 4 5 6; do
  if ! snapshot=$(health); then
    printf 'Simulator running health probe failed (%s/6); retrying\n' "$attempt" >&2
    sleep 2
    continue
  fi
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
  if ! snapshot=$(health); then
    printf 'Simulator stopped health probe failed (%s/6); retrying\n' "$attempt" >&2
    sleep 2
    continue
  fi
  if printf '%s\n' "$snapshot" | jq -e '.status == "stopped"' >/dev/null; then
    printf 'stopped:%s\n' "$snapshot"
    boot_attempted=no
    exit 0
  fi
  sleep 2
done
exit 1
