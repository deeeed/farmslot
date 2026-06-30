#!/usr/bin/env bash
# Shared capture-helper binary resolution for Farmslot shell entrypoints.

capture_helper_realpath() {
  local python_bin=""
  python_bin="$(command -v python3 2>/dev/null || true)"
  if [ -z "$python_bin" ] && [ -x /usr/bin/python3 ]; then
    python_bin=/usr/bin/python3
  fi
  if [ -n "$python_bin" ]; then
    "$python_bin" - "$1" <<'PYREAL' 2>/dev/null && return 0
import os, sys
print(os.path.realpath(sys.argv[1]))
PYREAL
  fi
  local perl_bin=""
  perl_bin="$(command -v perl 2>/dev/null || true)"
  if [ -z "$perl_bin" ] && [ -x /usr/bin/perl ]; then
    perl_bin=/usr/bin/perl
  fi
  if [ -n "$perl_bin" ]; then
    "$perl_bin" -MCwd=abs_path -e 'print abs_path($ARGV[0]) // ""' "$1" 2>/dev/null && return 0
  fi
  return 1
}

capture_helper_native_for_wrapper() {
  local real
  real="$(capture_helper_realpath "$1")"
  case "$real" in
    */bin/capture-helper.js)
      printf '%s/native/capture-helper' "${real%/bin/capture-helper.js}"
      return 0
      ;;
  esac
  return 1
}

capture_helper_is_wrapper_shim() {
  case "$1" in
    */node_modules/.bin/capture-helper) return 0 ;;
  esac
  local real
  real="$(capture_helper_realpath "$1")"
  case "$real" in
    */bin/capture-helper.js) return 0 ;;
    *) return 1 ;;
  esac
}

resolve_capture_helper_bin() {
  local repo_root="${FARMSLOT_CAPTURE_HELPER_REPO_ROOT:-}"
  local npm_pkg="${FARMSLOT_CAPTURE_HELPER_NPM_PACKAGE:-@siteed/capture-helper}"
  local npm_root=""
  npm_root="$(npm root -g 2>/dev/null || true)"
  local command_path=""
  command_path="$(command -v capture-helper 2>/dev/null || true)"
  local candidate native
  for candidate in \
    "${CAPTURE_HELPER_PATH:-}" \
    "${SITEED_CAPTURE_HELPER_BIN:-}" \
    "${repo_root:+${repo_root}/node_modules/${npm_pkg}/native/capture-helper}" \
    "${HOME:+${HOME}/.npm-global/lib/node_modules/${npm_pkg}/native/capture-helper}" \
    "${npm_root:+${npm_root}/${npm_pkg}/native/capture-helper}" \
    "${command_path}"; do
    [ -n "$candidate" ] || continue
    native="$(capture_helper_native_for_wrapper "$candidate" || true)"
    if [ -n "$native" ] && [ -x "$native" ]; then
      printf '%s' "$native"
      return 0
    fi
    if ! capture_helper_is_wrapper_shim "$candidate" && [ -x "$candidate" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}
