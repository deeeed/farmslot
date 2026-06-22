#!/usr/bin/env bash
# install.sh — one-command farmslot installation.
#
#   curl -fsSL <repo>/install.sh | bash        # fresh machine (clones FARMSLOT_REPO_URL)
#   bash install.sh                            # from a checkout (dev/test mode: checkout is the source)
#
# Everything lands under FARMSLOT_WORKSPACE (default ~/dev/farmslot-workspace):
#   farmslot/   — farmslot clone
#   repos/      — product repo clones (one per slot)
#   runs/       — run archives
#   state.json  — onboarding state
#
# Idempotent: re-running repairs/updates, never duplicates. Ends with `farmslot doctor`.
#
# Structure: each concern is its own step_* function; main() runs them in order.
# Helpers + pre-clone steps must stay inline (a piped `curl | bash` runs this file
# before the repo exists, so there is nothing on disk to source yet).
#
# Env:
#   FARMSLOT_WORKSPACE  workspace dir              (default: ~/dev/farmslot-workspace)
#   FARMSLOT_REPO_URL   git source for fresh mode  (default: the canonical repo URL)
#   FARMSLOT_REPO_REF   branch/ref for fresh mode  (default: the remote default branch)
#   FARMSLOT_BIN_DIR    dir for the PATH symlink   (default: ~/.local/bin)
#   FARMSLOT_MINIMAL    set to skip the dashboard build + pair-your-phone step
#   FARMSLOT_PAIR       set to 1 to pair non-interactively (no prompt)
set -euo pipefail

WORKSPACE="${FARMSLOT_WORKSPACE:-${HOME}/dev/farmslot-workspace}"
BIN_DIR="${FARMSLOT_BIN_DIR:-${HOME}/.local/bin}"
# Fresh (piped) installs clone this repo; override with FARMSLOT_REPO_URL.
# Dev/test mode (run from a checkout) uses the checkout itself as the source.
DEFAULT_REPO_URL="https://github.com/deeeed/farmslot.git"

# ── Output helpers ───────────────────────────────────────────────────────────
red() { printf '\033[0;31m%s\033[0m\n' "$1"; }
green() { printf '\033[0;32m%s\033[0m\n' "$1"; }
bold() { printf '\033[1m%s\033[0m\n' "$1"; }

fail() {
  red "FAIL: $1"
  [ -n "${2:-}" ] && echo "  fix: $2"
  exit 1
}

# run_step "label" cmd...  — run one long command behind a single live status
# line (spinner + last output line) instead of a silent wait or a wall of noise.
# Prints [OK] on success; tails the captured log and fails hard on error. Falls
# back to a static label line (no spinner) when stdout is not a terminal
# (CI/log capture). Logs persist under ${WORKSPACE}/.install-logs/ — success
# runs too — for post-mortem debugging.
SPIN_FRAMES=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
run_step() {
  local label="$1"
  shift
  local slug log
  slug="$(printf '%s' "$label" | tr -cs 'a-zA-Z0-9' '-')"
  log="${WORKSPACE}/.install-logs/${slug}.log"
  mkdir -p "${WORKSPACE}/.install-logs"
  : >"$log"
  "$@" >"$log" 2>&1 &
  local pid=$! i=0
  if [ -t 1 ]; then
    while kill -0 "$pid" 2>/dev/null; do
      local last
      last="$(tail -n1 "$log" 2>/dev/null | tr -d '\r' | tr -dc '[:print:]' | cut -c1-68)"
      printf '\r\033[K  %s %s  \033[2m%s\033[0m' \
        "${SPIN_FRAMES[i++ % ${#SPIN_FRAMES[@]}]}" "$label" "$last"
      sleep 0.1
    done
    printf '\r\033[K'
  else
    echo "  ... ${label}"
  fi
  if wait "$pid"; then
    green "  [OK] ${label}"
  else
    [ -t 1 ] && echo
    red "  [FAIL] ${label}"
    tail -40 "$log"
    echo "  full log: ${log}"
    exit 1
  fi
}

check_cmd() {
  local name="$1" hint="$2"
  if command -v "$name" >/dev/null 2>&1; then
    green "  [OK] ${name}"
  else
    fail "${name} not found on PATH" "$hint"
  fi
}

# check_runner <name> <install-hint> <login-hint> <auth-marker-regex> <auth-cmd...>
# Three states: missing / inactive / authenticated. Per-runner markers mirror
# packages/cli prereqs.ts probeRunnerAuth — keep both in sync.
check_runner() {
  local name="$1" install_hint="$2" login_hint="$3" marker="$4"
  shift 4
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "  [--] ${name} not found — ${install_hint}"
    return 0
  fi
  # Cap probe time (mirrors prereqs.ts 5s) so a wedged runner CLI cannot hang a
  # piped install; stock macOS lacks coreutils timeout, hence the guard.
  if command -v timeout >/dev/null 2>&1; then
    set -- timeout 5 "$@"
  fi
  local probe_out
  if probe_out="$("$@" 2>&1)" && echo "$probe_out" | grep -qiE "$marker"; then
    green "  [OK] ${name} (authenticated)"
    runner_authenticated=1
  else
    printf '\033[0;33m  [WARN] %s on PATH but not signed in — %s\033[0m\n' "$name" "$login_hint"
  fi
}

# ── Steps ────────────────────────────────────────────────────────────────────

# Dev/test mode when run from inside a checkout; otherwise clone the remote.
step_detect_source() {
  SOURCE_MODE="git"
  SOURCE=""
  if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
    local script_dir
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    if [ -f "${script_dir}/packages/cli/bin/farmslot.mjs" ] && [ -d "${script_dir}/.git" ]; then
      SOURCE_MODE="local"
      SOURCE="$script_dir"
    fi
  fi
  if [ "$SOURCE_MODE" = "git" ]; then
    SOURCE="${FARMSLOT_REPO_URL:-$DEFAULT_REPO_URL}"
  fi
  CLONE="${WORKSPACE}/farmslot"
}

step_prereqs() {
  bold "── Prerequisites ──"
  check_cmd git "macOS: xcode-select --install · Linux: apt install git"
  check_cmd node "install node (see .tool-versions) via https://nodejs.org or asdf/nvm"
  check_cmd yarn "corepack enable (ships with node)"
  check_cmd tmux "macOS: brew install tmux · Linux: apt install tmux"
  check_cmd python3 "macOS: brew install python3 · Linux: apt install python3"
}

step_runners() {
  bold "── Runners ──"
  runner_authenticated=0
  check_runner claude "npm install -g @anthropic-ai/claude-code" "run: claude (sign in)" '"loggedin": *true' claude auth status
  check_runner codex "npm install -g @openai/codex" "run: codex login" 'logged in (as|using)' codex login status
  check_runner cursor-agent "see https://cursor.com/cli" "run: cursor-agent login" 'logged in (as|using)' cursor-agent status
  [ "$runner_authenticated" = 1 ] || fail "no authenticated agent runner" "install and sign in to at least one of: claude, codex, cursor-agent"
}

step_clone() {
  bold "── Farmslot repo ──"
  mkdir -p "$WORKSPACE"
  if [ -d "${CLONE}/.git" ]; then
    echo "  clone exists — refreshing from source"
    # Back up local edits like `farmslot update` does — the clone is a tool, but
    # never silently destroy work (recover with: git stash pop).
    if [ -n "$(git -C "$CLONE" status --porcelain)" ]; then
      echo "  clone has local changes — backing them up with git stash (recover: git stash pop)"
      git -C "$CLONE" stash push --include-untracked -m "farmslot-install backup" >/dev/null
    fi
    # Re-point origin so a changed FARMSLOT_REPO_URL or git↔local mode switch applies.
    git -C "$CLONE" remote set-url origin "$SOURCE"
    run_step "fetch origin" git -C "$CLONE" fetch origin --quiet
    local src_branch
    if [ "$SOURCE_MODE" = "local" ]; then
      src_branch="$(git -C "$SOURCE" rev-parse --abbrev-ref HEAD)"
    elif [ -n "${FARMSLOT_REPO_REF:-}" ]; then
      src_branch="$FARMSLOT_REPO_REF"
    else
      git -C "$CLONE" remote set-head origin --auto >/dev/null
      src_branch="$(git -C "$CLONE" rev-parse --abbrev-ref origin/HEAD | sed 's|^origin/||')"
    fi
    if git -C "$CLONE" rev-parse --verify --quiet "origin/${src_branch}" >/dev/null; then
      git -C "$CLONE" checkout --quiet "$src_branch" 2>/dev/null || git -C "$CLONE" checkout --quiet -b "$src_branch" "origin/${src_branch}"
      git -C "$CLONE" reset --hard --quiet "origin/${src_branch}"
    else
      git -C "$CLONE" checkout --quiet --detach "$src_branch"
    fi
  else
    run_step "clone farmslot" git clone --quiet "$SOURCE" "$CLONE"
    if [ "$SOURCE_MODE" = "git" ] && [ -n "${FARMSLOT_REPO_REF:-}" ]; then
      git -C "$CLONE" checkout --quiet "$FARMSLOT_REPO_REF"
    fi
  fi
  green "  [OK] ${CLONE} ($(git -C "$CLONE" rev-parse --abbrev-ref HEAD) @ $(git -C "$CLONE" rev-parse --short HEAD))"
}

step_node() {
  local required_node node_version
  required_node="$(sed -n 's/.*"node": *"\([^"]*\)".*/\1/p' "${CLONE}/package.json" | head -1)"
  node_version="$(node --version | tr -d 'v')"
  node -e "
const min = ('${required_node}'.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/) || []).slice(1).map(n => Number(n || 0));
const cur = '${node_version}'.split('.').map(Number);
if (!min.length) process.exit(0);
for (let i = 0; i < 3; i++) { if (cur[i] !== min[i]) process.exit(cur[i] > min[i] ? 0 : 1); }
" || fail "node ${node_version} does not satisfy required ${required_node}" "upgrade node (see .tool-versions)"
  green "  [OK] node ${node_version} satisfies ${required_node}"
}

step_cli() {
  bold "── CLI ──"
  # Positional-arg sh -c: $CLONE is passed as "$1", never embedded in the
  # command string, so any path (quotes, spaces) survives intact.
  run_step "yarn install (workspace)" sh -c 'cd "$1" && yarn install' _ "$CLONE"
  run_step "build recipe-harness" sh -c 'cd "$1" && yarn workspace @farmslot/recipe-harness build' _ "$CLONE"
  if [ -n "${FARMSLOT_MINIMAL:-}" ]; then
    echo "  dashboard build skipped (FARMSLOT_MINIMAL) — build later: yarn --cwd ${CLONE}/apps/command-center/ui build"
  else
    run_step "build Command Center dashboard" sh -c 'cd "$1/apps/command-center/ui" && yarn build' _ "$CLONE"
  fi
  FARMSLOT_BIN="${CLONE}/packages/cli/bin/farmslot.mjs"
  "$FARMSLOT_BIN" --version >/dev/null || fail "farmslot CLI failed to run" "check the yarn install output above"
  green "  [OK] farmslot CLI runs"

  mkdir -p "$BIN_DIR"
  ln -sf "$FARMSLOT_BIN" "${BIN_DIR}/farmslot"
  green "  [OK] symlink ${BIN_DIR}/farmslot"
  case ":$PATH:" in
    *":${BIN_DIR}:"*) ;;
    *) echo "  note: ${BIN_DIR} is not on PATH — add: export PATH=\"${BIN_DIR}:\$PATH\"" ;;
  esac
}

step_workspace() {
  bold "── Workspace ──"
  FARMSLOT_WORKSPACE="$WORKSPACE" "$FARMSLOT_BIN" workspace init --source-mode "$SOURCE_MODE" --source "$SOURCE" --bin-dir "$BIN_DIR"
}

step_doctor() {
  echo ""
  FARMSLOT_WORKSPACE="$WORKSPACE" "$FARMSLOT_BIN" doctor
}

# Quick win: start the local gateway and show a QR to pair the mobile companion
# app for tmux control on the go. Reads y/n from /dev/tty so a piped `curl | bash`
# can still prompt; a non-interactive install (CI, no tty) skips without hanging.
step_pair() {
  bold "── Start it up ──"
  local start_now="" pair_now="" reply
  if [ -n "${FARMSLOT_MINIMAL:-}" ]; then
    echo "  skipped (FARMSLOT_MINIMAL) — start later with: farmslot up  (then 'farmslot pair' for phone)"
    return
  elif [ "${FARMSLOT_PAIR:-}" = "1" ]; then
    start_now="yes"; pair_now="yes"
  elif [ -r /dev/tty ]; then
    # Command Center (web dashboard) first — what most people use.
    printf '  Start the Command Center (web dashboard) now? [Y/n] ' >/dev/tty
    read -r reply </dev/tty || reply=""
    case "$reply" in [Nn]*) ;; *) start_now="yes" ;; esac
    # Phone pairing is optional and OFF by default — only offered if the dashboard is starting.
    if [ -n "$start_now" ]; then
      printf '  Optional: also pair the mobile app to control agents from your phone? [y/N] ' >/dev/tty
      read -r reply </dev/tty || reply=""
      case "$reply" in [Yy]*) pair_now="yes" ;; esac
    fi
  else
    echo "  non-interactive — start later with: farmslot up  (then 'farmslot pair' for phone)"
    return
  fi

  if [ -n "$start_now" ]; then
    FARMSLOT_WORKSPACE="$WORKSPACE" "$FARMSLOT_BIN" up
  else
    echo "  Nothing started — run 'farmslot up' when ready (it prints the Command Center URL)."
    return
  fi

  if [ -n "$pair_now" ]; then
    if command -v tailscale >/dev/null 2>&1 && tailscale status --json >/dev/null 2>&1; then
      echo "  Tailscale detected — QR will include a tailnet profile for phones signed into the same tailnet."
    else
      echo "  LAN pairing will work now. For away-from-LAN pairing, install and sign in to Tailscale on this Mac and phone, then run: farmslot pair"
    fi
    # --gateway local: pair must mint codes for the gateway `up` just started,
    # not whatever profile happened to be active on a machine with prior config.
    FARMSLOT_WORKSPACE="$WORKSPACE" "$FARMSLOT_BIN" --gateway local pair
    echo ""
    echo "  Scan the QR above with the Farmslot companion app (App Store / Play Store)."
    echo "  If the QR has a Tailscale profile, scan from a phone signed into the same tailnet."
    echo "  Stop the gateway anytime with: farmslot down"
  else
    echo "  Pair your phone later anytime with: farmslot pair"
  fi
}

main() {
  step_detect_source
  bold "=== farmslot install ==="
  echo "  workspace: ${WORKSPACE}"
  echo "  source:    ${SOURCE} (${SOURCE_MODE})"
  echo ""
  step_prereqs
  step_runners
  step_clone
  step_node
  step_cli
  step_workspace
  step_doctor
  step_pair
}

main "$@"
