#!/bin/sh
set -eu

slot_id=$1
gateway_port=$2
resource_args="{\"slotId\":\"$slot_id\",\"resourceId\":\"ios-sim\"}"
owner_run_id="simulator-readiness-$$"
acquire_args="{\"slotId\":\"$slot_id\",\"capabilityId\":\"ios-simulator\",\"ownerRunId\":\"$owner_run_id\",\"proofRequirement\":{\"capabilityId\":\"ios-simulator\",\"reason\":\"Simulator boot readiness\",\"mode\":\"state\"}}"
release_args="{\"slotId\":\"$slot_id\",\"capabilityId\":\"ios-simulator\",\"ownerRunId\":\"$owner_run_id\",\"keepWarm\":false}"
acquire_attempted=no
lease_acquired=no
lease_released=no

rpc() {
  FARMSLOT_RPC_TIMEOUT_MS=$3 FARMSLOT_GATEWAY="ws://127.0.0.1:$gateway_port/ws" \
    node apps/command-center/scripts/cdp.mjs gateway "$1" "$2"
}

health() {
  health_result=$(rpc resource.health "$resource_args" 15000) || return
  printf '%s\n' "$health_result" | jq -ec '.resources[] | select(.id == "ios-sim") | {id,status}'
}

ready() {
  rpc fleet.status '{"forceRefresh":true}' 120000 |
    jq -ec --arg slot "$slot_id" 'select(.fleet.stale != true) | .fleet.slots[] | select(.slot == $slot and .lifecycle == "ready" and .currentRunId == null and .agent == "idle")' >/dev/null
}

shutdown() {
  result=$(rpc runtime.capability.release "$release_args" 120000)
  printf '%s\n' "$result" | jq -e '.ok == true and any(.released[]?; .capabilityId == "ios-simulator")' >/dev/null
  lease_released=yes
  printf 'shutdown:ok:%s\n' "$(printf '%s\n' "$result" | jq -c '.')"
}

cleanup() {
  if [ "$acquire_attempted" != yes ]; then return 0; fi
  if [ "$lease_released" != yes ]; then
    if [ "$lease_acquired" = yes ]; then
      shutdown >/dev/null || return 1
    else
      result=$(rpc runtime.capability.release "$release_args" 540000) || return 1
      printf '%s\n' "$result" | jq -e '.ok == true' >/dev/null || return 1
      if ! printf '%s\n' "$result" | jq -e 'any(.released[]?; .capabilityId == "ios-simulator")' >/dev/null; then return 0; fi
      lease_released=yes
    fi
  fi
  attempt=0
  while [ "$attempt" -lt 60 ]; do
    attempt=$((attempt + 1))
    inventory=$(rpc resource.device.inventory "{\"slotId\":\"$slot_id\",\"refresh\":true}" 15000) || return 1
    state=$(printf '%s\n' "$inventory" | jq -er --arg slot "$slot_id" '.devices[] | select(.platform == "ios" and (.configuredForSlots | index($slot))) | .state' | sort -u) || return 1
    case "$state" in
      Shutdown) lease_acquired=no; return 0 ;;
      Booted|Booting|"Shutting Down") sleep 2 ;;
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
acquire_attempted=yes
result=$(rpc runtime.capability.acquire "$acquire_args" 420000)
printf '%s\n' "$result" | jq -e '.ok == true and .lease.capabilityId == "ios-simulator"' >/dev/null
lease_acquired=yes
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
    cleanup
    exit 0
  fi
  sleep 2
done
exit 1
