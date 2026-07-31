#!/bin/bash
# lib/slot-common.sh — Shared helpers for slot lifecycle scripts.
# Source this file; do not execute directly.
#
# Provides: resolve_slot, resolve_remote_repo, is_local, run_on, color helpers
# Requires: POOL_DIR to be set before sourcing.
#
# Node support bundles (ADR-035) sync scripts/projects but not pool JSON.
# Hooks that derive POOL_DIR from {{node_support_dir}} therefore miss pool/;
# fall back to the node deployment root when that directory exists.

if [[ -n "${POOL_DIR:-}" && ! -d "${POOL_DIR}" && -d "${HOME}/farmslot-node/pool" ]]; then
  POOL_DIR="${HOME}/farmslot-node/pool"
fi

# Checkout-local CLI, overridable; relocated script trees (deploy-node copies,
# test sandboxes) fall back to the installed farmslot, which resolves the same
# slot-config core. Fail loudly when neither exists.
if [ -z "${FARMSLOT_CLI:-}" ]; then
  _slot_common_cli="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../packages/cli" 2>/dev/null && pwd || true)"
  if [ -n "$_slot_common_cli" ] && [ -f "${_slot_common_cli}/bin/farmslot.mjs" ]; then
    FARMSLOT_CLI="${_slot_common_cli}/bin/farmslot.mjs"
  elif command -v farmslot >/dev/null 2>&1; then
    FARMSLOT_CLI="$(command -v farmslot)"
  else
    echo "FAIL: farmslot CLI not found (no packages/cli next to scripts/ and no farmslot on PATH). Set FARMSLOT_CLI." >&2
    return 1 2>/dev/null || exit 1
  fi
fi
# The CLI verbs honor the historical POOL_DIR/PROJECTS_DIR overrides via env.
[ -n "${POOL_DIR:-}" ] && export FARMSLOT_POOL_DIR="${FARMSLOT_POOL_DIR:-$POOL_DIR}"

# ── Colors ──────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'
pass() { echo -e "  ${GREEN}[OK]${NC} $1"; }
fail() { echo -e "  ${RED}[FAIL]${NC} $1"; }
warn() { echo -e "  ${YELLOW}[WARN]${NC} $1"; }
info() { echo -e "  ${DIM}$1${NC}"; }
header() { echo -e "${BOLD}── $1 ──${NC}"; }
banner() { echo -e "${BOLD}$1${NC}"; }

# ── resolve_slot <slot-id> ──────────────────────────────────────────
# Locates slot via CLI. Sets global variables:
#   SLOT_RESULT  — full JSON blob (machine-level + slot fields, including poolFile)
#   POOL_FILE    — path to the pool JSON that matched
resolve_slot() {
  local slot_id="$1"
  SLOT_RESULT=""
  POOL_FILE=""

  if ! SLOT_RESULT=$("$FARMSLOT_CLI" internal resolve-slot "$slot_id" --raw); then
    echo -e "${RED}FAIL: slot '${slot_id}' not found in any pool JSON under ${POOL_DIR}/${NC}" >&2
    SLOT_RESULT=""
    return 1
  fi
  POOL_FILE=$(parse_slot "d['poolFile']")
}

# ── resolve_slot_by_repo [dir] ─────────────────────────────────────
# Reverse-lookups slot from a directory path. Sets SLOT_RESULT + POOL_FILE.
# Defaults to $(pwd). Prefers local machine when multiple matches (CLI handles
# the prefer-local logic).
resolve_slot_by_repo() {
  local target_dir
  target_dir="$(cd "${1:-$(pwd)}" && pwd -P)"
  SLOT_RESULT=""
  POOL_FILE=""

  if ! SLOT_RESULT=$("$FARMSLOT_CLI" internal resolve-slot --by-repo "$target_dir" --raw); then
    echo -e "${RED}FAIL: no slot found with repo '${target_dir}' in ${POOL_DIR}/${NC}" >&2
    SLOT_RESULT=""
    return 1
  fi
  POOL_FILE=$(parse_slot "d['poolFile']")
}

# ── parse_slot <python-expr> ───────────────────────────────────────
# Extracts a value from SLOT_RESULT using a python expression.
# The expression receives `d` as the parsed JSON dict.
parse_slot() {
  echo "${SLOT_RESULT}" | python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"
}

# ── load_slot_vars <slot-id> ───────────────────────────────────────
# Resolves slot and populates standard shell variables from resources.
# Sets: MACHINE, PLATFORM, HOST, SSH_USER, OS_TYPE, CLAUDE_PATH,
#       CODEX_PATH, OPENCODE_PATH, CURSOR_PATH, GROK_PATH,
#       REPO, SESSION, APP, PORT, SIMULATOR, AVD, ADB_SERIAL, CDP_PORT,
#       HEADLESS, SNAPSHOT, + backward-compat aliases,
#       DISPATCH_CMD, RECYCLE_CMD, SSH_TARGET, REMOTE_REPO,
#       SLOT_ID, SLOT_MODE, SLOT_ENABLED
load_slot_vars() {
  local slot_id="$1"
  # resolve_slot is kept so SLOT_RESULT/POOL_FILE globals remain populated for
  # parse_slot consumers (e.g. load_project_config reads PROJECT_NAME from them).
  resolve_slot "$slot_id" || return 1
  local _slot_shell_vars
  _slot_shell_vars=$("$FARMSLOT_CLI" internal slot-vars "$slot_id" --shell) || return 1
  eval "$_slot_shell_vars"
}

# ── check_slot_enabled ───────────────────────────────────────────
# Returns 1 (failure) if the slot is disabled, with a dim message.
# Usage: check_slot_enabled || exit 0
check_slot_enabled() {
  if [ "$SLOT_ENABLED" = "False" ] || [ "$SLOT_ENABLED" = "false" ]; then
    echo -e "${DIM}Slot ${SLOT_ID:-$1} is disabled — skipping.${NC}"
    return 1
  fi
  return 0
}

# ── get_slot_mode ────────────────────────────────────────────────
get_slot_mode() { echo "${SLOT_MODE:-dispatch}"; }

# ── check_slot_dispatchable ──────────────────────────────────────
# Returns 1 if the slot should not be auto-dispatched.
# Custom slots can be overridden with --force.
check_slot_dispatchable() {
  local force="${1:-}"
  if [ "$SLOT_MODE" = "disabled" ]; then
    echo -e "${DIM}Slot ${SLOT_ID:-} is disabled — cannot dispatch.${NC}"
    return 1
  fi
  if [ "$SLOT_MODE" = "custom" ] && [ "$force" != "--force" ]; then
    echo -e "${YELLOW}Slot ${SLOT_ID:-} is in custom mode — use --force to override.${NC}"
    return 1
  fi
  return 0
}

# ── resolve_remote_repo <repo> <os_type> <ssh_user> ────────────────
resolve_remote_repo() {
  local repo="$1" os_type="$2" ssh_user="$3"
  if [[ "$repo" == /* ]]; then
    echo "$repo"
  elif [[ "$repo" == ~* ]]; then
    if [ "$os_type" = "darwin" ]; then
      echo "${repo/#\~//Users/${ssh_user}}"
    else
      echo "${repo/#\~//home/${ssh_user}}"
    fi
  else
    echo "$repo"
  fi
}

# ── is_local <host> <machine> ──────────────────────────────────────
LOCAL_HOSTNAME=$(hostname)

is_local() {
  local host="$1" machine="$2"
  [[ "$host" == "localhost" || "$host" == "127.0.0.1" ]] && return 0
  [[ "$machine" == "$LOCAL_HOSTNAME" ]] && return 0
  [[ "$host" == "${LOCAL_HOSTNAME}.local" ]] && return 0
  return 1
}

# ── run_on <host> <machine> <ssh_user> <cmd...> ───────────────────
run_on() {
  local host="$1" machine="$2" ssh_user="$3"; shift 3
  if is_local "$host" "$machine"; then
    bash -c "$*" 2>/dev/null
  else
    ssh -n -o ConnectTimeout=5 -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
        "${ssh_user}@${host}" "$@" 2>/dev/null
  fi
}

# ── remote (run on slot's host — local or SSH) ─────────────────────
# Uses load_slot_vars globals: HOST, MACHINE, SSH_USER, SSH_TARGET
remote() {
  if is_local "$HOST" "$MACHINE"; then
    bash -c "$*" 2>/dev/null
  else
    ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new "${SSH_TARGET}" "$@"
  fi
}

# ── update_farm_status <slot-id> <field> <value> ──────────────────
# Updates a field in .farm-status.json for the given slot.
# Value should be a valid JSON literal (string in quotes, null, etc.)
# Requires PROJECT_DIR to be set by the calling script.
update_farm_status() {
  local slot_id="$1" field="$2" value="$3"
  local status_file="${PROJECT_DIR:?PROJECT_DIR must be set}/.farm-status.json"
  [ -f "$status_file" ] || return 0

  python3 -c "
import json
with open('${status_file}') as f:
    data = json.load(f)
# Parse value as JSON so null/true/false map correctly to Python
val = json.loads('${value}') if '${value}' != '' else None
for s in data.get('slots', []):
    if s['slot'] == '${slot_id}':
        s['${field}'] = val
        break
import os, tempfile
fd, tmp = tempfile.mkstemp(dir=os.path.dirname('${status_file}'), suffix='.tmp')
with os.fdopen(fd, 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
os.rename(tmp, '${status_file}')
"
}

# ── kill_agent_in_session ──────────────────────────────────────────
# Kills any claude/codex/opencode process in the tmux session, then respawns
# the pane with a fresh shell. Safe to call if no agent is running.
# Args: host machine ssh_user session [repo_dir]
kill_agent_in_session() {
  local host="$1" machine="$2" ssh_user="$3" session="$4"

  # Check if tmux session exists
  if ! run_on "$host" "$machine" "$ssh_user" "tmux has-session -t '${session}' 2>/dev/null"; then
    return 0
  fi

  # Find the pane's shell PID
  local pane_pid
  pane_pid=$(run_on "$host" "$machine" "$ssh_user" \
    "tmux list-panes -t '${session}' -F '#{pane_pid}' 2>/dev/null | head -1" || true)
  [ -z "$pane_pid" ] && return 0

  # Find the agent anywhere below the pane shell. Runner launch commands often
  # add one or more wrapper shells, so pgrep -P would miss the real process.
  local agent_pid
  agent_pid=$(run_on "$host" "$machine" "$ssh_user" \
    "root='${pane_pid}'
for pid in \$(pgrep -f 'claude|codex|opencode' 2>/dev/null); do
  command=\$(ps -o command= -p \"\$pid\" 2>/dev/null || true)
  case \"\$command\" in
    *'__farmslot_status'*) continue ;;
  esac
  cur=\$pid
  while [ -n \"\$cur\" ] && [ \"\$cur\" != \"\$root\" ] && [ \"\$cur\" != '0' ] && [ \"\$cur\" != '1' ]; do
    cur=\$(ps -o ppid= -p \"\$cur\" 2>/dev/null | tr -d ' \n\r\t')
  done
  if [ \"\$cur\" = \"\$root\" ]; then echo \"\$pid\"; exit 0; fi
done
exit 1" || true)

  if [ -n "$agent_pid" ]; then
    # Send /exit to the agent first (graceful shutdown)
    run_on "$host" "$machine" "$ssh_user" \
      "tmux send-keys -t '${session}' '/exit' Enter" || true
    sleep 2

    # Check if it's still running
    if run_on "$host" "$machine" "$ssh_user" "kill -0 '${agent_pid}' 2>/dev/null"; then
      # Force kill the agent process tree
      run_on "$host" "$machine" "$ssh_user" \
        "kill -TERM '${agent_pid}' 2>/dev/null" || true
      sleep 1
      # SIGKILL if still alive
      run_on "$host" "$machine" "$ssh_user" \
        "kill -0 '${agent_pid}' 2>/dev/null && kill -KILL '${agent_pid}' 2>/dev/null" || true
    fi
    pass "Agent killed (PID ${agent_pid})"
  else
    info "No agent process running"
  fi

  # Reset the pane to a clean shell prompt (preserve shell environment / login state)
  sleep 1
  local repo_dir="${5:-}"

  # Check if the shell is still alive
  local shell_alive
  shell_alive=$(run_on "$host" "$machine" "$ssh_user" \
    "kill -0 '${pane_pid}' 2>/dev/null && echo yes" || true)

  if [ "$shell_alive" = "yes" ]; then
    # Shell is alive — just clear and cd to repo dir
    run_on "$host" "$machine" "$ssh_user" \
      "tmux send-keys -t '${session}' C-c 2>/dev/null" || true
    sleep 0.3
    run_on "$host" "$machine" "$ssh_user" \
      "tmux send-keys -t '${session}' C-c 2>/dev/null" || true
    sleep 0.3
    if [ -n "$repo_dir" ]; then
      run_on "$host" "$machine" "$ssh_user" \
        "tmux send-keys -t '${session}' 'cd ${repo_dir}' Enter 2>/dev/null" || true
    fi
    sleep 0.5
  else
    # Shell is dead — respawn
    if [ -n "$repo_dir" ]; then
      run_on "$host" "$machine" "$ssh_user" \
        "tmux respawn-pane -k -t '${session}' 'cd ${repo_dir} && exec \${SHELL:-bash}' 2>/dev/null" || true
    else
      run_on "$host" "$machine" "$ssh_user" \
        "tmux respawn-pane -k -t '${session}' 2>/dev/null" || true
    fi
    sleep 1
  fi
  pass "tmux pane reset (fresh shell)"
}

# ── cleanup_slot ──────────────────────────────────────────────────
# Shared cleanup steps used by `farmslot slot release` follow-ups:
#   1. Kill running agent
#   2. Collect artifacts
#   3. Clean task files
#   4. Return to default branch
# Expects slot_vars already loaded. Pass SKIP_ARTIFACTS=true to skip step 2.
cleanup_slot() {
  local skip_artifacts="${SKIP_ARTIFACTS:-false}"
  local default_branch="${DEFAULT_BRANCH:-main}"

  # -- 1. Kill running agent ------------------------------------------------
  header "Agent"
  kill_agent_in_session "$HOST" "$MACHINE" "$SSH_USER" "$SESSION" "$REMOTE_REPO"

  # -- Read branch name (needed for run archive path) -----------------------
  local current_branch
  current_branch=$(run_on "$HOST" "$MACHINE" "$SSH_USER" \
    "git -C '${REMOTE_REPO}' rev-parse --abbrev-ref HEAD 2>/dev/null" 2>/dev/null || true)
  local branch_flat="${current_branch//\//-}"

  # -- 2. Collect artifacts into orchestrator task folder --------------------
  header "Artifacts"

  # Resolve task_file reference from farm-status.json (e.g. "fix/proj-2403-0321-1350")
  local task_rel=""
  task_rel=$(python3 -c "
import json
with open('${PROJECT_DIR:-.}/.farm-status.json') as f:
    data = json.load(f)
for s in data.get('slots', []):
    if s['slot'] == '${SLOT_ID:-}' and s.get('task_file'):
        print(s['task_file'])
        break
" 2>/dev/null || true)

  if [ "$skip_artifacts" = true ]; then
    info "Skipped (--skip-artifacts)"
  elif [ -z "$task_rel" ]; then
    info "No task_file in farm-status — skipping artifact collection"
  else
    local worker_task_dir="${REMOTE_REPO}/${WORKER_TASK_DIR_NAME:-${ARTIFACT_DIR:-.task}}/${task_rel}"
    local worker_artifacts="${worker_task_dir}/artifacts/"
    local orch_task_dir="${PROJECTS_DIR}/${PROJECT_NAME}/tasks/${task_rel}"

    local has_artifacts
    has_artifacts=$(run_on "$HOST" "$MACHINE" "$SSH_USER" \
      "test -d '${worker_artifacts}' && echo yes" 2>/dev/null || true)

    if [ "$has_artifacts" = "yes" ]; then
      mkdir -p "${orch_task_dir}/artifacts"
      if is_local "$HOST" "$MACHINE"; then
        cp -r "${worker_artifacts}" "${orch_task_dir}/artifacts/" 2>/dev/null || true
      else
        rsync -az "${SSH_TARGET}:${worker_artifacts}" "${orch_task_dir}/artifacts/" 2>/dev/null || true
      fi
      pass "Artifacts collected to ${orch_task_dir}/artifacts/"
    else
      info "No artifacts directory at ${worker_artifacts}"
    fi

    # -- 2b. Archive run record -----------------------------------------------
    local learnings_dir="${PROJECTS_DIR}/${PROJECT_NAME}/learnings/runs"
    local run_record=""
    run_record=$(ls "${learnings_dir}"/*.json 2>/dev/null | while read f; do
      grep -q "\"branch\":.*${current_branch}" "$f" 2>/dev/null && echo "$f" && break
    done || true)
    if [ -n "$run_record" ]; then
      mv "$run_record" "${orch_task_dir}/run.json"
      pass "Run record archived to task folder"
    fi
  fi

  # -- 3. Clean task files --------------------------------------------------
  header "Clean"
  if [ -n "$task_rel" ]; then
    run_on "$HOST" "$MACHINE" "$SSH_USER" \
      "rm -rf '${REMOTE_REPO}/${WORKER_TASK_DIR_NAME:-${ARTIFACT_DIR:-.task}}/${task_rel}'" 2>/dev/null || true
    pass "Task dir ${WORKER_TASK_DIR_NAME:-${ARTIFACT_DIR:-.task}}/${task_rel} cleaned"
  else
    info "No task_rel — nothing to clean"
  fi

  # -- 4. Return to default branch -----------------------------------------
  header "Git"
  if [ "$current_branch" = "$default_branch" ]; then
    pass "Already on ${default_branch}"
  else
    run_on "$HOST" "$MACHINE" "$SSH_USER" \
      "cd '${REMOTE_REPO}' && git checkout -- . 2>/dev/null && git clean -fd 2>/dev/null && git checkout ${default_branch} 2>/dev/null && git pull origin ${default_branch} 2>/dev/null" 2>/dev/null || true
    pass "Returned to ${default_branch} (was ${current_branch})"
  fi
}

# ── teardown_slot_infra ──────────────────────────────────────────
# Stops dev server and shuts down simulator/emulator for a slot.
# Uses project teardown hook if configured, otherwise generic fallback.
teardown_slot_infra() {
  header "Teardown"
  local teardown_hook
  teardown_hook=$(expand_hook "teardown")
  if [ -n "$teardown_hook" ]; then
    run_on "$HOST" "$MACHINE" "$SSH_USER" "cd '${REMOTE_REPO}' && ${teardown_hook}" 2>/dev/null || true
    pass "Infra torn down (project hook)"
  else
    # Fallback: kill dev server by port, shutdown simulator/emulator
    local dev_port="${PORT:-}"
    if [ -n "$dev_port" ]; then
      run_on "$HOST" "$MACHINE" "$SSH_USER" \
        "lsof -ti :${dev_port} 2>/dev/null | xargs kill 2>/dev/null || true" 2>/dev/null || true
      pass "Dev server on port ${dev_port} killed"
    fi

    if [ "$PLATFORM" = "ios" ]; then
      local sim_name="${SIMULATOR:-}"
      if [ -n "$sim_name" ]; then
        run_on "$HOST" "$MACHINE" "$SSH_USER" \
          "xcrun simctl shutdown '${sim_name}' 2>/dev/null || true" 2>/dev/null || true
        pass "Simulator ${sim_name} shut down"
      fi
    elif [ "$PLATFORM" = "android" ]; then
      local adb_dev="${ADB_SERIAL:-}"
      if [ -n "$adb_dev" ]; then
        run_on "$HOST" "$MACHINE" "$SSH_USER" \
          "adb -s '${adb_dev}' emu kill 2>/dev/null || true" 2>/dev/null || true
        pass "Emulator ${adb_dev} killed"
      fi
    fi
  fi
}

# ── expand_dispatch_cmd ────────────────────────────────────────────
# Expands dispatch_cmd placeholders for the current slot and runner.
# Reads RUNNER, MODEL, TASK_FILE, TASK_PROMPT, EFFORT from env.
expand_dispatch_cmd() {
  "$FARMSLOT_CLI" internal expand-dispatch-cmd "$SLOT_ID" --raw \
    ${RUNNER:+--runner "$RUNNER"} \
    ${MODEL:+--model "$MODEL"} \
    ${TASK_FILE:+--task-file "$TASK_FILE"} \
    ${TASK_PROMPT:+--task-prompt "$TASK_PROMPT"} \
    ${EFFORT:+--effort "$EFFORT"}
}

# ── expand_recycle_cmd ─────────────────────────────────────────────
expand_recycle_cmd() {
  "$FARMSLOT_CLI" internal expand-recycle-cmd "$SLOT_ID" --raw
}

# ══════════════════════════════════════════════════════════════════════
# ── Project config layer ─────────────────────────────────────────────
# ══════════════════════════════════════════════════════════════════════

# Directory containing project configs (projects/<name>/project.json)
SLOT_COMMON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FARMSLOT_ROOT="${FARMSLOT_ROOT:-$(cd "${SLOT_COMMON_DIR}/../.." && pwd)}"
PROJECTS_DIR="${PROJECTS_DIR:-${FARMSLOT_ROOT}/projects}"
# Point the CLI verbs at this tree's projects (relocated script trees included).
export FARMSLOT_PROJECTS_DIR="${FARMSLOT_PROJECTS_DIR:-$PROJECTS_DIR}"

# ── load_project_config ──────────────────────────────────────────────
# Reads project.json for the slot's project. Sets:
#   PROJECT_NAME, PROJECT_CONFIG, PROJECT_FIXTURES_DIR, PROJECT_TEMPLATES_DIR, PROJECT_JSON
#   RUNTIME_DIR (default: .agent), ARTIFACT_DIR (default: .task), WORKER_TASK_DIR_NAME, RECIPE_DIR (default: RUNTIME_DIR/recipes)
# Requires "project" field in pool JSON.
load_project_config() {
  PROJECT_NAME=$(parse_slot "d['slot'].get('project') or d.get('project', '')")
  # Derive PROJECT_CONFIG to check existence before delegating to CLI.
  PROJECT_CONFIG="${PROJECTS_DIR}/${PROJECT_NAME}/project.json"

  if [ ! -f "$PROJECT_CONFIG" ]; then
    echo "WARN: project config not found: ${PROJECT_CONFIG}" >&2
    PROJECT_JSON=""
    return 1
  fi
  # PROJECT_JSON is kept for consumers that read it directly (e.g. sync-fixtures.sh,
  # project_command_env_shell_prefix, expand_slot_template project-vars pass).
  PROJECT_JSON=$(cat "$PROJECT_CONFIG")

  # Delegate path vars to CLI (sets PROJECT_CONFIG, PROJECT_FIXTURES_DIR,
  # PROJECT_TEMPLATES_DIR, RUNTIME_DIR, ARTIFACT_DIR, RECIPE_DIR, WORKER_TASK_DIR_NAME).
  local _project_shell_vars
  _project_shell_vars=$("$FARMSLOT_CLI" internal project-vars "$PROJECT_NAME" --shell) || return 1
  eval "$_project_shell_vars"

  # Resolve reference repos using the updated get_project_field (now CLI-backed).
  MOBILE_REPO=""
  local _ref_local_name
  _ref_local_name=$(get_project_field "reference_repos.mobile.local_name")
  if [ -n "$_ref_local_name" ]; then
    MOBILE_REPO="$(dirname "$REPO")/$_ref_local_name"
  fi
}

# ── get_project_field <dotpath> ──────────────────────────────────────
# Reads a dotted path from project.json (e.g. "health.ready_indicator")
get_project_field() {
  [ -z "${PROJECT_NAME:-}" ] && return 0
  "$FARMSLOT_CLI" internal project-field "$PROJECT_NAME" "$1" --raw
}

# ── project_command_env_shell_prefix ────────────────────────────────
# Emits shell statements for project.json command_env. Hooks that spawn their
# own child shells/tmux sessions should prepend this to the child command: the
# gateway applies command_env at the hook boundary, but long-lived process
# managers such as tmux can have their own server environment.
# Gateway twin: core/project-env.ts applies command_env at the hook boundary.
project_command_env_shell_prefix() {
  [ -z "$PROJECT_JSON" ] && return 0
  printf '%s' "$PROJECT_JSON" | python3 -c '
import json, re, shlex, sys

data = json.load(sys.stdin)
command_env = data.get("command_env") or {}
name_re = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
parts = []

for name in command_env.get("unset") or []:
    if not isinstance(name, str) or not name_re.match(name):
        raise SystemExit(f"invalid project command_env unset variable: {name!r}")
    parts.append(f"unset {name}")

for name, value in (command_env.get("set") or {}).items():
    if not isinstance(name, str) or not name_re.match(name):
        raise SystemExit(f"invalid project command_env set variable: {name!r}")
    parts.append(f"export {name}={shlex.quote(str(value))}")

if parts:
    print("; ".join(parts) + ";")
'
}

# Apply project.json command_env to the current shell. Use this inside hooks
# before running app-owned tooling; use project_command_env_shell_prefix when
# building a command string for a child shell/tmux session.
apply_project_command_env_current_shell() {
  local _prefix
  _prefix=$(project_command_env_shell_prefix)
  [ -n "$_prefix" ] && eval "$_prefix"
}

# ── expand_slot_template <text> ─────────────────────────────────────
# Substitutes slot resource + project template placeholders. Delegates to the
# slot-config core (single {{var}} implementation, shared with the gateway).
# Requires load_slot_vars to have set SLOT_ID.
expand_slot_template() {
  local text="${1:-}"
  [ -z "$text" ] && { printf '\n'; return 0; }
  # DOMAIN is a runtime overlay (sync-fixtures --domain), not a slot var.
  "$FARMSLOT_CLI" internal expand-template "${SLOT_ID:?expand_slot_template requires load_slot_vars}" "$text" \
    ${DOMAIN:+--var "domain=$DOMAIN"}
}

# ── expand_hook <hook-name> ──────────────────────────────────────────
# Reads hooks.<name> from project.json, substitutes slot variables.
# Returns empty string if hook not defined.
expand_hook() {
  [ -z "${PROJECT_NAME:-}" ] && return 0
  local hook_name="$1"
  "$FARMSLOT_CLI" internal expand-hook "$SLOT_ID" "$hook_name" --raw
}

# ── expand_platform_field <field> ────────────────────────────────────
# Reads platforms.<PLATFORM>.<field> from project.json, substitutes vars.
expand_platform_field() {
  [ -z "${PROJECT_NAME:-}" ] && return 0
  "$FARMSLOT_CLI" internal expand-platform-field "${SLOT_ID:?expand_platform_field requires load_slot_vars}" "$1"
}

# ── render_template <src> <dst-path> ────────────────────────────────
# Renders a fixture template: substitutes resource + auto-injected vars
# (lowercase placeholders), writes to a temp file.
# Returns the temp file path via stdout.
render_fixture_template() {
  local src_file="$1"
  [ ! -f "$src_file" ] && return 1
  local rendered
  rendered=$(mktemp)
  "$FARMSLOT_CLI" internal render-fixture-template "$SLOT_ID" "$src_file" \
    ${DOMAIN:+--var "domain=$DOMAIN"} > "$rendered" || {
    rm -f "$rendered"
    return 1
  }
  echo "$rendered"
}
