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
# Env:
#   FARMSLOT_WORKSPACE  workspace dir              (default: ~/dev/farmslot-workspace)
#   FARMSLOT_REPO_URL   git source for fresh mode  (default: the canonical repo URL)
#   FARMSLOT_BIN_DIR    dir for the PATH symlink   (default: ~/.local/bin)
set -euo pipefail

WORKSPACE="${FARMSLOT_WORKSPACE:-${HOME}/dev/farmslot-workspace}"
BIN_DIR="${FARMSLOT_BIN_DIR:-${HOME}/.local/bin}"
# Fresh (piped) installs clone this repo; override with FARMSLOT_REPO_URL.
# Dev/test mode (run from a checkout) uses the checkout itself as the source.
DEFAULT_REPO_URL="https://github.com/deeeed/farmslot.git"

red() { printf '\033[0;31m%s\033[0m\n' "$1"; }
green() { printf '\033[0;32m%s\033[0m\n' "$1"; }
bold() { printf '\033[1m%s\033[0m\n' "$1"; }

fail() {
  red "FAIL: $1"
  [ -n "${2:-}" ] && echo "  fix: $2"
  exit 1
}

# ── Source detection: dev/test mode when run from inside a checkout ─────────
SOURCE_MODE="git"
SOURCE=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [ -f "${script_dir}/packages/cli/bin/farmslot.mjs" ] && [ -d "${script_dir}/.git" ]; then
    SOURCE_MODE="local"
    SOURCE="$script_dir"
  fi
fi
if [ "$SOURCE_MODE" = "git" ]; then
  SOURCE="${FARMSLOT_REPO_URL:-$DEFAULT_REPO_URL}"
fi

bold "=== farmslot install ==="
echo "  workspace: ${WORKSPACE}"
echo "  source:    ${SOURCE} (${SOURCE_MODE})"
echo ""

# ── Prerequisites (check only — never auto-install) ─────────────────────────
bold "── Prerequisites ──"
check_cmd() {
  local name="$1" hint="$2"
  if command -v "$name" >/dev/null 2>&1; then
    green "  [OK] ${name}"
  else
    fail "${name} not found on PATH" "$hint"
  fi
}
check_cmd git "macOS: xcode-select --install · Linux: apt install git"
check_cmd node "install node (see .tool-versions) via https://nodejs.org or asdf/nvm"
check_cmd yarn "corepack enable (ships with node)"
check_cmd tmux "macOS: brew install tmux · Linux: apt install tmux"
check_cmd python3 "macOS: brew install python3 · Linux: apt install python3"

# ── Runners: require at least one AUTHENTICATED runner ──────────────────────
bold "── Runners ──"
runner_authenticated=0
# check_runner <name> <auth-cmd...> — three states: missing / inactive / authenticated
check_runner() {
  local name="$1" install_hint="$2" login_hint="$3"
  shift 3
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "  [--] ${name} not found — ${install_hint}"
    return 0
  fi
  # Authenticated = probe exits 0 AND prints a positive marker. "Not logged in"
  # or a nonzero exit is inactive. Markers mirror packages/cli prereqs.ts.
  local probe_out
  # 2>&1: some runners print auth status to stderr — prereqs.ts matches both too.
  if probe_out="$("$@" 2>&1)" && echo "$probe_out" | grep -qiE '"loggedin": *true|logged in (as|using)'; then
    green "  [OK] ${name} (authenticated)"
    runner_authenticated=1
  else
    printf '\033[0;33m  [WARN] %s on PATH but not signed in — %s\033[0m\n' "$name" "$login_hint"
  fi
}
check_runner claude "npm install -g @anthropic-ai/claude-code" "run: claude (sign in)" claude auth status
check_runner codex "npm install -g @openai/codex" "run: codex login" codex login status
check_runner cursor-agent "see https://cursor.com/cli" "run: cursor-agent login" cursor-agent status
[ "$runner_authenticated" = 1 ] || fail "no authenticated agent runner" "install and sign in to at least one of: claude, codex, cursor-agent"

# ── Clone / update the farmslot repo ────────────────────────────────────────
bold "── Farmslot repo ──"
mkdir -p "$WORKSPACE"
CLONE="${WORKSPACE}/farmslot"
if [ -d "${CLONE}/.git" ]; then
  echo "  clone exists — refreshing from source"
  # Re-point origin at the current source so a changed FARMSLOT_REPO_URL or a
  # git↔local mode switch is applied instead of silently ignored.
  git -C "$CLONE" remote set-url origin "$SOURCE"
  git -C "$CLONE" fetch origin --quiet
  if [ "$SOURCE_MODE" = "local" ]; then
    src_branch="$(git -C "$SOURCE" rev-parse --abbrev-ref HEAD)"
  else
    src_branch="main"
  fi
  git -C "$CLONE" checkout --quiet "$src_branch" 2>/dev/null || git -C "$CLONE" checkout --quiet -b "$src_branch" "origin/${src_branch}"
  git -C "$CLONE" reset --hard --quiet "origin/${src_branch}"
else
  if [ "$SOURCE_MODE" = "local" ]; then
    git clone --quiet "$SOURCE" "$CLONE"
  else
    git clone --quiet --branch main "$SOURCE" "$CLONE"
  fi
fi
green "  [OK] ${CLONE} ($(git -C "$CLONE" rev-parse --abbrev-ref HEAD) @ $(git -C "$CLONE" rev-parse --short HEAD))"

# ── Node version vs engines (read from the cloned package.json) ─────────────
required_node="$(sed -n 's/.*"node": *"\([^"]*\)".*/\1/p' "${CLONE}/package.json" | head -1)"
node_version="$(node --version | tr -d 'v')"
node -e "
const min = ('${required_node}'.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/) || []).slice(1).map(n => Number(n || 0));
const cur = '${node_version}'.split('.').map(Number);
if (!min.length) process.exit(0);
for (let i = 0; i < 3; i++) { if (cur[i] !== min[i]) process.exit(cur[i] > min[i] ? 0 : 1); }
" || fail "node ${node_version} does not satisfy required ${required_node}" "upgrade node (see .tool-versions)"
green "  [OK] node ${node_version} satisfies ${required_node}"

# ── Install dependencies + verify the CLI runs ──────────────────────────────
bold "── CLI ──"
echo "  yarn install (workspace) ..."
install_log="${WORKSPACE}/.install-yarn.log"
if ! (cd "$CLONE" && yarn install >"$install_log" 2>&1); then
  tail -40 "$install_log"
  fail "yarn install failed in ${CLONE}" "full log: ${install_log}"
fi
echo "  building CLI workspace deps ..."
build_log="${WORKSPACE}/.install-build.log"
if ! (cd "$CLONE" && yarn workspace @farmslot/recipe-harness build >"$build_log" 2>&1); then
  tail -40 "$build_log"
  fail "workspace package build failed in ${CLONE}" "full log: ${build_log}"
fi
FARMSLOT_BIN="${CLONE}/packages/cli/bin/farmslot.mjs"
"$FARMSLOT_BIN" --version >/dev/null || fail "farmslot CLI failed to run" "check the yarn install output above"
green "  [OK] farmslot CLI runs"

# ── PATH symlink ─────────────────────────────────────────────────────────────
mkdir -p "$BIN_DIR"
ln -sf "$FARMSLOT_BIN" "${BIN_DIR}/farmslot"
green "  [OK] symlink ${BIN_DIR}/farmslot"
case ":$PATH:" in
  *":${BIN_DIR}:"*) ;;
  *) echo "  note: ${BIN_DIR} is not on PATH — add: export PATH=\"${BIN_DIR}:\$PATH\"" ;;
esac

# ── Workspace state + pool ───────────────────────────────────────────────────
bold "── Workspace ──"
FARMSLOT_WORKSPACE="$WORKSPACE" "$FARMSLOT_BIN" workspace init --source-mode "$SOURCE_MODE" --source "$SOURCE" --bin-dir "$BIN_DIR"

# ── Doctor ───────────────────────────────────────────────────────────────────
echo ""
FARMSLOT_WORKSPACE="$WORKSPACE" "$FARMSLOT_BIN" doctor
