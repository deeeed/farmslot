#!/usr/bin/env bash
# Lifecycle router for a MetaMask tooling slot. The slot checkout is the
# tooling repository under edit. Mobile live proof uses this slot's own sibling
# Mobile checkout, simulator and Metro port, driven by the published harness
# package. Mutable tooling under test never marks tasks or manages runtimes.
#
# This file is shared byte-for-byte by every project in the metamask-tooling
# pack; a pack test enforces that.
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage: tooling.sh <command> <kind> <repo> [args...]
  kind: harness | recipe-perps
  prerequisites <kind> <repo> <mobile-repo>   Read-only path and tool checks
  install       <kind> <repo>                 Install locked tooling dependencies
  ready         <kind> <repo>                 Tooling readiness; prints "ready"
  published     <kind> <repo>                 Print the published harness executable
  candidate     <kind> <repo>                 Print the explicit after-fix selection
  mobile-deps    <kind> <repo> <mobile-repo>  Mobile's own minimal JS setup
  mobile-client  <kind> <repo> <mobile-repo> <port> <simulator> <slot>
  mobile-fixture <kind> <repo> <mobile-repo> <fixture> <slot>
  mobile-boot    <kind> <repo> <mobile-repo> <port> <simulator> <slot> <farmslot-dir>
  mobile-health  <kind> <repo> <mobile-repo> <port> <simulator>
  mobile-stop    <kind> <repo> <mobile-repo> <port> <simulator> <slot>
USAGE
  exit 2
}

[ "$#" -ge 3 ] || usage
command="$1"; kind="$2"; repo="$3"; shift 3
case "$kind" in harness|recipe-perps) ;; *) usage ;; esac
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
case "$kind" in
  harness) project=metamask-harness-farm ;;
  recipe-perps) project=metamask-recipe-perps-farm ;;
esac
# The harness default runtime directory, ignored by Mobile's own .gitignore.
mobile_runtime_dir=temp/recipe/runtime

fail() {
  echo "metamask-tooling: $1" >&2
  if [ -n "${2:-}" ]; then echo "Next: $2" >&2; fi
  exit 1
}

# Both repositories declare Node 22 in CI. The pool's FARMSLOT_NODE22_BIN selects
# it for this process without changing machine defaults.
activate_node() {
  local bin="${FARMSLOT_NODE22_BIN:-}"
  if [ -n "$bin" ]; then
    [ -x "$bin/node" ] || fail "FARMSLOT_NODE22_BIN does not contain node" \
      "set FARMSLOT_NODE22_BIN in the pool env to an installed Node 22 bin directory"
    PATH="$bin:$PATH"
    export PATH
  fi
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')" \
    || fail "node is unavailable" "set FARMSLOT_NODE22_BIN in the pool env"
  [ "$major" = 22 ] || fail "Node 22 is required, found $(node -v)" \
    "set FARMSLOT_NODE22_BIN in the pool env to an installed Node 22 bin directory"
}

require_repo() {
  [ -d "$repo/.git" ] || fail "tooling checkout not found at $repo" \
    "farmslot project add clones it before setup"
  repo="$(cd "$repo" && pwd -P)"
}

published_harness() {
  node "$script_dir/resolve-harness.mjs" --published "$repo"
}

# An unexpanded or empty value means the slot has no owned Mobile checkout.
# Refuse instead of falling back to a shared product slot.
require_mobile() {
  local mobile="${1:-}"
  case "$mobile" in
    "" | *"{{"*) fail "this slot has no owned Mobile checkout" \
      "declare reference_repos.mobile.local_name and clone MetaMask/metamask-mobile beside the slot checkout" ;;
  esac
  [ -f "$mobile/package.json" ] || fail "owned Mobile checkout is missing: $mobile" \
    "git clone git@github.com:MetaMask/metamask-mobile.git $mobile, then run its yarn setup"
  node -e 'const m=require(process.argv[1]); if (m.name !== "metamask") process.exit(1)' \
    "$mobile/package.json" || fail "$mobile is not a MetaMask Mobile checkout"
  local real
  real="$(cd "$mobile" && pwd -P)"
  [ "$real" != "$repo" ] || fail "the Mobile checkout must not be the tooling checkout"
  printf '%s' "$real"
}

# A pack may declare several slots per project, and they all resolve the same
# sibling local_name. The first slot that uses a Mobile checkout records itself
# as its owner in the checkout's ignored runtime directory; any other slot is
# refused instead of sharing Metro, simulator context or wallet state.
claim_mobile() {
  local mobile="$1" slot="$2" owner_file owner
  case "$slot" in "" | *"{{"*) fail "this slot has no slot id" ;; esac
  owner_file="$mobile/$mobile_runtime_dir/farmslot-owner"
  if [ -f "$owner_file" ]; then
    owner="$(cat "$owner_file")"
    [ "$owner" = "$project/$slot" ] || fail "Mobile checkout $mobile is owned by $owner" \
      "give $slot its own Mobile checkout; slots never share one"
    return 0
  fi
  mkdir -p "$mobile/$mobile_runtime_dir"
  printf '%s\n' "$project/$slot" > "$owner_file"
}

require_simulator() {
  case "${1:-}" in
    "" | *"{{"*) fail "this slot has no simulator resource" \
      "give the slot its own ios-sim resource in the pool" ;;
  esac
}

case "$command" in
  prerequisites)
    require_repo
    activate_node
    published_harness >/dev/null
    if [ "$kind" = recipe-perps ]; then
      [ ! -f "$repo/package.json" ] || fail "recipe-perps unexpectedly declares package.json" \
        "review the pack before installing dependencies"
    fi
    # Live proof needs the owned Mobile checkout, but registration does not.
    if [ -n "${1:-}" ] && [ -e "${1:-}" ]; then require_mobile "$1" >/dev/null; fi
    echo "metamask-tooling $kind prerequisites ok"
    ;;
  install)
    require_repo
    activate_node
    if [ "$kind" = harness ]; then
      # node_modules files are hardlinked into Yarn's shared store. An immutable
      # install is the only writer; nothing here edits an installed file.
      (cd "$repo" && corepack yarn install --immutable)
    fi
    echo "metamask-tooling $kind dependencies ok"
    ;;
  ready)
    require_repo
    activate_node
    published_harness >/dev/null
    if [ "$kind" = harness ]; then
      [ -d "$repo/node_modules/@farmslot/protocol" ] || fail "harness dependencies are not installed" \
        "prepare the slot so post_merge_install runs yarn install --immutable"
    else
      [ -f "$repo/recipe-library.json" ] || fail "recipe-library.json is missing"
    fi
    echo ready
    ;;
  published)
    require_repo
    activate_node
    published_harness
    echo
    ;;
  candidate)
    require_repo
    if [ "$kind" = harness ]; then
      [ -x "$repo/bin/mm-harness" ] || fail "candidate harness entry is missing"
      printf 'MM_HARNESS_CANDIDATE=%s\n' "$repo/bin/mm-harness"
    else
      [ -f "$repo/recipe-library.json" ] || fail "candidate recipe library is missing"
      printf 'RECIPE_LIBRARY_CANDIDATE=perps=%s\n' "$repo"
    fi
    ;;
  mobile-deps)
    [ "$#" -ge 1 ] || usage
    require_repo
    mobile="$(require_mobile "$1")"
    # Mobile declares its own Node; MOBILE_NODE_BIN selects it for this process.
    [ -x "${MOBILE_NODE_BIN:-}/node" ] || fail "MOBILE_NODE_BIN does not contain node" \
      "set MOBILE_NODE_BIN in the pool env to the Node version Mobile declares"
    export PATH="$MOBILE_NODE_BIN:$PATH"
    cd "$mobile"
    LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 corepack yarn setup:expo
    ;;
  mobile-client)
    [ "$#" -ge 4 ] || usage
    require_repo
    activate_node
    mobile="$(require_mobile "$1")"; port="$2"; simulator="$3"; slot="$4"
    require_simulator "$simulator"
    claim_mobile "$mobile" "$slot"
    harness_bin="$(published_harness)"
    exec "$harness_bin" provision runway ios --adapter mobile --target "$mobile" --slot "$slot" \
      --device "$simulator" --watcher-port "$port" --runtime-dir "$mobile_runtime_dir" --json
    ;;
  mobile-fixture)
    [ "$#" -ge 3 ] || usage
    require_repo
    activate_node
    mobile="$(require_mobile "$1")"; fixture="$2"
    claim_mobile "$mobile" "$3"
    [ -f "$fixture" ] || fail "approved testnet wallet fixture not found: $fixture" \
      "copy fixtures/runtime/wallet-fixture.json.sample to fixtures/runtime/wallet-fixture.json in the registered project and fill the approved testnet wallet"
    harness_bin="$(published_harness)"
    exec "$harness_bin" fixtures init --from "$fixture" --force --adapter mobile --target "$mobile" --json
    ;;
  mobile-boot)
    [ "$#" -ge 5 ] || usage
    require_repo
    activate_node
    mobile="$(require_mobile "$1")"; port="$2"; simulator="$3"; slot="$4"; farmslot_dir="$5"
    require_simulator "$simulator"
    claim_mobile "$mobile" "$slot"
    harness_bin="$(published_harness)"
    # Record this slot's own port and simulator so every harness command in the
    # Mobile checkout targets them, then launch through the published harness.
    bash "$farmslot_dir/scripts/write-runtime-context.sh" --repo "$mobile" --project "$project" \
      --slot-id "$slot" --runtime-owner farmslot --platform ios --watcher-port "$port" \
      --metro-port "$port" --dev-server-port "$port" --simulator "$simulator" \
      --runtime-dir "$mobile_runtime_dir" --strict true
    export RECIPE_SLOT_ID="$slot" FARMSLOT_SLOT_ID="$slot" RECIPE_RUNTIME_DIR="$mobile_runtime_dir"
    exec "$harness_bin" launch ios --adapter mobile --target "$mobile" --watcher-port "$port" \
      --device "$simulator" --verify --json
    ;;
  mobile-health)
    [ "$#" -ge 3 ] || usage
    require_repo
    activate_node
    mobile="$(require_mobile "$1")"; port="$2"; simulator="$3"
    require_simulator "$simulator"
    harness_bin="$(published_harness)"
    exec "$harness_bin" doctor --adapter mobile --target "$mobile" --watcher-port "$port" \
      --runtime-dir "$mobile_runtime_dir" --device "$simulator" --print-ready
    ;;
  mobile-stop)
    [ "$#" -ge 3 ] || usage
    require_repo
    mobile_arg="$1"; port="$2"
    # Teardown of a slot that never received its Mobile checkout has nothing to stop.
    if [ -z "$mobile_arg" ] || [ ! -e "$mobile_arg" ]; then
      echo "metamask-tooling: no owned Mobile checkout to stop"
      exit 0
    fi
    activate_node
    mobile="$(require_mobile "$mobile_arg")"
    owner_file="$mobile/$mobile_runtime_dir/farmslot-owner"
    # Another slot's runtime is never this slot's to stop.
    if [ -f "$owner_file" ] && [ "$(cat "$owner_file")" != "$project/${4:-}" ]; then
      echo "metamask-tooling: $mobile is owned by $(cat "$owner_file"); nothing to stop for ${4:-this slot}"
      exit 0
    fi
    harness_bin="$(published_harness)"
    exec "$harness_bin" stop --adapter mobile --port "$port" --target "$mobile"
    ;;
  *) usage ;;
esac
