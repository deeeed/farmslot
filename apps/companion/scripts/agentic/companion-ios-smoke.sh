#!/usr/bin/env bash
# Single repo-owned Companion iOS live smoke entrypoint.
#
# Creates a dedicated ephemeral iOS simulator cloned from the reference simulator's
# device type, runtime, and installed Companion dev client bundle, starts an isolated
# private gateway (native-stream-stack.mts) and isolated Metro bundler on unused
# loopback ports with strict PID/process-group ownership verification, pairs and runs
# the requested recipe (default: native-conversation.recipe.json), verifies identical
# HEAD commit, tree SHA, and clean tracked state at entry and seal, and guarantees
# verified teardown (recipe group, agent-device daemon, owned gateway + detached native
# host, Metro group, and ephemeral simulator) via trap on pass, failure, or signal.
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
# native-stream-stack.mts (/pair) and native-conversation-proof.mts deep links use farmslot-development.
SCHEME="farmslot-development"
GATEWAY_PORT_INPUT=""
CONTROL_PORT_INPUT=""
METRO_PORT_INPUT=""
METRO_READY_TIMEOUT_SECS="${METRO_READY_TIMEOUT_SECS:-120}"
GATEWAY_READY_TIMEOUT_SECS="${GATEWAY_READY_TIMEOUT_SECS:-60}"

usage() {
  cat <<'EOF'
Usage: companion-ios-smoke.sh --simulator <udid-or-name> --artifacts-dir <dir> [options]

Options:
  --simulator <udid-or-name>   Reference iOS simulator UDID or exact name holding the installed app bundle (or set IOS_SIMULATOR)
  --artifacts-dir <dir>        Directory for retained receipt, logs, and recipe artifacts
  --recipe <path>              Recipe JSON path (default: native-conversation.recipe.json)
  --runner <name>              Native runner for gateway/setup (default: codex)
  --model <name>               Model for native setup (default: gpt-6-astra)
  --gateway-port <port>        Explicit unused loopback port for private gateway
  --control-port <port>        Explicit unused loopback port for gateway control API
  --metro-port <port>          Explicit unused loopback port for private Metro bundler
  --bundle-id <id>             Installed iOS app bundle ID (default: net.siteed.farmslot.development)
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

# Fail-closed Git identity snapshot helper (checked both at entry and right before sealing).
capture_git_identity() {
  local out_file="$1"
  node -e '
    const { spawnSync } = require("node:child_process");
    const fs = require("node:fs");
    const [repoRoot, outFile] = process.argv.slice(1);
    const runGit = (args) => {
      const r = spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
      if (r.error || r.status !== 0) {
        return { ok: false, stdout: "", error: (r.error && r.error.message) || (r.stderr || "").trim() || `git ${args.join(" ")} exited ${r.status}` };
      }
      return { ok: true, stdout: r.stdout || "", error: null };
    };
    const head = runGit(["rev-parse", "--verify", "HEAD"]);
    const tree = runGit(["rev-parse", "--verify", "HEAD^{tree}"]);
    const status = runGit(["status", "--porcelain", "--untracked-files=no"]);
    const shaRe = /^[0-9a-f]{40}$/i;
    const sourceSha = head.ok && shaRe.test(head.stdout.trim()) ? head.stdout.trim() : null;
    const sourceTreeSha = tree.ok && shaRe.test(tree.stdout.trim()) ? tree.stdout.trim() : null;
    const errors = [];
    if (!sourceSha) errors.push(head.error || "invalid HEAD SHA");
    if (!sourceTreeSha) errors.push(tree.error || "invalid HEAD^{tree} SHA");
    if (!status.ok) errors.push(status.error || "git status failed");
    const ok = errors.length === 0;
    const trackedClean = ok && status.stdout.trim() === "";
    fs.writeFileSync(outFile, JSON.stringify({ ok, sourceSha, sourceTreeSha, trackedClean, errors }, null, 2) + "\n");
    if (!ok) process.exit(1);
  ' "${REPO_ROOT}" "${out_file}"
}

SCRATCH_DIR="$(mktemp -d "${TMPDIR:-/tmp}/companion-ios-smoke-XXXXXX")"
trap 'rm -rf "${SCRATCH_DIR}"' EXIT
BEFORE_GIT_FILE="${SCRATCH_DIR}/git-before.json"
AFTER_GIT_FILE="${SCRATCH_DIR}/git-after.json"
if ! capture_git_identity "${BEFORE_GIT_FILE}"; then
  echo "ERROR: failed to read Git source identity at ${REPO_ROOT}." >&2
  cat "${BEFORE_GIT_FILE}" >&2 || true
  rm -rf "${SCRATCH_DIR}"
  exit 1
fi

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

# Resolve reference simulator to exact UDID, device type, runtime, state, and name.
IFS=$'\t' read -r SRC_SIM_UDID SRC_SIM_STATE_BEFORE SRC_SIM_DEVICE_TYPE SRC_SIM_RUNTIME SRC_SIM_NAME < <(
  node -e '
    const { execFileSync } = require("node:child_process");
    const target = process.argv[1];
    const data = JSON.parse(execFileSync("xcrun", ["simctl", "list", "devices", "-j"], { encoding: "utf8" }));
    const matches = [];
    for (const [runtime, devices] of Object.entries(data.devices || {})) {
      for (const dev of devices) {
        if (dev.isAvailable === false) continue;
        if (dev.udid === target || dev.name === target) {
          matches.push({ ...dev, runtime });
        }
      }
    }
    if (matches.length === 0) {
      console.error(`Reference simulator not found: ${target}`);
      process.exit(1);
    }
    if (matches.length > 1) {
      console.error(`Reference simulator target "${target}" is ambiguous (${matches.length} matches); pass exact UDID.`);
      process.exit(1);
    }
    const dev = matches[0];
    process.stdout.write(`${dev.udid}\t${dev.state}\t${dev.deviceTypeIdentifier}\t${dev.runtime}\t${dev.name}\n`);
  ' "${SIMULATOR_INPUT}"
)

# Resolve the installed .app bundle path on the reference simulator without touching its runtime state.
APP_BUNDLE_PATH="$(xcrun simctl get_app_container "${SRC_SIM_UDID}" "${BUNDLE_ID}" app 2>/dev/null || true)"
if [[ -z "${APP_BUNDLE_PATH}" || ! -d "${APP_BUNDLE_PATH}" ]]; then
  echo "ERROR: ${BUNDLE_ID} is not installed on reference simulator ${SRC_SIM_NAME} (${SRC_SIM_UDID})." >&2
  rm -rf "${SCRATCH_DIR}"
  exit 1
fi

# Discover pre-existing slot/operator ports (if any) from .env.ports and companion .agent/metro-*.env
# so before/after snapshots prove pre-existing gateway and Metro listeners remain untouched across pass, failure, and signal.
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
  local ephemeral_udid="${2:-}"
  node -e '
    const { execFileSync, spawnSync } = require("node:child_process");
    const crypto = require("node:crypto");
    const fs = require("node:fs");
    const path = require("node:path");
    const [outFile, srcSimUdid, ephSimUdid, bundleId, gwPort, ctrlPort, metroPort, prePortsCsv] = process.argv.slice(1);
    const lsofPids = (port) => {
      const r = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
      if (r.status !== 0 || !r.stdout.trim()) return [];
      return [...new Set(r.stdout.trim().split(/\r?\n/).map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
    };
    const appPrefsHash = (udid) => {
      const r = spawnSync("xcrun", ["simctl", "get_app_container", udid, bundleId, "data"], { encoding: "utf8" });
      if (r.status !== 0 || !r.stdout.trim()) return null;
      const plist = path.join(r.stdout.trim(), "Library", "Preferences", `${bundleId}.plist`);
      if (!fs.existsSync(plist)) return null;
      return crypto.createHash("sha256").update(fs.readFileSync(plist)).digest("hex");
    };
    const simList = JSON.parse(execFileSync("xcrun", ["simctl", "list", "devices", "-j"], { encoding: "utf8" }));
    let sourceSim = null;
    let ephemeralSim = null;
    const bootedSimulators = [];
    for (const devices of Object.values(simList.devices || {})) {
      for (const dev of devices) {
        if (dev.isAvailable === false) continue;
        if (dev.udid === srcSimUdid) {
          sourceSim = {
            udid: dev.udid,
            name: dev.name,
            state: dev.state,
            appPreferencesSha256: appPrefsHash(dev.udid),
          };
        }
        if (ephSimUdid && dev.udid === ephSimUdid) {
          ephemeralSim = { udid: dev.udid, name: dev.name, state: dev.state, exists: true };
        }
        if (dev.state === "Booted") {
          bootedSimulators.push({ udid: dev.udid, name: dev.name });
        }
      }
    }
    if (ephSimUdid && !ephemeralSim) {
      ephemeralSim = { udid: ephSimUdid, name: null, state: null, exists: false };
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
      simulator: sourceSim,
      ephemeralSimulator: ephemeralSim,
      bootedSimulators,
      ports: {
        gateway: portInfo(gwPort),
        control: portInfo(ctrlPort),
        metro: portInfo(metroPort),
      },
      preExistingListeners,
    };
    fs.writeFileSync(outFile, JSON.stringify(snapshot, null, 2) + "\n");
  ' "${out_file}" "${SRC_SIM_UDID}" "${ephemeral_udid}" "${BUNDLE_ID}" "${SMOKE_GATEWAY_PORT}" "${SMOKE_CONTROL_PORT}" "${SMOKE_METRO_PORT}" "${PREEXISTING_PORTS_CSV}"
}

BEFORE_STATE_FILE="${ARTIFACTS_ABS}/before-state.json"
AFTER_STATE_FILE="${ARTIFACTS_ABS}/after-state.json"
RECEIPT_FILE="${ARTIFACTS_ABS}/smoke-receipt.json"
GATEWAY_LOG="${ARTIFACTS_ABS}/gateway.log"
METRO_LOG="${ARTIFACTS_ABS}/metro.log"
AGENT_DEVICE_CLEANUP_LOG="${ARTIFACTS_ABS}/agent-device-cleanup.log"
RECIPE_ARTIFACTS_DIR="${ARTIFACTS_ABS}/recipe"

capture_state_json "${BEFORE_STATE_FILE}" ""

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

TOKEN_FILE="${SCRATCH_DIR}/token"
STREAM_STATE_FILE="${SCRATCH_DIR}/stream-state.json"
PROOF_STATE_FILE="${SCRATCH_DIR}/proof-state.json"
AGENT_DEVICE_STATE_DIR="${SCRATCH_DIR}/agent-device"

GATEWAY_PID=""
GATEWAY_ROOT=""
GATEWAY_READY=0
GATEWAY_EXIT_CODE=""
GATEWAY_FORCE_KILLED=0
GATEWAY_OWNERSHIP_REFUSED=0
METRO_PID=""
METRO_OWNERSHIP_REFUSED=0
ACTIVE_CHILD_PID=""
RECIPE_PID=""
SMOKE_SIM_UDID=""
SMOKE_SIM_NAME=""
CLEANUP_DONE=0
RECIPE_RAN=0
RECIPE_EXIT=""
EXIT_SIGNAL=""

pid_alive() {
  local pid="$1"
  [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null
}

pgid_alive() {
  local pgid="$1"
  [[ -n "${pgid}" ]] && ps -o pid= -g "${pgid}" 2>/dev/null | grep -q '[0-9]'
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

wait_pgid_exit() {
  local pgid="$1"
  local max_tenths="$2"
  local i=0
  while (( i < max_tenths )) && (pid_alive "${pgid}" || pgid_alive "${pgid}"); do
    sleep 0.1
    i=$((i + 1))
  done
  ! pid_alive "${pgid}" && ! pgid_alive "${pgid}"
}

stop_owned_group() {
  local pid="$1"
  local grace_tenths="${2:-80}"
  if [[ -z "${pid}" ]]; then
    return 0
  fi
  kill -TERM -- "-${pid}" 2>/dev/null || kill -TERM "${pid}" 2>/dev/null || true
  if ! wait_pgid_exit "${pid}" "${grace_tenths}"; then
    kill -KILL -- "-${pid}" 2>/dev/null || kill -KILL "${pid}" 2>/dev/null || true
    wait_pgid_exit "${pid}" 20 || true
  fi
  wait "${pid}" 2>/dev/null || true
}

port_listening() {
  local port="$1"
  lsof -nP -iTCP:"${port}" -sTCP:LISTEN -t >/dev/null 2>&1
}

port_owned_by_pid() {
  local port="$1"
  local pid="$2"
  [[ -n "${pid}" ]] || return 1
  local pids
  pids="$(lsof -nP -iTCP:"${port}" -sTCP:LISTEN -t 2>/dev/null || true)"
  [[ -n "${pids}" ]] || return 1
  local lpid
  while IFS= read -r lpid; do
    [[ -n "${lpid}" ]] || continue
    if [[ "${lpid}" != "${pid}" ]]; then
      return 1
    fi
  done <<< "${pids}"
  return 0
}

# Verify every TCP listener on <port> belongs to process group <pgid> (and at least one listener exists).
port_owned_by_pgid() {
  local port="$1"
  local pgid="$2"
  [[ -n "${pgid}" ]] || return 1
  local pids
  pids="$(lsof -nP -iTCP:"${port}" -sTCP:LISTEN -t 2>/dev/null || true)"
  [[ -n "${pids}" ]] || return 1
  local lpid lpgid
  while IFS= read -r lpid; do
    [[ -n "${lpid}" ]] || continue
    lpgid="$(ps -o pgid= -p "${lpid}" 2>/dev/null | tr -d '[:space:]' || true)"
    if [[ -z "${lpgid}" || "${lpgid}" != "${pgid}" ]]; then
      return 1
    fi
  done <<< "${pids}"
  return 0
}

# Return 0 if <port> has at least one listener whose PGID differs from <pgid>.
port_has_foreign_listener() {
  local port="$1"
  local pgid="$2"
  local pids
  pids="$(lsof -nP -iTCP:"${port}" -sTCP:LISTEN -t 2>/dev/null || true)"
  [[ -n "${pids}" ]] || return 1
  local lpid lpgid
  while IFS= read -r lpid; do
    [[ -n "${lpid}" ]] || continue
    lpgid="$(ps -o pgid= -p "${lpid}" 2>/dev/null | tr -d '[:space:]' || true)"
    if [[ -z "${lpgid}" || "${lpgid}" != "${pgid}" ]]; then
      return 0
    fi
  done <<< "${pids}"
  return 1
}

# Run a foreground command in its own process group so Bash `wait` remains immediately
# interruptible by INT/TERM/HUP traps and cleanup() can terminate the whole subtree.
# Never toggles global errexit (`set -e`) so callers preserve the exact non-zero exit status.
run_interruptible_group() {
  local track_as_recipe="$1"
  shift
  perl -MPOSIX -e 'POSIX::setsid() or die $!; exec @ARGV or die $!' "$@" &
  local child_pid=$!
  ACTIVE_CHILD_PID="${child_pid}"
  if [[ "${track_as_recipe}" == "recipe" ]]; then
    RECIPE_PID="${child_pid}"
  fi
  local rc=0
  wait "${child_pid}" || rc=$?
  if [[ "${ACTIVE_CHILD_PID}" == "${child_pid}" ]]; then
    ACTIVE_CHILD_PID=""
  fi
  return "${rc}"
}

cleanup() {
  local exit_code=$?
  if [[ "${CLEANUP_DONE}" -eq 1 ]]; then
    return
  fi
  CLEANUP_DONE=1
  set +e

  local teardown_errors=()

  # 0. Terminate any active owned child / recipe process group first (signal-safe cleanup).
  if [[ -n "${ACTIVE_CHILD_PID}" ]]; then
    stop_owned_group "${ACTIVE_CHILD_PID}" 60
  fi
  if [[ -n "${RECIPE_PID}" ]] && (pid_alive "${RECIPE_PID}" || pgid_alive "${RECIPE_PID}"); then
    stop_owned_group "${RECIPE_PID}" 60
  fi
  if [[ -n "${RECIPE_PID}" ]] && (pid_alive "${RECIPE_PID}" || pgid_alive "${RECIPE_PID}"); then
    teardown_errors+=("recipe process group ${RECIPE_PID} still alive")
  fi

  # 1. Verify private agent-device daemon identity, close sessions, confirm daemon exit, and retain logs.
  local agent_device_stopped=1
  if [[ -d "${AGENT_DEVICE_STATE_DIR}" ]]; then
    local ad_rc=0
    (
      cd "${APP_DIR}"
      node --input-type=module -e '
        import { execFileSync } from "node:child_process";
        import fs from "node:fs";
        import path from "node:path";
        import { createAgentDeviceClient } from "agent-device";

        const stateDir = process.argv[1];
        const daemonFile = path.join(stateDir, "daemon.json");
        const errors = [];

        const inspectDaemon = (pid, expectedStartTime) => {
          try {
            process.kill(pid, 0);
          } catch (err) {
            if (err && err.code === "ESRCH") return { alive: false, matches: false };
            throw err;
          }
          let cmd = "";
          try {
            cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim();
          } catch {
            return { alive: false, matches: false };
          }
          if (!cmd) return { alive: false, matches: false };
          const norm = cmd.toLowerCase().replaceAll("\\", "/");
          const isDaemonCmd =
            norm.includes("agent-device") &&
            /(^|[\/\s"\x27=])(dist\/src\/(internal\/)?daemon\.js|src\/daemon\.ts)($|[\s"\x27])/.test(norm);
          if (!isDaemonCmd) return { alive: true, matches: false, cmd };
          if (expectedStartTime) {
            let lstart = "";
            try {
              lstart = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" }).trim();
            } catch {
              return { alive: false, matches: false };
            }
            if (!lstart || lstart !== expectedStartTime) {
              return { alive: true, matches: false, cmd, lstart };
            }
          }
          return { alive: true, matches: true, cmd };
        };

        const waitUntilGone = async (pid, expectedStartTime, timeoutMs) => {
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            const st = inspectDaemon(pid, expectedStartTime);
            if (!st.alive || !st.matches) return true;
            await new Promise((r) => setTimeout(r, 150));
          }
          const st = inspectDaemon(pid, expectedStartTime);
          return !st.alive || !st.matches;
        };

        let daemonInfo = null;
        if (fs.existsSync(daemonFile)) {
          try {
            daemonInfo = JSON.parse(fs.readFileSync(daemonFile, "utf8"));
          } catch (err) {
            errors.push(`failed to parse daemon.json: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        const pid = daemonInfo && Number.isInteger(daemonInfo.pid) && daemonInfo.pid > 0 ? daemonInfo.pid : null;
        const expectedStartTime =
          typeof daemonInfo?.processStartTime === "string" ? daemonInfo.processStartTime.trim() : "";

        if (daemonInfo !== null && pid === null) {
          errors.push(`daemon.json contains invalid pid: ${JSON.stringify(daemonInfo.pid)}`);
        } else if (pid !== null) {
          const initial = inspectDaemon(pid, expectedStartTime);
          if (initial.alive && !initial.matches) {
            errors.push(
              `daemon.json PID ${pid} does not match an agent-device daemon (${initial.cmd ?? "unknown"})`,
            );
          } else if (initial.alive && initial.matches) {
            let closeErr = null;
            const client = createAgentDeviceClient({ stateDir });
            try {
              for (const session of await client.sessions.list()) {
                await client.sessions.close({ session: session.name, shutdown: false });
              }
            } catch (err) {
              closeErr = `agent-device session close failed: ${err instanceof Error ? err.message : String(err)}`;
              console.error(`[companion-ios-smoke] ${closeErr}`);
            }

            let exited = await waitUntilGone(pid, expectedStartTime, 15000);
            if (!exited) {
              if (closeErr) errors.push(closeErr);
              const beforeTerm = inspectDaemon(pid, expectedStartTime);
              if (beforeTerm.alive && beforeTerm.matches) {
                console.log(`[companion-ios-smoke] sending SIGTERM to verified agent-device daemon PID ${pid}`);
                try {
                  process.kill(pid, "SIGTERM");
                } catch (err) {
                  if (err?.code !== "ESRCH") throw err;
                }
                exited = await waitUntilGone(pid, expectedStartTime, 5000);
              } else {
                exited = !beforeTerm.alive;
              }
            }
            if (!exited) {
              const beforeKill = inspectDaemon(pid, expectedStartTime);
              if (beforeKill.alive && beforeKill.matches) {
                console.log(`[companion-ios-smoke] sending SIGKILL to verified agent-device daemon PID ${pid}`);
                try {
                  process.kill(pid, "SIGKILL");
                } catch (err) {
                  if (err?.code !== "ESRCH") throw err;
                }
                exited = await waitUntilGone(pid, expectedStartTime, 2000);
              } else {
                exited = !beforeKill.alive;
              }
            }
            if (!exited) {
              errors.push(`verified agent-device daemon PID ${pid} remained alive after SIGTERM and SIGKILL`);
            }
          }
        }

        if (errors.length > 0) {
          for (const msg of errors) console.error(`[companion-ios-smoke] ${msg}`);
          process.exit(1);
        }
      ' "${AGENT_DEVICE_STATE_DIR}"
    ) >"${AGENT_DEVICE_CLEANUP_LOG}" 2>&1 || ad_rc=$?
    if [[ "${ad_rc}" -ne 0 ]]; then
      agent_device_stopped=0
      teardown_errors+=("agent-device cleanup failed (see ${AGENT_DEVICE_CLEANUP_LOG})")
    fi
  fi

  # 2. Best-effort close any still-open native proof session ONLY if our owned gateway PID is listening.
  if [[ -f "${PROOF_STATE_FILE}" ]] && [[ -n "${SMOKE_SIM_UDID}" ]] && pid_alive "${GATEWAY_PID}" && port_owned_by_pid "${SMOKE_GATEWAY_PORT}" "${GATEWAY_PID}" && [[ -f "${TOKEN_FILE}" ]]; then
    (
      cd "${APP_DIR}"
      NATIVE_COMPANION_GATEWAY="ws://127.0.0.1:${SMOKE_GATEWAY_PORT}/ws" \
      NATIVE_COMPANION_TOKEN_FILE="${TOKEN_FILE}" \
      NATIVE_COMPANION_PROOF_STATE="${PROOF_STATE_FILE}" \
      IOS_SIMULATOR="${SMOKE_SIM_UDID}" \
      FARMSLOT_AGENT_DEVICE_STATE_DIR="${AGENT_DEVICE_STATE_DIR}" \
      yarn exec tsx scripts/agentic/native-conversation-proof.mts cleanup >/dev/null 2>&1
    ) || true
  fi

  # 3. Stop ONLY our owned private gateway child via SIGTERM (45s grace for native-stream-stack's 30s stopHost),
  #    record its exact exit status, and verify its private root & detached native supervisor exited.
  if [[ -n "${GATEWAY_PID}" ]]; then
    if pid_alive "${GATEWAY_PID}"; then
      kill -TERM "${GATEWAY_PID}" 2>/dev/null || true
      if ! wait_pid_exit "${GATEWAY_PID}" 450; then
        GATEWAY_FORCE_KILLED=1
        teardown_errors+=("owned gateway PID ${GATEWAY_PID} did not exit within 45s after SIGTERM; sent SIGKILL")
        kill -KILL "${GATEWAY_PID}" 2>/dev/null || true
        wait_pid_exit "${GATEWAY_PID}" 20 || true
      fi
    fi
    GATEWAY_EXIT_CODE=0
    wait "${GATEWAY_PID}" 2>/dev/null || GATEWAY_EXIT_CODE=$?
    if [[ "${GATEWAY_EXIT_CODE}" -ne 0 ]]; then
      teardown_errors+=("owned gateway PID ${GATEWAY_PID} exited with status ${GATEWAY_EXIT_CODE}")
    fi
  fi

  local gateway_root_removed=1
  local gateway_host_exited=1
  if [[ -n "${GATEWAY_ROOT}" ]]; then
    if [[ -e "${GATEWAY_ROOT}" ]]; then
      gateway_root_removed=0
      teardown_errors+=("private gateway root still exists after shutdown: ${GATEWAY_ROOT}")
    fi
    if ps -axo pid=,command= 2>/dev/null | grep -F "${GATEWAY_ROOT}/native" | grep -qv grep; then
      gateway_host_exited=0
      teardown_errors+=("detached private native host process still running for ${GATEWAY_ROOT}")
    fi
  elif [[ -n "${GATEWAY_PID}" && "${GATEWAY_READY}" -eq 1 ]]; then
    gateway_root_removed=0
    gateway_host_exited=0
    teardown_errors+=("gateway root path was not recorded despite gateway readiness")
  fi

  # 4. Stop ONLY our owned private Metro process group (never touch a foreign listener on port collision).
  if [[ -n "${METRO_PID}" ]]; then
    stop_owned_group "${METRO_PID}" 80
  fi

  # Wait briefly for sockets owned by this smoke to release after process exit.
  local sock_wait=0
  while (( sock_wait < 50 )); do
    local gw_busy=0
    local ctrl_busy=0
    local metro_busy=0
    [[ "${GATEWAY_OWNERSHIP_REFUSED}" -eq 0 ]] && port_listening "${SMOKE_GATEWAY_PORT}" && gw_busy=1
    [[ "${GATEWAY_OWNERSHIP_REFUSED}" -eq 0 ]] && port_listening "${SMOKE_CONTROL_PORT}" && ctrl_busy=1
    [[ "${METRO_OWNERSHIP_REFUSED}" -eq 0 ]] && port_listening "${SMOKE_METRO_PORT}" && metro_busy=1
    if [[ "${gw_busy}" -eq 0 && "${ctrl_busy}" -eq 0 && "${metro_busy}" -eq 0 ]]; then
      break
    fi
    sleep 0.1
    sock_wait=$((sock_wait + 1))
  done

  # 5. Shut down and delete the dedicated ephemeral simulator (reference simulator is never touched).
  if [[ -n "${SMOKE_SIM_UDID}" ]]; then
    xcrun simctl shutdown "${SMOKE_SIM_UDID}" >/dev/null 2>&1 || true
    local sim_wait=0
    while (( sim_wait < 100 )); do
      local st
      st="$(xcrun simctl list devices -j | node -e 'const fs=require("node:fs"); const d=JSON.parse(fs.readFileSync(0,"utf8")); for(const arr of Object.values(d.devices||{})){ for(const s of arr){ if(s.udid===process.argv[1]){ process.stdout.write(s.state); process.exit(0); } } }' "${SMOKE_SIM_UDID}")"
      if [[ -z "${st}" || "${st}" == "Shutdown" ]]; then
        break
      fi
      sleep 0.2
      sim_wait=$((sim_wait + 1))
    done
    if ! xcrun simctl delete "${SMOKE_SIM_UDID}" >/dev/null 2>&1; then
      teardown_errors+=("failed to delete ephemeral simulator ${SMOKE_SIM_UDID}")
    fi
  fi

  # 6. Capture seal-time Git source identity before deciding whether scratch dir can be removed.
  capture_git_identity "${AFTER_GIT_FILE}" >/dev/null 2>&1 || true

  # 7. Capture after-state and remove private scratch dir ONLY if daemon & gateway host teardown completed cleanly.
  capture_state_json "${AFTER_STATE_FILE}" "${SMOKE_SIM_UDID}"

  local recipe_alive=0
  local gateway_alive=0
  local metro_alive=0
  if [[ -n "${RECIPE_PID}" ]] && (pid_alive "${RECIPE_PID}" || pgid_alive "${RECIPE_PID}"); then
    recipe_alive=1
  fi
  pid_alive "${GATEWAY_PID}" && gateway_alive=1
  if [[ -n "${METRO_PID}" ]] && (pid_alive "${METRO_PID}" || pgid_alive "${METRO_PID}"); then
    metro_alive=1
  fi

  local retained_recovery_dir=""
  if [[ "${agent_device_stopped}" -eq 0 || "${gateway_host_exited}" -eq 0 ]]; then
    if [[ "${gateway_alive}" -eq 0 ]]; then
      rm -f "${TOKEN_FILE}"
    fi
    retained_recovery_dir="${SCRATCH_DIR}"
    teardown_errors+=("retained recovery state directory due to incomplete teardown: ${SCRATCH_DIR}")
  fi

  local err_joined=""
  if (( ${#teardown_errors[@]} > 0 )); then
    err_joined="$(printf '%s\n' "${teardown_errors[@]}")"
  fi

  local final_status="fail"
  if [[ "${exit_code}" -eq 0 && "${RECIPE_RAN}" -eq 1 && "${RECIPE_EXIT}" == "0" ]]; then
    final_status="pass"
  fi

  local teardown_ok=0
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const [
      beforePath,
      afterPath,
      beforeGitPath,
      afterGitPath,
      receiptPath,
      status,
      exitCodeStr,
      recipeExitStr,
      recipePath,
      recipeArtifactsDir,
      srcSimUdid,
      srcSimName,
      ephSimUdid,
      ephSimName,
      recipeAliveStr,
      agentDeviceStoppedStr,
      gwStartedStr,
      gwAliveStr,
      gwExitCodeStr,
      gwForceKilledStr,
      gwRootRemovedStr,
      gwHostExitedStr,
      gwOwnershipRefusedStr,
      metroAliveStr,
      metroOwnershipRefusedStr,
      retainedRecoveryDir,
      exitSignal,
      errText,
    ] = process.argv.slice(1);
    const before = JSON.parse(fs.readFileSync(beforePath, "utf8"));
    const after = JSON.parse(fs.readFileSync(afterPath, "utf8"));
    const beforeGit = fs.existsSync(beforeGitPath) ? JSON.parse(fs.readFileSync(beforeGitPath, "utf8")) : { ok: false, sourceSha: null, sourceTreeSha: null, trackedClean: false, errors: ["missing before git identity"] };
    const afterGit = fs.existsSync(afterGitPath) ? JSON.parse(fs.readFileSync(afterGitPath, "utf8")) : { ok: false, sourceSha: null, sourceTreeSha: null, trackedClean: false, errors: ["missing after git identity"] };
    const errors = errText ? errText.split(/\r?\n/).filter(Boolean) : [];
    const sourceIdentityMatched = Boolean(
      beforeGit.ok &&
      afterGit.ok &&
      beforeGit.sourceSha &&
      beforeGit.sourceTreeSha &&
      beforeGit.sourceSha === afterGit.sourceSha &&
      beforeGit.sourceTreeSha === afterGit.sourceTreeSha,
    );
    if (!sourceIdentityMatched) {
      errors.push(`source identity check failed (before=${beforeGit.sourceSha}/${beforeGit.sourceTreeSha}, after=${afterGit.sourceSha}/${afterGit.sourceTreeSha})`);
    }
    const trackedWorkingTreeClean = Boolean(
      sourceIdentityMatched && beforeGit.trackedClean && afterGit.trackedClean,
    );
    const gwStarted = gwStartedStr === "1";
    const gatewayExitCode = gwExitCodeStr === "" ? null : Number(gwExitCodeStr);
    const gatewayForceKilled = gwForceKilledStr === "1";
    const gatewayRootRemoved = gwRootRemovedStr === "1";
    const gatewayHostExited = gwHostExitedStr === "1";
    const gatewayOwnershipRefused = gwOwnershipRefusedStr === "1";
    const metroOwnershipRefused = metroOwnershipRefusedStr === "1";
    const recipeStopped = recipeAliveStr === "0";
    const agentDeviceStopped = agentDeviceStoppedStr === "1";
    const gatewayStopped =
      gwAliveStr === "0" &&
      (gatewayOwnershipRefused || !after.ports.gateway.listening) &&
      (!gwStarted || (gatewayExitCode === 0 && !gatewayForceKilled && gatewayRootRemoved && gatewayHostExited));
    const controlStopped = gatewayOwnershipRefused || !after.ports.control.listening;
    const metroStopped =
      metroAliveStr === "0" && (metroOwnershipRefused || !after.ports.metro.listening);
    const ephemeralSimulatorDeleted = ephSimUdid ? after.ephemeralSimulator?.exists === false : true;
    const sourceSimulatorStateMatched = Boolean(
      before.simulator && after.simulator && before.simulator.state === after.simulator.state,
    );
    const sourceSimulatorAppPrefsMatched = Boolean(
      before.simulator &&
      after.simulator &&
      before.simulator.appPreferencesSha256 === after.simulator.appPreferencesSha256,
    );
    const preExistingListenersPreserved = Object.entries(before.preExistingListeners || {}).every(
      ([port, pids]) => JSON.stringify(after.preExistingListeners?.[port] ?? []) === JSON.stringify(pids),
    );
    const clean =
      recipeStopped &&
      agentDeviceStopped &&
      gatewayStopped &&
      controlStopped &&
      metroStopped &&
      ephemeralSimulatorDeleted &&
      sourceSimulatorStateMatched &&
      sourceSimulatorAppPrefsMatched &&
      preExistingListenersPreserved &&
      sourceIdentityMatched &&
      errors.length === 0;
    const summaryPath = path.join(recipeArtifactsDir, "summary.json");
    const receipt = {
      status: status === "pass" && clean ? "pass" : "fail",
      exitCode: Number(exitCodeStr),
      recipeExitCode: recipeExitStr === "" ? null : Number(recipeExitStr),
      exitSignal: exitSignal || null,
      sourceSha: beforeGit.sourceSha,
      sourceTreeSha: beforeGit.sourceTreeSha,
      sourceShaAfter: afterGit.sourceSha,
      sourceTreeShaAfter: afterGit.sourceTreeSha,
      sourceIdentityMatched,
      trackedWorkingTreeClean,
      gatewayOwnershipRefused,
      metroOwnershipRefused,
      retainedRecoveryDir: retainedRecoveryDir || null,
      recipe: recipePath,
      recipeArtifactsDir,
      recipeSummaryPath: fs.existsSync(summaryPath) ? summaryPath : null,
      simulator: {
        reference: {
          udid: srcSimUdid,
          name: srcSimName,
          stateBefore: before.simulator?.state ?? null,
          stateAfter: after.simulator?.state ?? null,
          appPreferencesSha256Before: before.simulator?.appPreferencesSha256 ?? null,
          appPreferencesSha256After: after.simulator?.appPreferencesSha256 ?? null,
          preserved: sourceSimulatorStateMatched && sourceSimulatorAppPrefsMatched,
        },
        ephemeral: {
          udid: ephSimUdid || null,
          name: ephSimName || null,
          deleted: ephemeralSimulatorDeleted,
        },
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
        recipeStopped,
        agentDeviceStopped,
        gatewayStopped,
        gatewayExitCode,
        gatewayForceKilled,
        gatewayRootRemoved,
        gatewayHostExited,
        controlStopped,
        metroStopped,
        ephemeralSimulatorDeleted,
        sourceSimulatorStateMatched,
        sourceSimulatorAppPrefsMatched,
        preExistingListenersPreserved,
        sourceIdentityMatched,
        errors,
      },
    };
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
    process.stdout.write(JSON.stringify({ receipt: receiptPath, status: receipt.status, teardown: receipt.teardown }) + "\n");
    if (!clean) process.exit(2);
  ' \
    "${BEFORE_STATE_FILE}" \
    "${AFTER_STATE_FILE}" \
    "${BEFORE_GIT_FILE}" \
    "${AFTER_GIT_FILE}" \
    "${RECEIPT_FILE}" \
    "${final_status}" \
    "${exit_code}" \
    "${RECIPE_EXIT}" \
    "${RECIPE_ABS}" \
    "${RECIPE_ARTIFACTS_DIR}" \
    "${SRC_SIM_UDID}" \
    "${SRC_SIM_NAME}" \
    "${SMOKE_SIM_UDID}" \
    "${SMOKE_SIM_NAME}" \
    "${recipe_alive}" \
    "${agent_device_stopped}" \
    "$([[ -n "${GATEWAY_PID}" ]] && echo 1 || echo 0)" \
    "${gateway_alive}" \
    "${GATEWAY_EXIT_CODE}" \
    "${GATEWAY_FORCE_KILLED}" \
    "${gateway_root_removed}" \
    "${gateway_host_exited}" \
    "${GATEWAY_OWNERSHIP_REFUSED}" \
    "${metro_alive}" \
    "${METRO_OWNERSHIP_REFUSED}" \
    "${retained_recovery_dir}" \
    "${EXIT_SIGNAL}" \
    "${err_joined}" && teardown_ok=1

  if [[ -z "${retained_recovery_dir}" ]]; then
    rm -rf "${SCRATCH_DIR}"
  fi

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

# Create, boot, and install the app onto a dedicated ephemeral simulator so the reference simulator is never mutated.
SMOKE_SIM_NAME="companion-ios-smoke-$$-$(date +%s)"
echo "[companion-ios-smoke] creating ephemeral simulator ${SMOKE_SIM_NAME} (${SRC_SIM_DEVICE_TYPE} / ${SRC_SIM_RUNTIME})"
SMOKE_SIM_UDID="$(xcrun simctl create "${SMOKE_SIM_NAME}" "${SRC_SIM_DEVICE_TYPE}" "${SRC_SIM_RUNTIME}")"
xcrun simctl boot "${SMOKE_SIM_UDID}"
run_interruptible_group step xcrun simctl bootstatus "${SMOKE_SIM_UDID}" -b
echo "[companion-ios-smoke] installing ${BUNDLE_ID} from ${APP_BUNDLE_PATH} onto ${SMOKE_SIM_UDID}"
run_interruptible_group step xcrun simctl install "${SMOKE_SIM_UDID}" "${APP_BUNDLE_PATH}"

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
    if port_listening "${SMOKE_GATEWAY_PORT}" || port_listening "${SMOKE_CONTROL_PORT}"; then
      GATEWAY_OWNERSHIP_REFUSED=1
    fi
    echo "ERROR: isolated gateway exited during startup:" >&2
    cat "${GATEWAY_LOG}" >&2 || true
    exit 1
  fi
  if [[ -s "${TOKEN_FILE}" ]] \
    && port_owned_by_pid "${SMOKE_GATEWAY_PORT}" "${GATEWAY_PID}" \
    && port_owned_by_pid "${SMOKE_CONTROL_PORT}" "${GATEWAY_PID}" \
    && curl -sf "http://127.0.0.1:${SMOKE_GATEWAY_PORT}/health" >/dev/null 2>&1 \
    && grep -q '"ready":true' "${GATEWAY_LOG}" 2>/dev/null; then
    GATEWAY_ROOT="$(node -e 'const fs=require("node:fs"); for (const line of fs.readFileSync(process.argv[1],"utf8").split(/\r?\n/)) { if (!line.includes("\"ready\":true")) continue; try { const j=JSON.parse(line); if (j.ready===true && typeof j.root==="string" && j.root) { process.stdout.write(j.root); process.exit(0); } } catch {} } process.exit(1);' "${GATEWAY_LOG}" 2>/dev/null || true)"
    if [[ -z "${GATEWAY_ROOT}" ]]; then
      echo "ERROR: isolated gateway ready output missing private root path:" >&2
      cat "${GATEWAY_LOG}" >&2 || true
      exit 1
    fi
    GATEWAY_READY=1
    break
  fi
  sleep 0.2
  gw_waited=$((gw_waited + 1))
done
if [[ "${GATEWAY_READY}" -ne 1 ]]; then
  if port_listening "${SMOKE_GATEWAY_PORT}" && ! port_owned_by_pid "${SMOKE_GATEWAY_PORT}" "${GATEWAY_PID}"; then
    GATEWAY_OWNERSHIP_REFUSED=1
  fi
  if port_listening "${SMOKE_CONTROL_PORT}" && ! port_owned_by_pid "${SMOKE_CONTROL_PORT}" "${GATEWAY_PID}"; then
    GATEWAY_OWNERSHIP_REFUSED=1
  fi
  echo "ERROR: isolated gateway (PID ${GATEWAY_PID}) did not bind owned ports :${SMOKE_GATEWAY_PORT}/:${SMOKE_CONTROL_PORT} within ${GATEWAY_READY_TIMEOUT_SECS}s:" >&2
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
metro_ready=0
while (( metro_waited < METRO_READY_TIMEOUT_SECS * 2 )); do
  if port_has_foreign_listener "${SMOKE_METRO_PORT}" "${METRO_PID}"; then
    METRO_OWNERSHIP_REFUSED=1
    echo "ERROR: Metro port :${SMOKE_METRO_PORT} is owned by a foreign listener outside Metro PGID ${METRO_PID}; refusing to hand foreign listener to simulator." >&2
    exit 1
  fi
  if ! pid_alive "${METRO_PID}"; then
    echo "ERROR: isolated Metro exited during startup:" >&2
    tail -n 40 "${METRO_LOG}" >&2 || true
    exit 1
  fi
  if port_owned_by_pgid "${SMOKE_METRO_PORT}" "${METRO_PID}" \
    && curl -sf "http://127.0.0.1:${SMOKE_METRO_PORT}/status" 2>/dev/null | grep -q "packager-status:running"; then
    metro_ready=1
    break
  fi
  sleep 0.5
  metro_waited=$((metro_waited + 1))
done
if [[ "${metro_ready}" -ne 1 ]]; then
  if port_has_foreign_listener "${SMOKE_METRO_PORT}" "${METRO_PID}"; then
    METRO_OWNERSHIP_REFUSED=1
  fi
  echo "ERROR: isolated Metro (PGID ${METRO_PID}) did not bind owned port :${SMOKE_METRO_PORT} within ${METRO_READY_TIMEOUT_SECS}s:" >&2
  tail -n 40 "${METRO_LOG}" >&2 || true
  exit 1
fi

echo "[companion-ios-smoke] launching dev client on ephemeral ${SMOKE_SIM_NAME} (${SMOKE_SIM_UDID}) against Metro :${SMOKE_METRO_PORT}"
run_interruptible_group step env \
  -u IOS_DEVICE_UDID \
  METRO_PORT="${SMOKE_METRO_PORT}" \
  GATEWAY_PORT="${SMOKE_GATEWAY_PORT}" \
  SCHEME="${SCHEME}" \
  BUNDLE_ID="${BUNDLE_ID}" \
  COMPANION_PACKAGER_HOSTNAME=localhost \
  node "${SCRIPT_DIR}/prepare-dev-client.mjs" ios "${SMOKE_SIM_UDID}" "${BUNDLE_ID}"

run_interruptible_group step env \
  -u IOS_DEVICE_UDID \
  METRO_PORT="${SMOKE_METRO_PORT}" \
  IOS_SIMULATOR="${SMOKE_SIM_UDID}" \
  COMPANION_PACKAGER_HOSTNAME=localhost \
  FARMSLOT_RECIPE_ARTIFACTS_DIR="${ARTIFACTS_ABS}" \
  bash -c 'cd "$1" && exec node --input-type=module -e "import { waitForSimulatorRecipeBridge } from \"./scripts/agentic/simulator-dev-client.mjs\"; await waitForSimulatorRecipeBridge({ platform: \"ios\" });"' _ "${APP_DIR}"

echo "[companion-ios-smoke] pairing Companion with isolated gateway :${SMOKE_GATEWAY_PORT}"
run_interruptible_group step env \
  -u IOS_DEVICE_UDID \
  NATIVE_STREAM_CONTROL="http://127.0.0.1:${SMOKE_CONTROL_PORT}" \
  NATIVE_STREAM_STATE="${STREAM_STATE_FILE}" \
  METRO_PORT="${SMOKE_METRO_PORT}" \
  PLATFORM=ios \
  IOS_SIMULATOR="${SMOKE_SIM_UDID}" \
  FARMSLOT_AGENT_DEVICE_STATE_DIR="${AGENT_DEVICE_STATE_DIR}" \
  FARMSLOT_RECIPE_APP_ID="${BUNDLE_ID}" \
  bash -c 'cd "$1" && exec node "$2" pair' _ "${APP_DIR}" "${SCRIPT_DIR}/native-stream-proof.mjs"

if grep -q "native-conversation-proof.mts" "${RECIPE_ABS}"; then
  echo "[companion-ios-smoke] running native-conversation-proof.mts setup"
  run_interruptible_group step env \
    -u IOS_DEVICE_UDID \
    NATIVE_COMPANION_GATEWAY="ws://127.0.0.1:${SMOKE_GATEWAY_PORT}/ws" \
    NATIVE_COMPANION_TOKEN_FILE="${TOKEN_FILE}" \
    NATIVE_COMPANION_PROOF_STATE="${PROOF_STATE_FILE}" \
    NATIVE_COMPANION_RUNNER="${RUNNER}" \
    NATIVE_COMPANION_MODEL="${MODEL}" \
    IOS_SIMULATOR="${SMOKE_SIM_UDID}" \
    FARMSLOT_AGENT_DEVICE_STATE_DIR="${AGENT_DEVICE_STATE_DIR}" \
    bash -c 'cd "$1" && exec yarn exec tsx scripts/agentic/native-conversation-proof.mts setup' _ "${APP_DIR}"
fi

echo "[companion-ios-smoke] running recipe ${RECIPE_ABS}"
RECIPE_RAN=1
if run_interruptible_group recipe env \
  -u FARMSLOT_SLOT_ID \
  -u RECIPE_TASK_DIR \
  -u FARMSLOT_TASK_DIR \
  -u IOS_DEVICE_UDID \
  PLATFORM=ios \
  IOS_SIMULATOR="${SMOKE_SIM_UDID}" \
  SIMULATOR="${SMOKE_SIM_UDID}" \
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
  bash -c 'cd "$1" && shift && exec bash "$@"' _ "${APP_DIR}" "${SCRIPT_DIR}/run-recipe.sh" run "${RECIPE_ABS}" \
    --artifacts-dir "${RECIPE_ARTIFACTS_DIR}" \
    --record-video=off \
    "--recording-reason=Companion iOS live smoke retains per-step simulator screenshots and protocol receipts."; then
  RECIPE_EXIT=0
else
  RECIPE_EXIT=$?
fi

exit "${RECIPE_EXIT}"
