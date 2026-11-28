#!/usr/bin/env bash
# Single repo-owned Companion iOS live smoke entrypoint.
#
# Starts an isolated private gateway (native-stream-stack.mts) and isolated Metro
# bundler on unused loopback ports, prepares and pairs the installed Companion dev
# client on the selected iOS simulator, runs the requested recipe (default:
# native-conversation.recipe.json), retains before/after service and simulator
# state receipts, and guarantees full teardown via trap on success, failure, or signal.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
REPO_ROOT="$(cd "${APP_DIR}/../.." && pwd)"

SIMULATOR_INPUT="${IOS_SIMULATOR:-${SIMULATOR:-}}"
ARTIFACTS_DIR=""
RECIPE_INPUT="apps/companion/scripts/agentic/recipe/recipes/native-conversation.recipe.json"
RUNNER="${NATIVE_COMPANION_RUNNER:-codex}"
MODEL="${NATIVE_COMPANION_MODEL:-gpt-6-astra}"
BUNDLE_ID="${BUNDLE_ID:-net.siteed.farmslot.development}"
SCHEME="${SCHEME:-farmslot-development}"
GATEWAY_PORT_INPUT=""
CONTROL_PORT_INPUT=""
METRO_PORT_INPUT=""
SKIP_SETUP=0
METRO_READY_TIMEOUT_SECS="${METRO_READY_TIMEOUT_SECS:-120}"
GATEWAY_READY_TIMEOUT_SECS="${GATEWAY_READY_TIMEOUT_SECS:-60}"

usage() {
  cat <<'EOF'
Usage: companion-ios-smoke.sh --simulator <udid-or-name> --artifacts-dir <dir> [options]

Options:
  --simulator <udid-or-name>   Target iOS simulator UDID or exact name (or set IOS_SIMULATOR)
  --artifacts-dir <dir>        Directory for retained receipt, logs, and recipe artifacts
  --recipe <path>              Recipe JSON path (default: native-conversation.recipe.json)
  --runner <name>              Native runner for gateway/setup (default: codex)
  --model <name>               Model for native setup (default: gpt-6-astra)
  --gateway-port <port>        Explicit unused loopback port for private gateway
  --control-port <port>        Explicit unused loopback port for gateway control API
  --metro-port <port>          Explicit unused loopback port for private Metro bundler
  --bundle-id <id>             Installed iOS app bundle ID (default: net.siteed.farmslot.development)
  --scheme <scheme>            App URL scheme (default: farmslot-development)
  --skip-setup                 Skip native-conversation-proof.mts setup phase
  -h, --help                   Show this help
EOF
}

require_value() {
  local opt="$1"
  local val="${2:-}"
  if [[ -z "${val}" || "${val}" == --* ]]; then
    echo "ERROR: ${opt} requires a value." >&2
    exit 1
  fi
  printf '%s' "${val}"
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --simulator)
      SIMULATOR_INPUT="$(require_value "$1" "${2:-}")"; shift 2 ;;
    --simulator=*)
      SIMULATOR_INPUT="${1#*=}"; shift ;;
    --artifacts-dir)
      ARTIFACTS_DIR="$(require_value "$1" "${2:-}")"; shift 2 ;;
    --artifacts-dir=*)
      ARTIFACTS_DIR="${1#*=}"; shift ;;
    --recipe)
      RECIPE_INPUT="$(require_value "$1" "${2:-}")"; shift 2 ;;
    --recipe=*)
      RECIPE_INPUT="${1#*=}"; shift ;;
    --runner)
      RUNNER="$(require_value "$1" "${2:-}")"; shift 2 ;;
    --runner=*)
      RUNNER="${1#*=}"; shift ;;
    --model)
      MODEL="$(require_value "$1" "${2:-}")"; shift 2 ;;
    --model=*)
      MODEL="${1#*=}"; shift ;;
    --gateway-port)
      GATEWAY_PORT_INPUT="$(require_value "$1" "${2:-}")"; shift 2 ;;
    --gateway-port=*)
      GATEWAY_PORT_INPUT="${1#*=}"; shift ;;
    --control-port)
      CONTROL_PORT_INPUT="$(require_value "$1" "${2:-}")"; shift 2 ;;
    --control-port=*)
      CONTROL_PORT_INPUT="${1#*=}"; shift ;;
    --metro-port)
      METRO_PORT_INPUT="$(require_value "$1" "${2:-}")"; shift 2 ;;
    --metro-port=*)
      METRO_PORT_INPUT="${1#*=}"; shift ;;
    --bundle-id)
      BUNDLE_ID="$(require_value "$1" "${2:-}")"; shift 2 ;;
    --bundle-id=*)
      BUNDLE_ID="${1#*=}"; shift ;;
    --scheme)
      SCHEME="$(require_value "$1" "${2:-}")"; shift 2 ;;
    --scheme=*)
      SCHEME="${1#*=}"; shift ;;
    --skip-setup)
      SKIP_SETUP=1; shift ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      echo "ERROR: unknown option '$1'." >&2
      usage >&2
      exit 1 ;;
  esac
done

if [[ -z "${SIMULATOR_INPUT}" ]]; then
  echo "ERROR: --simulator (or IOS_SIMULATOR) is required." >&2
  exit 1
fi
if [[ -z "${ARTIFACTS_DIR}" ]]; then
  echo "ERROR: --artifacts-dir is required." >&2
  exit 1
fi

# Resolve recipe path relative to repo root, app dir, or current directory.
resolve_recipe_path() {
  local raw="$1"
  if [[ -f "${raw}" ]]; then
    node -e 'const path=require("node:path"); process.stdout.write(path.resolve(process.argv[1]));' "${raw}"
  elif [[ -f "${REPO_ROOT}/${raw}" ]]; then
    node -e 'const path=require("node:path"); process.stdout.write(path.resolve(process.argv[1]));' "${REPO_ROOT}/${raw}"
  elif [[ -f "${APP_DIR}/${raw}" ]]; then
    node -e 'const path=require("node:path"); process.stdout.write(path.resolve(process.argv[1]));' "${APP_DIR}/${raw}"
  else
    echo "ERROR: recipe not found: ${raw}" >&2
    exit 1
  fi
}

RECIPE_ABS="$(resolve_recipe_path "${RECIPE_INPUT}")"
mkdir -p "${ARTIFACTS_DIR}"
ARTIFACTS_ABS="$(cd "${ARTIFACTS_DIR}" && pwd)"

# Allocate three distinct unused loopback ports unless explicitly provided.
allocate_ports() {
  node -e '
    const net = require("node:net");
    const requested = process.argv.slice(1).map((v) => (v ? Number(v) : 0));
    const servers = [];
    const bindOne = (port) =>
      new Promise((resolve, reject) => {
        const s = net.createServer();
        s.once("error", reject);
        s.listen(port, "127.0.0.1", () => {
          const addr = s.address();
          servers.push(s);
          resolve(addr.port);
        });
      });
    (async () => {
      try {
        const ports = [];
        for (const p of requested) {
          if (p !== 0 && (!Number.isInteger(p) || p < 1 || p > 65535)) {
            throw new Error(`Invalid port: ${p}`);
          }
          ports.push(await bindOne(p));
        }
        if (new Set(ports).size !== ports.length) {
          throw new Error(`Allocated ports collided: ${ports.join(",")}`);
        }
        await Promise.all(servers.map((s) => new Promise((r) => s.close(() => r()))));
        process.stdout.write(ports.join(" ") + "\n");
      } catch (err) {
        await Promise.all(servers.map((s) => new Promise((r) => s.close(() => r()))));
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    })();
  ' "${GATEWAY_PORT_INPUT}" "${CONTROL_PORT_INPUT}" "${METRO_PORT_INPUT}"
}

read -r SMOKE_GATEWAY_PORT SMOKE_CONTROL_PORT SMOKE_METRO_PORT < <(allocate_ports)

# Resolve simulator target to exact UDID, name, and pre-existing state.
read -r SIM_UDID SIM_STATE_BEFORE SIM_NAME < <(
  node -e '
    const { execFileSync } = require("node:child_process");
    const target = process.argv[1];
    const data = JSON.parse(execFileSync("xcrun", ["simctl", "list", "devices", "-j"], { encoding: "utf8" }));
    const matches = [];
    for (const devices of Object.values(data.devices || {})) {
      for (const dev of devices) {
        if (dev.isAvailable === false) continue;
        if (dev.udid === target || dev.name === target) matches.push(dev);
      }
    }
    if (matches.length === 0) {
      console.error(`Simulator not found: ${target}`);
      process.exit(1);
    }
    if (matches.length > 1) {
      console.error(`Simulator target "${target}" is ambiguous (${matches.length} matches); pass exact UDID.`);
      process.exit(1);
    }
    const dev = matches[0];
    process.stdout.write(`${dev.udid}\t${dev.state}\t${dev.name}\n`);
  ' "${SIMULATOR_INPUT}"
)

# Discover pre-existing slot/operator ports (if any) from .env.ports and companion .agent/metro-*.env
# so before/after snapshots prove pre-existing gateway and Metro listeners remain untouched across pass and failure.
PREEXISTING_PORTS_CSV="$(
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const ports = new Set([7777]);
    const envPorts = path.join(process.argv[1], ".env.ports");
    if (fs.existsSync(envPorts)) {
      for (const line of fs.readFileSync(envPorts, "utf8").split(/\r?\n/)) {
        const m = /^(?:GATEWAY_PORT|WATCHER_PORT|METRO_PORT|VITE_PORT|CDP_PORT)=(\d+)$/.exec(line.trim());
        if (m) ports.add(Number(m[1]));
      }
    }
    const agentDir = path.join(process.argv[2], ".agent");
    if (fs.existsSync(agentDir)) {
      for (const name of fs.readdirSync(agentDir)) {
        const m = /^metro-(\d+)\.env$/.exec(name);
        if (m) ports.add(Number(m[1]));
      }
    }
    process.stdout.write([...ports].sort((a, b) => a - b).join(","));
  ' "${REPO_ROOT}" "${APP_DIR}"
)"

capture_state_json() {
  local out_file="$1"
  node -e '
    const { execFileSync, spawnSync } = require("node:child_process");
    const fs = require("node:fs");
    const [outFile, simUdid, gwPort, ctrlPort, metroPort, prePortsCsv] = process.argv.slice(1);
    const lsofPids = (port) => {
      const r = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
      if (r.status !== 0 || !r.stdout.trim()) return [];
      return [...new Set(r.stdout.trim().split(/\r?\n/).map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
    };
    const simList = JSON.parse(execFileSync("xcrun", ["simctl", "list", "devices", "-j"], { encoding: "utf8" }));
    let targetSim = null;
    const bootedSimulators = [];
    for (const devices of Object.values(simList.devices || {})) {
      for (const dev of devices) {
        if (dev.isAvailable === false) continue;
        if (dev.udid === simUdid) {
          targetSim = { udid: dev.udid, name: dev.name, state: dev.state };
        }
        if (dev.state === "Booted") {
          bootedSimulators.push({ udid: dev.udid, name: dev.name });
        }
      }
    }
    bootedSimulators.sort((a, b) => a.udid.localeCompare(b.udid));
    const portInfo = (portStr) => {
      const port = Number(portStr);
      const pids = lsofPids(port);
      return { port, listening: pids.length > 0, pids };
    };
    const preExistingListeners = {};
    for (const p of prePortsCsv.split(",").filter(Boolean)) {
      const info = portInfo(p);
      if (info.listening) preExistingListeners[String(info.port)] = info.pids;
    }
    const snapshot = {
      capturedAt: new Date().toISOString(),
      simulator: targetSim,
      bootedSimulators,
      ports: {
        gateway: portInfo(gwPort),
        control: portInfo(ctrlPort),
        metro: portInfo(metroPort),
      },
      preExistingListeners,
    };
    fs.writeFileSync(outFile, JSON.stringify(snapshot, null, 2) + "\n");
  ' "${out_file}" "${SIM_UDID}" "${SMOKE_GATEWAY_PORT}" "${SMOKE_CONTROL_PORT}" "${SMOKE_METRO_PORT}" "${PREEXISTING_PORTS_CSV}"
}

BEFORE_STATE_FILE="${ARTIFACTS_ABS}/before-state.json"
AFTER_STATE_FILE="${ARTIFACTS_ABS}/after-state.json"
RECEIPT_FILE="${ARTIFACTS_ABS}/smoke-receipt.json"
GATEWAY_LOG="${ARTIFACTS_ABS}/gateway.log"
METRO_LOG="${ARTIFACTS_ABS}/metro.log"
RECIPE_ARTIFACTS_DIR="${ARTIFACTS_ABS}/recipe"

capture_state_json "${BEFORE_STATE_FILE}"

# Verify our chosen ports are completely unused before starting anything.
node -e '
  const fs = require("node:fs");
  const before = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  for (const [label, info] of Object.entries(before.ports)) {
    if (info.listening) {
      throw new Error(`Smoke ${label} port ${info.port} is already in use by PIDs ${info.pids.join(",")}`);
    }
  }
' "${BEFORE_STATE_FILE}"

SCRATCH_DIR="$(mktemp -d "${TMPDIR:-/tmp}/companion-ios-smoke-XXXXXX")"
TOKEN_FILE="${SCRATCH_DIR}/token"
STREAM_STATE_FILE="${SCRATCH_DIR}/stream-state.json"
PROOF_STATE_FILE="${SCRATCH_DIR}/proof-state.json"
AGENT_DEVICE_STATE_DIR="${SCRATCH_DIR}/agent-device"

GATEWAY_PID=""
METRO_PID=""
BOOTED_SIMULATOR=0
CLEANUP_DONE=0
RECIPE_RAN=0
RECIPE_EXIT=1
EXIT_SIGNAL=""

pid_alive() {
  local pid="$1"
  [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null
}

wait_pid_exit() {
  local pid="$1"
  local max_tenths="$2"
  local i=0
  while (( i < max_tenths )) && pid_alive "${pid}"; do
    sleep 0.1
    i=$((i + 1))
  done
  ! pid_alive "${pid}"
}

port_listening() {
  local port="$1"
  lsof -nP -iTCP:"${port}" -sTCP:LISTEN -t >/dev/null 2>&1
}

cleanup() {
  local exit_code=$?
  if [[ "${CLEANUP_DONE}" -eq 1 ]]; then
    return
  fi
  CLEANUP_DONE=1
  set +e

  local teardown_errors=()

  # 1. Close any agent-device sessions owned by this isolated state dir and wait for daemon exit.
  if [[ -f "${AGENT_DEVICE_STATE_DIR}/daemon.json" ]]; then
    (
      cd "${APP_DIR}"
      node --input-type=module -e '
        import fs from "node:fs";
        import path from "node:path";
        import { createAgentDeviceClient } from "agent-device";
        const stateDir = process.argv[1];
        const client = createAgentDeviceClient({ stateDir });
        try {
          for (const session of await client.sessions.list()) {
            await client.sessions.close({ session: session.name, shutdown: false });
          }
        } catch (err) {
          console.error("[companion-ios-smoke] agent-device close warning:", err instanceof Error ? err.message : String(err));
        }
        const daemonFile = path.join(stateDir, "daemon.json");
        if (fs.existsSync(daemonFile)) {
          const pid = JSON.parse(fs.readFileSync(daemonFile, "utf8")).pid;
          const deadline = Date.now() + 15000;
          while (Date.now() < deadline) {
            try { process.kill(pid, 0); } catch (e) { if (e.code === "ESRCH") break; }
            await new Promise((r) => setTimeout(r, 150));
          }
          try { process.kill(pid, "SIGTERM"); } catch (e) { if (e.code !== "ESRCH") throw e; }
        }
      ' "${AGENT_DEVICE_STATE_DIR}"
    ) >/dev/null 2>&1 || teardown_errors+=("agent-device cleanup failed")
  fi

  # 2. Best-effort close any still-open native proof session before stopping private gateway.
  if [[ -f "${PROOF_STATE_FILE}" ]] && port_listening "${SMOKE_GATEWAY_PORT}" && [[ -f "${TOKEN_FILE}" ]]; then
    (
      cd "${APP_DIR}"
      NATIVE_COMPANION_GATEWAY="ws://127.0.0.1:${SMOKE_GATEWAY_PORT}/ws" \
      NATIVE_COMPANION_TOKEN_FILE="${TOKEN_FILE}" \
      NATIVE_COMPANION_PROOF_STATE="${PROOF_STATE_FILE}" \
      IOS_SIMULATOR="${SIM_UDID}" \
      FARMSLOT_AGENT_DEVICE_STATE_DIR="${AGENT_DEVICE_STATE_DIR}" \
      yarn exec tsx scripts/agentic/native-conversation-proof.mts cleanup >/dev/null 2>&1
    ) || true
  fi

  # 3. Stop only our private gateway (POST /shutdown first, then SIGTERM/SIGKILL fallback).
  if [[ -n "${GATEWAY_PID}" ]]; then
    if port_listening "${SMOKE_CONTROL_PORT}"; then
      curl -sf --max-time 10 -X POST "http://127.0.0.1:${SMOKE_CONTROL_PORT}/shutdown" >/dev/null 2>&1 || true
    fi
    if ! wait_pid_exit "${GATEWAY_PID}" 150; then
      kill -TERM "${GATEWAY_PID}" 2>/dev/null || true
      if ! wait_pid_exit "${GATEWAY_PID}" 50; then
        kill -KILL "${GATEWAY_PID}" 2>/dev/null || true
        wait_pid_exit "${GATEWAY_PID}" 20 || true
      fi
    fi
    wait "${GATEWAY_PID}" 2>/dev/null || true
  fi

  # 4. Stop only our private Metro process group.
  if [[ -n "${METRO_PID}" ]]; then
    kill -TERM -- "-${METRO_PID}" 2>/dev/null || kill -TERM "${METRO_PID}" 2>/dev/null || true
    if ! wait_pid_exit "${METRO_PID}" 80; then
      kill -KILL -- "-${METRO_PID}" 2>/dev/null || kill -KILL "${METRO_PID}" 2>/dev/null || true
      wait_pid_exit "${METRO_PID}" 20 || true
    fi
    wait "${METRO_PID}" 2>/dev/null || true
  fi

  # Wait briefly for sockets to release after process exit.
  local sock_wait=0
  while (( sock_wait < 50 )) && (port_listening "${SMOKE_GATEWAY_PORT}" || port_listening "${SMOKE_CONTROL_PORT}" || port_listening "${SMOKE_METRO_PORT}"); do
    sleep 0.1
    sock_wait=$((sock_wait + 1))
  done

  # 5. Restore simulator state: shut down ONLY if this run booted it.
  if [[ "${BOOTED_SIMULATOR}" -eq 1 ]]; then
    xcrun simctl shutdown "${SIM_UDID}" >/dev/null 2>&1 || true
    local sim_wait=0
    while (( sim_wait < 100 )); do
      local st
      st="$(xcrun simctl list devices -j | node -e 'const fs=require("node:fs"); const d=JSON.parse(fs.readFileSync(0,"utf8")); for(const arr of Object.values(d.devices||{})){ for(const s of arr){ if(s.udid===process.argv[1]){ process.stdout.write(s.state); process.exit(0); } } }' "${SIM_UDID}")"
      if [[ "${st}" == "Shutdown" ]]; then
        break
      fi
      sleep 0.2
      sim_wait=$((sim_wait + 1))
    done
  fi

  # 6. Remove private scratch directory (credentials + transient state).
  rm -rf "${SCRATCH_DIR}"

  # 7. Capture after-state and write smoke-receipt.json.
  capture_state_json "${AFTER_STATE_FILE}"

  local gateway_alive=0
  local metro_alive=0
  pid_alive "${GATEWAY_PID}" && gateway_alive=1
  pid_alive "${METRO_PID}" && metro_alive=1

  local err_joined=""
  if (( ${#teardown_errors[@]} > 0 )); then
    err_joined="$(printf '%s\n' "${teardown_errors[@]}")"
  fi

  local final_status="fail"
  if [[ "${exit_code}" -eq 0 && "${RECIPE_RAN}" -eq 1 && "${RECIPE_EXIT}" -eq 0 ]]; then
    final_status="pass"
  fi

  local teardown_ok=0
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const [
      beforePath,
      afterPath,
      receiptPath,
      status,
      exitCodeStr,
      recipeExitStr,
      recipePath,
      recipeArtifactsDir,
      simUdid,
      simName,
      bootedStr,
      gwAliveStr,
      metroAliveStr,
      exitSignal,
      errText,
    ] = process.argv.slice(1);
    const before = JSON.parse(fs.readFileSync(beforePath, "utf8"));
    const after = JSON.parse(fs.readFileSync(afterPath, "utf8"));
    const errors = errText ? errText.split(/\r?\n/).filter(Boolean) : [];
    const gatewayStopped = !after.ports.gateway.listening && gwAliveStr === "0";
    const controlStopped = !after.ports.control.listening;
    const metroStopped = !after.ports.metro.listening && metroAliveStr === "0";
    const simulatorStateMatched = Boolean(before.simulator && after.simulator && before.simulator.state === after.simulator.state);
    const preExistingListenersPreserved = Object.entries(before.preExistingListeners || {}).every(
      ([port, pids]) => JSON.stringify(after.preExistingListeners?.[port] ?? []) === JSON.stringify(pids),
    );
    const clean =
      gatewayStopped &&
      controlStopped &&
      metroStopped &&
      simulatorStateMatched &&
      preExistingListenersPreserved &&
      errors.length === 0;
    const summaryPath = path.join(recipeArtifactsDir, "summary.json");
    const receipt = {
      status: status === "pass" && clean ? "pass" : "fail",
      exitCode: Number(exitCodeStr),
      recipeExitCode: Number(recipeExitStr),
      exitSignal: exitSignal || null,
      recipe: recipePath,
      recipeArtifactsDir,
      recipeSummaryPath: fs.existsSync(summaryPath) ? summaryPath : null,
      simulator: {
        udid: simUdid,
        name: simName,
        stateBefore: before.simulator?.state ?? null,
        stateAfter: after.simulator?.state ?? null,
        bootedBySmoke: bootedStr === "1",
        preserved: simulatorStateMatched,
      },
      ports: {
        gateway: before.ports.gateway.port,
        control: before.ports.control.port,
        metro: before.ports.metro.port,
      },
      before,
      after,
      teardown: {
        clean,
        gatewayStopped,
        controlStopped,
        metroStopped,
        simulatorStateMatched,
        preExistingListenersPreserved,
        errors,
      },
    };
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
    process.stdout.write(JSON.stringify({ receipt: receiptPath, status: receipt.status, teardown: receipt.teardown }) + "\n");
    if (!clean) process.exit(2);
  ' "${BEFORE_STATE_FILE}" "${AFTER_STATE_FILE}" "${RECEIPT_FILE}" "${final_status}" "${exit_code}" "${RECIPE_EXIT}" "${RECIPE_ABS}" "${RECIPE_ARTIFACTS_DIR}" "${SIM_UDID}" "${SIM_NAME}" "${BOOTED_SIMULATOR}" "${gateway_alive}" "${metro_alive}" "${EXIT_SIGNAL}" "${err_joined}" && teardown_ok=1

  if [[ "${exit_code}" -ne 0 ]]; then
    exit "${exit_code}"
  fi
  if [[ "${teardown_ok}" -ne 1 ]]; then
    exit 1
  fi
}

trap cleanup EXIT
trap 'EXIT_SIGNAL=INT; exit 130' INT
trap 'EXIT_SIGNAL=TERM; exit 143' TERM
trap 'EXIT_SIGNAL=HUP; exit 129' HUP

# Boot simulator only if it was Shutdown.
if [[ "${SIM_STATE_BEFORE}" != "Booted" ]]; then
  echo "[companion-ios-smoke] booting isolated simulator ${SIM_NAME} (${SIM_UDID})"
  xcrun simctl boot "${SIM_UDID}"
  BOOTED_SIMULATOR=1
  xcrun simctl bootstatus "${SIM_UDID}" -b
fi

# Confirm Companion dev client is installed on the target simulator before starting services.
if ! xcrun simctl listapps "${SIM_UDID}" | grep -q "\"${BUNDLE_ID}\""; then
  echo "ERROR: ${BUNDLE_ID} is not installed on simulator ${SIM_NAME} (${SIM_UDID})." >&2
  exit 1
fi

echo "[companion-ios-smoke] starting isolated gateway :${SMOKE_GATEWAY_PORT} (control :${SMOKE_CONTROL_PORT}, runner=${RUNNER})"
(
  cd "${REPO_ROOT}"
  exec env \
    TSX_TSCONFIG_PATH="${REPO_ROOT}/services/gateway/tsconfig.json" \
    GATEWAY_PORT="${SMOKE_GATEWAY_PORT}" \
    CONTROL_PORT="${SMOKE_CONTROL_PORT}" \
    NATIVE_STREAM_RUNNER="${RUNNER}" \
    NATIVE_STREAM_FIXTURE="none" \
    NATIVE_STREAM_TOKEN_FILE="${TOKEN_FILE}" \
    node --import tsx "${SCRIPT_DIR}/native-stream-stack.mts"
) >"${GATEWAY_LOG}" 2>&1 &
GATEWAY_PID=$!

gw_waited=0
while (( gw_waited < GATEWAY_READY_TIMEOUT_SECS * 5 )); do
  if ! pid_alive "${GATEWAY_PID}"; then
    echo "ERROR: isolated gateway exited during startup:" >&2
    cat "${GATEWAY_LOG}" >&2 || true
    exit 1
  fi
  if [[ -s "${TOKEN_FILE}" ]] && curl -sf "http://127.0.0.1:${SMOKE_GATEWAY_PORT}/health" >/dev/null 2>&1 && grep -q '"ready":true' "${GATEWAY_LOG}" 2>/dev/null; then
    break
  fi
  sleep 0.2
  gw_waited=$((gw_waited + 1))
done
if ! grep -q '"ready":true' "${GATEWAY_LOG}" 2>/dev/null; then
  echo "ERROR: isolated gateway did not become ready within ${GATEWAY_READY_TIMEOUT_SECS}s:" >&2
  cat "${GATEWAY_LOG}" >&2 || true
  exit 1
fi

echo "[companion-ios-smoke] starting isolated Metro :${SMOKE_METRO_PORT}"
(
  cd "${APP_DIR}"
  exec perl -MPOSIX -e 'POSIX::setsid() or die $!; exec @ARGV or die $!' \
    env -u CI \
    APP_VARIANT=development \
    METRO_PORT="${SMOKE_METRO_PORT}" \
    GATEWAY_PORT="${SMOKE_GATEWAY_PORT}" \
    EXPO_PUBLIC_GATEWAY_URL="ws://127.0.0.1:${SMOKE_GATEWAY_PORT}/ws" \
    EXPO_PUBLIC_FARMSLOT_RECIPE_BRIDGE=1 \
    EXPO_PUBLIC_FARMSLOT_PREPARED=1 \
    REACT_NATIVE_PACKAGER_HOSTNAME=localhost \
    yarn expo start --dev-client --port "${SMOKE_METRO_PORT}" --localhost
) >"${METRO_LOG}" 2>&1 &
METRO_PID=$!

metro_waited=0
while (( metro_waited < METRO_READY_TIMEOUT_SECS * 2 )); do
  if ! pid_alive "${METRO_PID}"; then
    echo "ERROR: isolated Metro exited during startup:" >&2
    tail -n 40 "${METRO_LOG}" >&2 || true
    exit 1
  fi
  if curl -sf "http://127.0.0.1:${SMOKE_METRO_PORT}/status" 2>/dev/null | grep -q "packager-status:running"; then
    break
  fi
  sleep 0.5
  metro_waited=$((metro_waited + 1))
done
if ! curl -sf "http://127.0.0.1:${SMOKE_METRO_PORT}/status" 2>/dev/null | grep -q "packager-status:running"; then
  echo "ERROR: isolated Metro did not become ready on :${SMOKE_METRO_PORT} within ${METRO_READY_TIMEOUT_SECS}s:" >&2
  tail -n 40 "${METRO_LOG}" >&2 || true
  exit 1
fi

echo "[companion-ios-smoke] launching dev client on ${SIM_NAME} (${SIM_UDID}) against Metro :${SMOKE_METRO_PORT}"
METRO_PORT="${SMOKE_METRO_PORT}" \
GATEWAY_PORT="${SMOKE_GATEWAY_PORT}" \
SCHEME="${SCHEME}" \
BUNDLE_ID="${BUNDLE_ID}" \
COMPANION_PACKAGER_HOSTNAME=localhost \
  node "${SCRIPT_DIR}/prepare-dev-client.mjs" ios "${SIM_UDID}" "${BUNDLE_ID}"

(
  cd "${APP_DIR}"
  METRO_PORT="${SMOKE_METRO_PORT}" \
  IOS_SIMULATOR="${SIM_UDID}" \
  COMPANION_PACKAGER_HOSTNAME=localhost \
  FARMSLOT_RECIPE_ARTIFACTS_DIR="${ARTIFACTS_ABS}" \
    node --input-type=module -e '
      import { waitForSimulatorRecipeBridge } from "./scripts/agentic/simulator-dev-client.mjs";
      await waitForSimulatorRecipeBridge({ platform: "ios" });
    '
)

echo "[companion-ios-smoke] pairing Companion with isolated gateway :${SMOKE_GATEWAY_PORT}"
(
  cd "${APP_DIR}"
  NATIVE_STREAM_CONTROL="http://127.0.0.1:${SMOKE_CONTROL_PORT}" \
  NATIVE_STREAM_STATE="${STREAM_STATE_FILE}" \
  METRO_PORT="${SMOKE_METRO_PORT}" \
  PLATFORM=ios \
  IOS_SIMULATOR="${SIM_UDID}" \
  FARMSLOT_AGENT_DEVICE_STATE_DIR="${AGENT_DEVICE_STATE_DIR}" \
  FARMSLOT_RECIPE_APP_ID="${BUNDLE_ID}" \
    node "${SCRIPT_DIR}/native-stream-proof.mjs" pair
)

if [[ "${SKIP_SETUP}" -eq 0 ]] && grep -q "native-conversation-proof.mts" "${RECIPE_ABS}"; then
  echo "[companion-ios-smoke] running native-conversation-proof.mts setup"
  (
    cd "${APP_DIR}"
    NATIVE_COMPANION_GATEWAY="ws://127.0.0.1:${SMOKE_GATEWAY_PORT}/ws" \
    NATIVE_COMPANION_TOKEN_FILE="${TOKEN_FILE}" \
    NATIVE_COMPANION_PROOF_STATE="${PROOF_STATE_FILE}" \
    NATIVE_COMPANION_RUNNER="${RUNNER}" \
    NATIVE_COMPANION_MODEL="${MODEL}" \
    IOS_SIMULATOR="${SIM_UDID}" \
    FARMSLOT_AGENT_DEVICE_STATE_DIR="${AGENT_DEVICE_STATE_DIR}" \
      yarn exec tsx scripts/agentic/native-conversation-proof.mts setup
  )
fi

echo "[companion-ios-smoke] running recipe ${RECIPE_ABS}"
RECIPE_RAN=1
set +e
(
  cd "${APP_DIR}"
  unset FARMSLOT_SLOT_ID
  unset RECIPE_TASK_DIR
  PLATFORM=ios \
  IOS_SIMULATOR="${SIM_UDID}" \
  SIMULATOR="${SIM_UDID}" \
  METRO_PORT="${SMOKE_METRO_PORT}" \
  GATEWAY_PORT="${SMOKE_GATEWAY_PORT}" \
  SCHEME="${SCHEME}" \
  BUNDLE_ID="${BUNDLE_ID}" \
  FARMSLOT_RECIPE_APP_ID="${BUNDLE_ID}" \
  FARMSLOT_AGENT_DEVICE_STATE_DIR="${AGENT_DEVICE_STATE_DIR}" \
  NATIVE_COMPANION_GATEWAY="ws://127.0.0.1:${SMOKE_GATEWAY_PORT}/ws" \
  NATIVE_COMPANION_TOKEN_FILE="${TOKEN_FILE}" \
  NATIVE_COMPANION_PROOF_STATE="${PROOF_STATE_FILE}" \
  NATIVE_COMPANION_RUNNER="${RUNNER}" \
  NATIVE_COMPANION_MODEL="${MODEL}" \
  PATH="${REPO_ROOT}/node_modules/.bin:${APP_DIR}/node_modules/.bin:${PATH}" \
    bash "${SCRIPT_DIR}/run-recipe.sh" run "${RECIPE_ABS}" \
      --artifacts-dir "${RECIPE_ARTIFACTS_DIR}" \
      --record-video=off \
      "--recording-reason=Companion iOS live smoke retains per-step simulator screenshots and protocol receipts."
)
RECIPE_EXIT=$?
set -e

exit "${RECIPE_EXIT}"
