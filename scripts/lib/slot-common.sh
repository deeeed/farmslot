#!/bin/bash
# lib/slot-common.sh — Shared helpers for slot lifecycle scripts.
# Source this file; do not execute directly.
#
# Provides: resolve_slot, resolve_remote_repo, is_local, run_on, color helpers
# Requires: POOL_DIR to be set before sourcing.

# ── Colors ──────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'
pass() { echo -e "  ${GREEN}[OK]${NC} $1"; }
fail() { echo -e "  ${RED}[FAIL]${NC} $1"; }
warn() { echo -e "  ${YELLOW}[WARN]${NC} $1"; }
info() { echo -e "  ${DIM}$1${NC}"; }
header() { echo -e "${BOLD}── $1 ──${NC}"; }
banner() { echo -e "${BOLD}$1${NC}"; }

# ── resolve_slot <slot-id> ──────────────────────────────────────────
# Parses pool JSONs to find the slot. Sets global variables:
#   SLOT_RESULT  — full JSON blob (machine-level + slot fields)
#   POOL_FILE    — path to the pool JSON that matched
resolve_slot() {
  local slot_id="$1"
  SLOT_RESULT=""
  POOL_FILE=""

  for f in "${POOL_DIR}"/*.json; do
    SLOT_RESULT=$(python3 -c "
import json, sys
with open('${f}') as fh:
    pool = json.load(fh)
for s in pool['slots']:
    if str(s['id']) == '${slot_id}':
        out = {k: v for k, v in pool.items() if k != 'slots'}
        out['slot'] = s
        json.dump(out, sys.stdout)
        sys.exit(0)
sys.exit(1)
" 2>/dev/null) && { POOL_FILE="$f"; break; } || true
  done

  if [ -z "$SLOT_RESULT" ]; then
    echo -e "${RED}FAIL: slot '${slot_id}' not found in any pool JSON under ${POOL_DIR}/${NC}" >&2
    return 1
  fi
}

# ── resolve_slot_by_repo [dir] ─────────────────────────────────────
# Reverse-lookups slot from a directory path. Sets SLOT_RESULT + POOL_FILE.
# Defaults to $(pwd). Prefers local machine when multiple matches.
resolve_slot_by_repo() {
  local target_dir
  target_dir="$(cd "${1:-$(pwd)}" && pwd -P)"
  SLOT_RESULT=""
  POOL_FILE=""

  local best_result="" best_file=""
  local result machine host

  for f in "${POOL_DIR}"/*.json; do
    result=$(python3 -c "
import json, sys, os
with open('${f}') as fh:
    pool = json.load(fh)
for s in pool['slots']:
    repo = s.get('repo', '')
    expanded = os.path.expanduser(repo)
    if not os.path.isabs(expanded):
        continue
    if os.path.realpath(expanded) == '${target_dir}':
        out = {k: v for k, v in pool.items() if k != 'slots'}
        out['slot'] = s
        json.dump(out, sys.stdout)
        sys.exit(0)
sys.exit(1)
" 2>/dev/null) || continue

    machine=$(echo "$result" | python3 -c "import json,sys; print(json.load(sys.stdin)['machine'])")
    host=$(echo "$result" | python3 -c "import json,sys; print(json.load(sys.stdin)['host'])")

    if is_local "$host" "$machine"; then
      SLOT_RESULT="$result"; POOL_FILE="$f"; return 0
    fi
    if [ -z "$best_result" ]; then
      best_result="$result"; best_file="$f"
    fi
  done

  if [ -n "$best_result" ]; then
    SLOT_RESULT="$best_result"; POOL_FILE="$best_file"; return 0
  fi

  echo -e "${RED}FAIL: no slot found with repo '${target_dir}' in ${POOL_DIR}/${NC}" >&2
  return 1
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
#       CODEX_PATH, OPENCODE_PATH,
#       REPO, SESSION, PORT, SIMULATOR, AVD, ADB_SERIAL, CDP_PORT,
#       HEADLESS, SNAPSHOT, + backward-compat aliases,
#       DISPATCH_CMD, RECYCLE_CMD, SSH_TARGET, REMOTE_REPO
load_slot_vars() {
  local slot_id="$1"
  resolve_slot "$slot_id" || return 1

  MACHINE=$(parse_slot "d['machine']")
  PLATFORM=$(parse_slot "d['slot'].get('platform') or d.get('platform', '')")
  HOST=$(parse_slot "d['host']")
  SSH_USER=$(parse_slot "d['ssh_user']")
  OS_TYPE=$(parse_slot "d.get('os','linux')")
  CLAUDE_PATH=$(parse_slot "d.get('claude_path') or ''")
  CODEX_PATH=$(parse_slot "d.get('codex_path') or ''")
  OPENCODE_PATH=$(parse_slot "d.get('opencode_path') or ''")
  DISPATCH_CMD=$(parse_slot "d.get('dispatch_cmd') or ''" 2>/dev/null || true)
  RECYCLE_CMD=$(parse_slot "d.get('recycle_cmd') or ''" 2>/dev/null || true)

  REPO=$(parse_slot "d['slot']['repo']")
  SESSION=$(parse_slot "d['slot']['session']")
  APP=$(parse_slot "d['slot'].get('app') or ''" 2>/dev/null || true)

  # Read resource fields as flat uppercase vars
  eval "$(echo "${SLOT_RESULT}" | python3 -c "
import json, sys
d = json.load(sys.stdin)
res = d['slot'].get('resources', {})
for rkey, rval in res.items():
    for field, val in rval.items():
        print(f'{field.upper()}={val}')
")"

  # Alias common vars for backward compat in this script
  WATCHER_PORT="${PORT:-}"
  METRO_PORT="${PORT:-}"
  IOS_SIMULATOR="${SIMULATOR:-}"
  ANDROID_AVD="${AVD:-}"
  CDP_PORT="${CDP_PORT:-}"
  ADB_SERIAL="${ADB_SERIAL:-}"
  AVD_NAME="${AVD:-}"
  SNAPSHOT="${SNAPSHOT:-}"
  SLOT_ID="$slot_id"

  SLOT_MODE=$(echo "${SLOT_RESULT}" | python3 -c "
import json,sys; d=json.load(sys.stdin)
m=d['slot'].get('mode','')
if not m:
    m='disabled' if str(d['slot'].get('enabled',True)).lower()=='false' else 'dispatch'
print(m)
")
  SLOT_ENABLED=$( [ "$SLOT_MODE" = "disabled" ] && echo "False" || echo "True" )

  SSH_TARGET="${SSH_USER}@${HOST}"
  REMOTE_REPO=$(resolve_remote_repo "$REPO" "$OS_TYPE" "$SSH_USER")
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

  # Check for agent process (claude, codex, or opencode) under the pane shell
  local agent_pid
  agent_pid=$(run_on "$host" "$machine" "$ssh_user" \
    "pgrep -P '${pane_pid}' -f 'claude|codex|opencode' 2>/dev/null | head -1" || true)

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
# Shared cleanup steps used by release-slot.sh:
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
    local worker_task_dir="${REMOTE_REPO}/.task/${task_rel}"
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
      "rm -rf '${REMOTE_REPO}/.task/${task_rel}'" 2>/dev/null || true
    pass "Task dir .task/${task_rel} cleaned"
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
# Expands {repo}, {runner}, {runner_path}, {claude_path}, {codex_path},
# {opencode_path}, {model}, {task_file}, {task_prompt}, {effort},
# and {adb_serial} placeholders in DISPATCH_CMD
expand_dispatch_cmd() {
  local cmd="$DISPATCH_CMD"
  local runner="${RUNNER:-claude}"
  local runner_path="$CLAUDE_PATH"
  case "$runner" in
    codex) runner_path="${CODEX_PATH:-$CLAUDE_PATH}" ;;
    opencode) runner_path="${OPENCODE_PATH:-${CODEX_PATH:-$CLAUDE_PATH}}" ;;
  esac
  cmd="${cmd//\{repo\}/$REMOTE_REPO}"
  cmd="${cmd//\{runner\}/$runner}"
  cmd="${cmd//\{runner_path\}/$runner_path}"
  cmd="${cmd//\{claude_path\}/$CLAUDE_PATH}"
  cmd="${cmd//\{codex_path\}/$CODEX_PATH}"
  cmd="${cmd//\{opencode_path\}/$OPENCODE_PATH}"
  cmd="${cmd//\{model\}/${MODEL:-}}"
  cmd="${cmd//\{task_file\}/${TASK_FILE:-}}"
  cmd="${cmd//\{task_prompt\}/${TASK_PROMPT:-}}"
  cmd="${cmd//\{effort\}/${EFFORT:-}}"
  cmd="${cmd//\{adb_serial\}/$ADB_SERIAL}"
  echo "$cmd"
}

# ── expand_recycle_cmd ─────────────────────────────────────────────
expand_recycle_cmd() {
  local cmd="$RECYCLE_CMD"
  cmd="${cmd//\{repo\}/$REMOTE_REPO}"
  cmd="${cmd//\{adb_serial\}/$ADB_SERIAL}"
  echo "$cmd"
}

# ══════════════════════════════════════════════════════════════════════
# ── Project config layer ─────────────────────────────────────────────
# ══════════════════════════════════════════════════════════════════════

# Directory containing project configs (projects/<name>/project.json)
SLOT_COMMON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FARMSLOT_ROOT="${FARMSLOT_ROOT:-$(cd "${SLOT_COMMON_DIR}/../.." && pwd)}"
PROJECTS_DIR="${PROJECTS_DIR:-${FARMSLOT_ROOT}/projects}"

# ── load_project_config ──────────────────────────────────────────────
# Reads project.json for the slot's project. Sets:
#   PROJECT_NAME, PROJECT_CONFIG, PROJECT_FIXTURES_DIR, PROJECT_TEMPLATES_DIR, PROJECT_JSON
#   RUNTIME_DIR (default: .agent), ARTIFACT_DIR (default: .task), RECIPE_DIR (default: RUNTIME_DIR/recipes)
# Requires "project" field in pool JSON.
load_project_config() {
  PROJECT_NAME=$(parse_slot "d['slot'].get('project') or d.get('project', '')")
  PROJECT_CONFIG="${PROJECTS_DIR}/${PROJECT_NAME}/project.json"
  PROJECT_FIXTURES_DIR="${PROJECTS_DIR}/${PROJECT_NAME}/fixtures"
  PROJECT_TEMPLATES_DIR="${PROJECTS_DIR}/${PROJECT_NAME}/templates"

  if [ ! -f "$PROJECT_CONFIG" ]; then
    echo "WARN: project config not found: ${PROJECT_CONFIG}" >&2
    PROJECT_JSON=""
    return 1
  fi
  PROJECT_JSON=$(cat "$PROJECT_CONFIG")

  # Read path config with defaults
  RUNTIME_DIR=$(get_project_field "paths.runtime_dir")
  RUNTIME_DIR="${RUNTIME_DIR:-.agent}"
  ARTIFACT_DIR=$(get_project_field "paths.artifact_dir")
  ARTIFACT_DIR="${ARTIFACT_DIR:-.task}"
  RECIPE_DIR=$(get_project_field "paths.recipe_dir")
  RECIPE_DIR="${RECIPE_DIR:-${RUNTIME_DIR}/recipes}"

  # Resolve reference repos from project.json
  MOBILE_REPO=""
  if [ -n "$PROJECT_JSON" ]; then
    local _ref_local_name
    _ref_local_name=$(echo "$PROJECT_JSON" | python3 -c "
import json, sys
d = json.load(sys.stdin)
ref = d.get('reference_repos', {}).get('mobile', {})
print(ref.get('local_name', ''))
" 2>/dev/null)
    if [ -n "$_ref_local_name" ]; then
      MOBILE_REPO="$(dirname "$REPO")/$_ref_local_name"
    fi
  fi
}

# ── get_project_field <dotpath> ──────────────────────────────────────
# Reads a dotted path from project.json (e.g. "health.ready_indicator")
get_project_field() {
  [ -z "$PROJECT_JSON" ] && return 0
  echo "$PROJECT_JSON" | python3 -c "
import json, sys
d = json.load(sys.stdin)
keys = '${1}'.split('.')
for k in keys:
    if isinstance(d, dict):
        d = d.get(k, '')
    else:
        d = ''
        break
print(d if d else '')
"
}

# ── project_command_env_shell_prefix ────────────────────────────────
# Emits shell statements for project.json command_env. Hooks that spawn their
# own child shells/tmux sessions should prepend this to the child command: the
# gateway applies command_env at the hook boundary, but long-lived process
# managers such as tmux can have their own server environment.
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
# Substitutes slot resource placeholders in hook strings and fixture paths.
expand_slot_template() {
  local text="${1:-}"
  text="${text//\{\{port\}\}/${PORT:-}}"
  text="${text//\{\{PORT\}\}/${PORT:-}}"
  text="${text//\{\{simulator\}\}/${SIMULATOR:-}}"
  text="${text//\{\{SIMULATOR\}\}/${SIMULATOR:-}}"
  text="${text//\{\{avd\}\}/${AVD:-}}"
  text="${text//\{\{AVD\}\}/${AVD:-}}"
  text="${text//\{\{adb_serial\}\}/${ADB_SERIAL:-}}"
  text="${text//\{\{ADB_SERIAL\}\}/${ADB_SERIAL:-}}"
  text="${text//\{\{cdp_port\}\}/${CDP_PORT:-}}"
  text="${text//\{\{CDP_PORT\}\}/${CDP_PORT:-}}"
  text="${text//\{\{headless\}\}/${HEADLESS:-}}"
  text="${text//\{\{HEADLESS\}\}/${HEADLESS:-}}"
  text="${text//\{\{snapshot\}\}/${SNAPSHOT:-}}"
  text="${text//\{\{SNAPSHOT\}\}/${SNAPSHOT:-}}"
  text="${text//\{\{app\}\}/${APP:-}}"
  text="${text//\{\{APP\}\}/${APP:-}}"
  text="${text//\{\{platform\}\}/${PLATFORM:-}}"
  text="${text//\{\{PLATFORM\}\}/${PLATFORM:-}}"
  text="${text//\{\{slot_id\}\}/${SLOT_ID:-}}"
  text="${text//\{\{SLOT_ID\}\}/${SLOT_ID:-}}"
  text="${text//\{\{runtime_dir\}\}/${RUNTIME_DIR:-.agent}}"
  text="${text//\{\{RUNTIME_DIR\}\}/${RUNTIME_DIR:-.agent}}"
  text="${text//\{\{artifact_dir\}\}/${ARTIFACT_DIR:-.task}}"
  text="${text//\{\{ARTIFACT_DIR\}\}/${ARTIFACT_DIR:-.task}}"
  text="${text//\{\{recipe_dir\}\}/${RECIPE_DIR:-${RUNTIME_DIR:-.agent}/recipes}}"
  text="${text//\{\{RECIPE_DIR\}\}/${RECIPE_DIR:-${RUNTIME_DIR:-.agent}/recipes}}"
  text="${text//\{\{farmslot_dir\}\}/${FARMSLOT_DIR:-}}"
  text="${text//\{\{FARMSLOT_DIR\}\}/${FARMSLOT_DIR:-}}"
  text="${text//\{\{repo\}\}/${REMOTE_REPO:-${REPO:-}}}"
  text="${text//\{\{REPO\}\}/${REMOTE_REPO:-${REPO:-}}}"
  text="${text//\{\{mobile_repo\}\}/${MOBILE_REPO:-}}"
  text="${text//\{\{MOBILE_REPO\}\}/${MOBILE_REPO:-}}"
  printf '%s\n' "$text"
}

# ── expand_hook <hook-name> ──────────────────────────────────────────
# Reads hooks.<name> from project.json, substitutes slot variables.
# Returns empty string if hook not defined.
expand_hook() {
  [ -z "$PROJECT_JSON" ] && return 0
  local hook_name="$1"
  local cmd
  cmd=$(echo "$PROJECT_JSON" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(d.get('hooks', {}).get('${hook_name}', ''))
")
  [ -z "$cmd" ] && return 0

  cmd=$(expand_slot_template "$cmd")
  echo "$cmd"
}

# ── expand_platform_field <field> ────────────────────────────────────
# Reads platforms.<PLATFORM>.<field> from project.json, substitutes vars.
expand_platform_field() {
  [ -z "$PROJECT_JSON" ] && return 0
  local field="$1"
  local cmd
  cmd=$(echo "$PROJECT_JSON" | python3 -c "
import json, sys
d = json.load(sys.stdin)
v = d.get('platforms', {}).get('${PLATFORM}', {}).get('${field}', '')
print(v if v else '')
")
  [ -z "$cmd" ] && return 0

  cmd=$(expand_slot_template "$cmd")
  echo "$cmd"
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
  cp "$src_file" "$rendered"

  # Substitute all known resource + auto-injected vars (lowercase + UPPERCASE)
  sed -i.bak \
    -e "s|{{port}}|${PORT:-}|g" \
    -e "s|{{PORT}}|${PORT:-}|g" \
    -e "s|{{simulator}}|${SIMULATOR:-}|g" \
    -e "s|{{SIMULATOR}}|${SIMULATOR:-}|g" \
    -e "s|{{avd}}|${AVD:-}|g" \
    -e "s|{{AVD}}|${AVD:-}|g" \
    -e "s|{{adb_serial}}|${ADB_SERIAL:-}|g" \
    -e "s|{{ADB_SERIAL}}|${ADB_SERIAL:-}|g" \
    -e "s|{{cdp_port}}|${CDP_PORT:-}|g" \
    -e "s|{{CDP_PORT}}|${CDP_PORT:-}|g" \
    -e "s|{{headless}}|${HEADLESS:-}|g" \
    -e "s|{{HEADLESS}}|${HEADLESS:-}|g" \
    -e "s|{{snapshot}}|${SNAPSHOT:-}|g" \
    -e "s|{{SNAPSHOT}}|${SNAPSHOT:-}|g" \
    -e "s|{{app}}|${APP:-}|g" \
    -e "s|{{APP}}|${APP:-}|g" \
    -e "s|{{platform}}|${PLATFORM}|g" \
    -e "s|{{PLATFORM}}|${PLATFORM}|g" \
    -e "s|{{slot_id}}|${SLOT_ID:-}|g" \
    -e "s|{{SLOT_ID}}|${SLOT_ID:-}|g" \
    -e "s|{{runtime_dir}}|${RUNTIME_DIR:-.agent}|g" \
    -e "s|{{RUNTIME_DIR}}|${RUNTIME_DIR:-.agent}|g" \
    -e "s|{{artifact_dir}}|${ARTIFACT_DIR:-.task}|g" \
    -e "s|{{ARTIFACT_DIR}}|${ARTIFACT_DIR:-.task}|g" \
    -e "s|{{recipe_dir}}|${RECIPE_DIR:-${RUNTIME_DIR:-.agent}/recipes}|g" \
    -e "s|{{RECIPE_DIR}}|${RECIPE_DIR:-${RUNTIME_DIR:-.agent}/recipes}|g" \
    -e "s|{{farmslot_dir}}|${FARMSLOT_DIR:-}|g" \
    -e "s|{{FARMSLOT_DIR}}|${FARMSLOT_DIR:-}|g" \
    -e "s|{{repo}}|${REMOTE_REPO:-${REPO:-}}|g" \
    -e "s|{{mobile_repo}}|${MOBILE_REPO:-}|g" \
    -e "s|{{MOBILE_REPO}}|${MOBILE_REPO:-}|g" \
    -e "s|{{WATCHER_PORT}}|${PORT:-}|g" \
    -e "s|{{SESSION}}|${SESSION:-}|g" \
    -e "s|{{REPO}}|${REMOTE_REPO:-}|g" \
    "$rendered"
  rm -f "${rendered}.bak"
  echo "$rendered"
}
