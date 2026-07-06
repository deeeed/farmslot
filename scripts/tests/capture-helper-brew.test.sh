#!/usr/bin/env bash
# install.sh's capture-helper Homebrew path must use a fully-qualified
# tap/formula. A bare `capture-helper` resolves to no formula on a fresh machine
# (the formula lives in deeeed/homebrew-tap); brew auto-taps on a qualified name.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
INSTALL="$REPO_ROOT/install.sh"

fail() {
  echo "[capture-helper-brew] FAIL: $1" >&2
  exit 1
}

[ -f "$INSTALL" ] || fail "install.sh not found at $INSTALL"

# Extract the ACTUAL default from install.sh's parameter expansion, not a copy.
default_expr="$(grep -oE 'FARMSLOT_CAPTURE_HELPER_BREW_FORMULA:-[^}"]+' "$INSTALL" | head -1)"
[ -n "$default_expr" ] || fail "no FARMSLOT_CAPTURE_HELPER_BREW_FORMULA default expansion found"
default_value="${default_expr#FARMSLOT_CAPTURE_HELPER_BREW_FORMULA:-}"

# 1. Default is the fully-qualified tap/formula.
[ "$default_value" = "deeeed/tap/capture-helper" ] \
  || fail "default brew formula is '$default_value', expected 'deeeed/tap/capture-helper'"
case "$default_value" in
  */*/*) : ;; # tap owner/tap/formula — qualified, brew auto-taps
  *) fail "default brew formula '$default_value' is not fully qualified (owner/tap/formula)" ;;
esac

# 2. Env override is still honored (the :- expansion prefers a set value).
unset FARMSLOT_CAPTURE_HELPER_BREW_FORMULA
resolved="${FARMSLOT_CAPTURE_HELPER_BREW_FORMULA:-$default_value}"
[ "$resolved" = "$default_value" ] || fail "unset override should resolve to the default"
FARMSLOT_CAPTURE_HELPER_BREW_FORMULA="acme/tap/custom-helper"
resolved="${FARMSLOT_CAPTURE_HELPER_BREW_FORMULA:-$default_value}"
[ "$resolved" = "acme/tap/custom-helper" ] || fail "a set override must win over the default"
unset FARMSLOT_CAPTURE_HELPER_BREW_FORMULA

# 3. The not-installed teach line names the exact brew command (qualified formula).
grep -qE 'fix: brew install \$\{brew_formula\}' "$INSTALL" \
  || fail "teach line must offer 'brew install \${brew_formula}'"

# 4. No unqualified bare `brew install capture-helper` literal anywhere.
if grep -nE 'brew install +capture-helper( |$)' "$INSTALL"; then
  fail "found an unqualified 'brew install capture-helper' literal"
fi

echo "[capture-helper-brew] PASS"
