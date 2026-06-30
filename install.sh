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
#   FARMSLOT_HOME       machine state/home dir     (default: ~/.farmslot)
# Interactive installs (a real terminal) are prompted to confirm/customize the three
# locations above; values pinned via env, and non-interactive (CI/piped) installs, stay silent.
#   FARMSLOT_MINIMAL    set to skip the dashboard build + pair-your-phone step
#   FARMSLOT_PAIR       set to 1 to pair non-interactively (no prompt)
#   FARMSLOT_NO_STAR_PROMPT  set to 1 to skip the GitHub star prompt
#   FARMSLOT_AUTO_INSTALL  set to 1 to install missing common tools with Homebrew
#   FARMSLOT_SKIP_CAPTURE_HELPER  set to 1 to skip external capture-helper install/check
#   CAPTURE_HELPER_PATH / SITEED_CAPTURE_HELPER_BIN  explicit native helper binary override
#   FARMSLOT_CAPTURE_HELPER_NPM_PACKAGE  npm package name (default: @siteed/capture-helper)
#   FARMSLOT_CAPTURE_HELPER_BREW_FORMULA brew formula name (default: capture-helper)
set -euo pipefail

WORKSPACE="${FARMSLOT_WORKSPACE:-${HOME}/dev/farmslot-workspace}"
BIN_DIR="${FARMSLOT_BIN_DIR:-${HOME}/.local/bin}"
HOME_DIR="${FARMSLOT_HOME:-${HOME}/.farmslot}"
# Track which locations the user pinned via env, so step_configure only prompts the rest
# and a fully-pinned (CI / curl|bash with env) install stays silent.
WORKSPACE_FROM_ENV="${FARMSLOT_WORKSPACE:+1}"
BIN_DIR_FROM_ENV="${FARMSLOT_BIN_DIR:+1}"
HOME_FROM_ENV="${FARMSLOT_HOME:+1}"
# Fresh (piped) installs clone this repo; override with FARMSLOT_REPO_URL.
# Dev/test mode (run from a checkout) uses the checkout itself as the source.
DEFAULT_REPO_URL="https://github.com/deeeed/farmslot.git"

# ── Output helpers ───────────────────────────────────────────────────────────
red() { printf '\033[0;31m%s\033[0m\n' "$1"; }
green() { printf '\033[0;32m%s\033[0m\n' "$1"; }
yellow() { printf '\033[0;33m%s\033[0m\n' "$1"; }
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

tty_available() {
  [ -r /dev/tty ] && { : </dev/tty && : >/dev/tty; } 2>/dev/null
}

ask_yes_no() {
  local prompt="$1" reply
  if [ "${FARMSLOT_AUTO_INSTALL:-}" = "1" ]; then
    return 0
  fi
  tty_available || return 1
  printf '  %s [y/N] ' "$prompt" >/dev/tty
  read -r reply </dev/tty || reply=""
  case "$reply" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

# expand_tilde PATH — turn a leading ~ into $HOME ('read -r' keeps it literal otherwise).
expand_tilde() {
  case "$1" in
    '~') printf '%s' "$HOME" ;;
    '~/'*) printf '%s/%s' "$HOME" "${1#\~/}" ;;
    *) printf '%s' "$1" ;;
  esac
}

# ask_value VARNAME "label" "default" — prompt for a path on the tty; empty reply keeps
# the default. Bash 'printf -v' assigns back to the named variable.
ask_value() {
  local __var="$1" label="$2" def="$3" reply
  printf '  %s [%s]: ' "$label" "$def" >/dev/tty
  read -r reply </dev/tty || reply=""
  if [ -n "$reply" ]; then printf -v "$__var" '%s' "$reply"; else printf -v "$__var" '%s' "$def"; fi
}

# Best-effort shell rc file for an optional PATH edit.
shell_rc_file() {
  case "${SHELL:-}" in
    *zsh) printf '%s' "${ZDOTDIR:-$HOME}/.zshrc" ;;
    *bash) [ -f "$HOME/.bashrc" ] && printf '%s' "$HOME/.bashrc" || printf '%s' "$HOME/.bash_profile" ;;
    *) printf '%s' "$HOME/.profile" ;;
  esac
}

# offer_path_update BIN_DIR — when BIN_DIR is not on PATH, offer (interactive only) to
# append the export to the shell rc; idempotent. Non-interactive keeps the manual note.
offer_path_update() {
  local bindir="$1" rc line
  line="export PATH=\"${bindir}:\$PATH\""
  rc="$(shell_rc_file)"
  if tty_available && [ -n "$rc" ] && ask_yes_no "${bindir} is not on PATH. Add it to ${rc}?"; then
    if [ -f "$rc" ] && grep -qF "$line" "$rc"; then
      green "  [OK] already in ${rc}"
    else
      printf '\n# Added by farmslot install\n%s\n' "$line" >>"$rc"
      green "  [OK] added to ${rc} — open a new terminal or run: source ${rc}"
    fi
  else
    echo "  note: ${bindir} is not on PATH — add: ${line}"
  fi
}

# step_configure — choose install locations interactively (tty only). Each path the user
# did NOT pin via env is prompted with its default; a fully-pinned or non-interactive
# (CI / piped) install stays silent and reproducible. Always finalizes (tilde-expand +
# export FARMSLOT_HOME) so every child process resolves the same home.
step_configure() {
  local prompted=
  if tty_available; then
    bold "── Install locations ──"
    [ -z "$WORKSPACE_FROM_ENV" ] && { ask_value WORKSPACE "Install location (workspace)" "$WORKSPACE"; prompted=1; }
    [ -z "$BIN_DIR_FROM_ENV" ] && { ask_value BIN_DIR "CLI symlink dir" "$BIN_DIR"; prompted=1; }
    [ -z "$HOME_FROM_ENV" ] && { ask_value HOME_DIR "State/home dir" "$HOME_DIR"; prompted=1; }
  fi
  WORKSPACE="$(expand_tilde "$WORKSPACE")"
  BIN_DIR="$(expand_tilde "$BIN_DIR")"
  HOME_DIR="$(expand_tilde "$HOME_DIR")"
  if [ -n "$prompted" ]; then
    printf '\n  workspace: %s\n  bin dir:   %s\n  home dir:  %s\n' "$WORKSPACE" "$BIN_DIR" "$HOME_DIR" >/dev/tty
    ask_yes_no "Proceed with these locations?" \
      || fail "install cancelled" "re-run, or set FARMSLOT_WORKSPACE / FARMSLOT_BIN_DIR / FARMSLOT_HOME to choose non-interactively"
  fi
  export FARMSLOT_HOME="$HOME_DIR"
}

activate_version_managers() {
  # Non-interactive installers do not source shell profiles. Put common manager
  # shims on PATH so an existing asdf/nvm setup works before we decide anything
  # is missing.
  if [ -d "${ASDF_DATA_DIR:-$HOME/.asdf}/shims" ]; then
    export PATH="${ASDF_DATA_DIR:-$HOME/.asdf}/shims:${ASDF_DATA_DIR:-$HOME/.asdf}/bin:${PATH}"
  fi
  export NVM_DIR="${NVM_DIR:-${HOME}/.nvm}"
  if [ -s "${NVM_DIR}/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "${NVM_DIR}/nvm.sh"
    if ! command -v node >/dev/null 2>&1; then
      nvm use default >/dev/null 2>&1 || nvm use --lts >/dev/null 2>&1 || true
    fi
  fi
}

brew_formula_for() {
  case "$1" in
    python3) echo python ;;
    *) echo "$1" ;;
  esac
}

check_cmd_or_brew() {
  local name="$1" hint="$2" formula
  if command -v "$name" >/dev/null 2>&1; then
    green "  [OK] ${name}"
    return
  fi
  if [ "$(uname)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
    formula="$(brew_formula_for "$name")"
    if ask_yes_no "${name} is missing. Install ${formula} with Homebrew now?"; then
      run_step "brew install ${formula}" brew install "$formula"
      command -v "$name" >/dev/null 2>&1 && { green "  [OK] ${name}"; return; }
    fi
  fi
  fail "${name} not found on PATH" "$hint"
}

source_nvm() {
  export NVM_DIR="${NVM_DIR:-${HOME}/.nvm}"
  [ -s "${NVM_DIR}/nvm.sh" ] || return 1
  # shellcheck disable=SC1091
  . "${NVM_DIR}/nvm.sh"
}

use_asdf_node() {
  local version="$1" root
  command -v asdf >/dev/null 2>&1 || return 1
  if ! asdf plugin list 2>/dev/null | grep -qx nodejs; then
    asdf plugin add nodejs || return 1
  fi
  if ! asdf where nodejs "$version" >/dev/null 2>&1; then
    asdf install nodejs "$version" || return 1
  fi
  root="$(asdf where nodejs "$version" 2>/dev/null)" || return 1
  [ -n "$root" ] && [ -x "$root/bin/node" ] || return 1
  export ASDF_NODEJS_VERSION="$version"
  export PATH="$root/bin:$PATH"
}

use_nvm_node() {
  local version="$1"
  source_nvm || return 1
  if ! nvm which "$version" >/dev/null 2>&1; then
    nvm install "$version" || return 1
  fi
  nvm use "$version" >/dev/null 2>&1
}

ensure_yarn() {
  if command -v yarn >/dev/null 2>&1; then
    green "  [OK] yarn"
    return
  fi
  if command -v corepack >/dev/null 2>&1; then
    run_step "enable corepack" corepack enable
  fi
  command -v yarn >/dev/null 2>&1 \
    && green "  [OK] yarn" \
    || fail "yarn not found on PATH" "run: corepack enable (ships with node)"
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

capture_helper_bin() {
  local helper_script="${CLONE:-}/scripts/lib/capture-helper.sh"
  [ -f "$helper_script" ] || return 1
  # shellcheck disable=SC1090
  FARMSLOT_CAPTURE_HELPER_REPO_ROOT="$CLONE" . "$helper_script"
  resolve_capture_helper_bin
}

capture_helper_doctor() {
  local helper="$1"
  python3 - "$helper" <<'PYDOCTOR'
import subprocess, sys
helper = sys.argv[1]
try:
    subprocess.run(
        [helper, "doctor", "--json"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=20,
        check=True,
    )
except Exception:
    sys.exit(1)
PYDOCTOR
}

# ── Steps ────────────────────────────────────────────────────────────────────

# Dev/test mode when run from inside a checkout; otherwise clone the remote.
step_detect_source() {
  SOURCE_MODE="git"
  SOURCE=""
  if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
    local script_dir
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    if [ -f "${script_dir}/packages/cli/bin/farmslot.mjs" ]; then
      if [ -d "${script_dir}/.git" ] || [ -f "${script_dir}/.git" ]; then
        SOURCE_MODE="local"
        SOURCE="$script_dir"
      fi
    fi
  fi
  if [ "$SOURCE_MODE" = "git" ]; then
    SOURCE="${FARMSLOT_REPO_URL:-$DEFAULT_REPO_URL}"
  fi
  CLONE="${WORKSPACE}/farmslot"
}

step_base_prereqs() {
  bold "── Base prerequisites ──"
  check_cmd_or_brew git "macOS: xcode-select --install or brew install git · Linux: apt install git"
}

step_runtime_prereqs() {
  bold "── Runtime prerequisites ──"
  ensure_yarn
  check_cmd_or_brew tmux "macOS: brew install tmux · Linux: apt install tmux"
  check_cmd_or_brew python3 "macOS: brew install python3 · Linux: apt install python3"
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
  local required_node node_version recommended_node
  # Hard floor = engines.node in package.json (the minimum we support).
  required_node="$(sed -n 's/.*"node": *"\([^"]*\)".*/\1/p' "${CLONE}/package.json" | head -1)"
  # Recommended = .tool-versions (what maintainers run; newer is better).
  recommended_node="$(sed -n 's/^nodejs \([0-9.]*\).*/\1/p' "${CLONE}/.tool-versions" 2>/dev/null | head -1)"
  if ! command -v node >/dev/null 2>&1; then
    if [ -n "$recommended_node" ] && use_asdf_node "$recommended_node"; then
      green "  [OK] node $(node --version) (asdf)"
    elif [ -n "$recommended_node" ] && use_nvm_node "$recommended_node"; then
      green "  [OK] node $(node --version) (nvm)"
    elif [ "$(uname)" = "Darwin" ] && command -v brew >/dev/null 2>&1 \
      && ask_yes_no "node is missing. Install node with Homebrew now?"; then
      run_step "brew install node" brew install node
    fi
  fi
  command -v node >/dev/null 2>&1 \
    || fail "node not found on PATH" "install node via asdf/nvm/brew; Farmslot recommends ${recommended_node:-the version in .tool-versions}"
  node_version="$(node --version | tr -d 'v')"
  node -e "
const min = ('${required_node}'.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/) || []).slice(1).map(n => Number(n || 0));
const cur = '${node_version}'.split('.').map(Number);
if (!min.length) process.exit(0);
for (let i = 0; i < 3; i++) { if (cur[i] !== min[i]) process.exit(cur[i] > min[i] ? 0 : 1); }
" || {
    if [ -n "$recommended_node" ] && use_asdf_node "$recommended_node"; then
      node_version="$(node --version | tr -d 'v')"
    elif [ -n "$recommended_node" ] && use_nvm_node "$recommended_node"; then
      node_version="$(node --version | tr -d 'v')"
    fi
    node -e "
const min = ('${required_node}'.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/) || []).slice(1).map(n => Number(n || 0));
const cur = '${node_version}'.split('.').map(Number);
if (!min.length) process.exit(0);
for (let i = 0; i < 3; i++) { if (cur[i] !== min[i]) process.exit(cur[i] > min[i] ? 0 : 1); }
" || fail "node ${node_version} is below the minimum ${required_node}" "upgrade node — asdf: asdf install nodejs ${recommended_node:-latest}, or nvm install ${recommended_node:-'--lts'}"
  }
  # Below the recommended version is fine — warn, don't block. Lets devs reuse an
  # existing LTS (e.g. the one their product repos pin) instead of forcing a switch.
  if [ -n "$recommended_node" ] && ! node -e "
const rec = '${recommended_node}'.split('.').map(Number);
const cur = '${node_version}'.split('.').map(Number);
for (let i = 0; i < 3; i++) { const a = cur[i] || 0, b = rec[i] || 0; if (a !== b) process.exit(a > b ? 0 : 1); }
" 2>/dev/null; then
    printf '\033[0;33m  [WARN] node %s works (>= %s), but %s+ is recommended — newer is better; see .tool-versions\033[0m\n' \
      "$node_version" "$required_node" "$recommended_node"
  else
    green "  [OK] node ${node_version} (>= ${required_node})"
  fi
}

step_capture_helper() {
  [ "$(uname)" = "Darwin" ] || return
  case "${FARMSLOT_SKIP_CAPTURE_HELPER:-}" in 1|true) return ;; esac
  bold "── Capture helper ──"
  local npm_pkg="${FARMSLOT_CAPTURE_HELPER_NPM_PACKAGE:-@siteed/capture-helper}"
  local brew_formula="${FARMSLOT_CAPTURE_HELPER_BREW_FORMULA:-capture-helper}"
  local helper_bin=""
  helper_bin="$(capture_helper_bin || true)"
  if [ -z "$helper_bin" ]; then
    if command -v brew >/dev/null 2>&1 \
      && ask_yes_no "capture-helper is missing. Install ${brew_formula} with Homebrew now?"; then
      if brew install "$brew_formula"; then
        green "  [OK] capture-helper installed via Homebrew"
      else
        yellow "  [WARN] Homebrew install failed for ${brew_formula}; trying npm if allowed"
      fi
    fi
    helper_bin="$(capture_helper_bin || true)"
    if [ -z "$helper_bin" ] \
      && command -v npm >/dev/null 2>&1 \
      && ask_yes_no "Install ${npm_pkg} globally with npm now?"; then
      npm install -g "$npm_pkg"
      helper_bin="$(capture_helper_bin || true)"
    fi
  fi
  if [ -n "$helper_bin" ]; then
    if capture_helper_doctor "$helper_bin"; then
      green "  [OK] capture-helper doctor (${helper_bin})"
    else
      yellow "  [WARN] capture-helper is installed but doctor failed or timed out (${helper_bin})"
      echo "  fix: run '${helper_bin}' doctor --json and grant Screen Recording permission if requested"
    fi
  else
    yellow "  [WARN] capture-helper not installed — live screenshots/video will be unavailable"
    echo "  fix: npm install -g ${npm_pkg}  # or install the Homebrew formula"
  fi
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
    *) offer_path_update "$BIN_DIR" ;;
  esac
}

step_workspace() {
  bold "── Workspace ──"
  FARMSLOT_WORKSPACE="$WORKSPACE" "$FARMSLOT_BIN" workspace init --source-mode "$SOURCE_MODE" --source "$SOURCE" --bin-dir "$BIN_DIR" --home-dir "$HOME_DIR"
}

step_doctor() {
  echo ""
  FARMSLOT_WORKSPACE="$WORKSPACE" "$FARMSLOT_BIN" doctor
}

# Quick win: start the local gateway and show a QR to pair the mobile companion
# app for tmux control on the go. Reads y/n from /dev/tty so a piped `curl | bash`
# can still prompt; a non-interactive install (CI, no tty) skips without hanging.
# One-time GitHub star ask — inline bash so we don't need a public CLI command.
# Reads from /dev/tty so `curl | bash` still prompts; shares ~/.farmslot/state/
# star-prompt.json with the CLI doctor/up hook.
step_star() {
  case "${FARMSLOT_NO_STAR_PROMPT:-}" in 1|true) return ;; esac
  if ! command -v gh >/dev/null 2>&1; then
    return
  fi
  if ! gh auth status >/dev/null 2>&1; then
    return
  fi
  if ! tty_available; then
    return
  fi
  local star_state="${FARMSLOT_HOME:-${HOME}/.farmslot}/state/star-prompt.json"
  if [ -f "$star_state" ]; then
    return
  fi
  local reply
  mkdir -p "$(dirname "$star_state")"
  printf '{"prompted_at":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$star_state"
  printf '  Enjoying farmslot? Star it on GitHub? [Y/n] ' >/dev/tty
  read -r reply </dev/tty || reply=""
  case "$reply" in [Nn]*) return ;; esac
  if gh repo star deeeed/farmslot >/dev/null 2>&1; then
    green '  [OK] Thanks for the star!'
  else
    printf '\033[0;33m  [WARN] Could not star repository automatically — run: gh repo star deeeed/farmslot\033[0m\n'
  fi
}

step_pair() {
  bold "── Start it up ──"
  local start_now="" pair_now="" reply
  if [ -n "${FARMSLOT_MINIMAL:-}" ]; then
    echo "  skipped (FARMSLOT_MINIMAL) — start later with: farmslot up  (then 'farmslot pair' for phone)"
    return
  elif [ "${FARMSLOT_PAIR:-}" = "1" ]; then
    start_now="yes"; pair_now="yes"
  elif tty_available; then
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
  bold "=== farmslot install ==="
  step_configure
  step_detect_source
  activate_version_managers
  echo "  workspace: ${WORKSPACE}"
  echo "  source:    ${SOURCE} (${SOURCE_MODE})"
  echo ""
  step_base_prereqs
  step_clone
  step_node
  step_runtime_prereqs
  step_capture_helper
  step_runners
  step_cli
  step_workspace
  step_doctor
  step_star
  step_pair
}

main "$@"
