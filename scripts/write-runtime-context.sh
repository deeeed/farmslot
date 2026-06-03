#!/usr/bin/env bash
# write-runtime-context.sh — Write a generic, ignored runtime discovery contract.
#
# This intentionally does not encode Farmslot-specific behavior. Farmslot is only
# one producer of temp/runtime/agentic-runtime.json; skills and harnesses consume
# the generic contract.
set -euo pipefail

REPO=""
PROJECT=""
SLOT_ID=""
MACHINE=""
RUNTIME_OWNER=""
PLATFORM=""
RUNTIME_DIR="temp/runtime"
CDP_PORT=""
WATCHER_PORT=""
METRO_PORT=""
DEV_SERVER_PORT=""
SIMULATOR=""
ADB_SERIAL=""
STRICT="true"
RUNTIME_START_COMMAND=""
RUNTIME_START_APPROVED="false"
RUNTIME_READY_URL=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --project) PROJECT="$2"; shift 2 ;;
    --slot-id) SLOT_ID="$2"; shift 2 ;;
    --machine) MACHINE="$2"; shift 2 ;;
    --runtime-owner) RUNTIME_OWNER="$2"; shift 2 ;;
    --platform) PLATFORM="$2"; shift 2 ;;
    --runtime-dir) RUNTIME_DIR="$2"; shift 2 ;;
    --cdp-port) CDP_PORT="$2"; shift 2 ;;
    --watcher-port|--port) WATCHER_PORT="$2"; shift 2 ;;
    --metro-port) METRO_PORT="$2"; shift 2 ;;
    --dev-server-port) DEV_SERVER_PORT="$2"; shift 2 ;;
    --simulator) SIMULATOR="$2"; shift 2 ;;
    --adb-serial) ADB_SERIAL="$2"; shift 2 ;;
    --strict) STRICT="$2"; shift 2 ;;
    --runtime-start-command) RUNTIME_START_COMMAND="$2"; shift 2 ;;
    --runtime-start-approved) RUNTIME_START_APPROVED="$2"; shift 2 ;;
    --runtime-ready-url) RUNTIME_READY_URL="$2"; shift 2 ;;
    -h|--help)
      cat <<'USAGE'
Usage: write-runtime-context.sh --repo <repo> --slot-id <slot> [options]

Writes <repo>/temp/runtime/agentic-runtime.json. Optional fields:
  --project <name> --machine <name> --runtime-owner <owner> --platform <platform>
  --cdp-port <port> --watcher-port <port> --metro-port <port> --dev-server-port <port>
  --simulator <name> --adb-serial <serial> --runtime-dir <dir> --strict true|false
  --runtime-start-approved true|false --runtime-start-command <cmd> --runtime-ready-url <url>
USAGE
      exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

[ -n "$REPO" ] || { echo "Missing --repo" >&2; exit 2; }
REPO_ABS="$(cd "$REPO" && pwd -P)"
OUT_DIR="$REPO_ABS/temp/runtime"
OUT="$OUT_DIR/agentic-runtime.json"
ENV_OUT="$OUT_DIR/agentic-runtime.env"
mkdir -p "$OUT_DIR"

# Prefer explicit machine, but derive a useful default from slot id prefixes such
# as runner-browser-2 or mini-mm-1.
if [ -z "$MACHINE" ] && [ -n "$SLOT_ID" ]; then
  MACHINE="${SLOT_ID%%-*}"
fi
if [ -z "$METRO_PORT" ]; then METRO_PORT="$WATCHER_PORT"; fi
if [ -z "$DEV_SERVER_PORT" ]; then DEV_SERVER_PORT="$WATCHER_PORT"; fi

export REPO_ABS OUT ENV_OUT PROJECT SLOT_ID MACHINE RUNTIME_OWNER PLATFORM RUNTIME_DIR CDP_PORT WATCHER_PORT METRO_PORT DEV_SERVER_PORT SIMULATOR ADB_SERIAL STRICT RUNTIME_START_COMMAND RUNTIME_START_APPROVED RUNTIME_READY_URL
python3 - <<'PY'
import json, os, pathlib, subprocess, time
repo = pathlib.Path(os.environ['REPO_ABS'])
out = pathlib.Path(os.environ['OUT'])
env_out = pathlib.Path(os.environ['ENV_OUT'])

def val(name):
    v = os.environ.get(name, '').strip()
    return v if v else None

def int_val(name):
    v = val(name)
    try:
        return int(v) if v is not None else None
    except ValueError:
        return v

def git(args):
    try:
        return subprocess.check_output(['git', '-C', str(repo), *args], text=True, stderr=subprocess.DEVNULL).strip() or None
    except Exception:
        return None

def extension_id():
    default_root = 'temp/agentic/recipe-harness'
    harness_root = os.environ.get('RECIPE_HARNESS_ROOT', default_root)
    # Validate like harness-path.sh; fall back to default on an unsafe value.
    safe = (harness_root and not harness_root.startswith('/')
            and all(c.isalnum() or c in '._/-' for c in harness_root)
            and not any(part in ('.', '..') for part in harness_root.split('/')))
    if not safe:
        harness_root = default_root
    for rel in ['temp/runtime/extension.id', f'{harness_root}/extension.id']:
        p = repo / rel
        try:
            s = p.read_text().strip()
        except Exception:
            continue
        if len(s) == 32 and s.isalpha() and s.islower():
            return s
    return None

ctx = {
    'schemaVersion': 1,
    'project': val('PROJECT'),
    'repoRoot': str(repo),
    'slotId': val('SLOT_ID'),
    'machine': val('MACHINE'),
    'runtimeOwner': val('RUNTIME_OWNER') or 'unknown',
    'strict': (val('STRICT') or 'true').lower() not in {'0', 'false', 'no'},
    'platform': val('PLATFORM'),
    'cdpPort': int_val('CDP_PORT'),
    'watcherPort': int_val('WATCHER_PORT'),
    'metroPort': int_val('METRO_PORT'),
    'devServerPort': int_val('DEV_SERVER_PORT'),
    'simulator': val('SIMULATOR'),
    'adbSerial': val('ADB_SERIAL'),
    'runtimeDir': val('RUNTIME_DIR'),
    'distDir': 'dist/chrome' if (repo / 'dist/chrome').exists() else None,
    'extensionId': extension_id(),
    'gitHead': git(['rev-parse', 'HEAD']),
    'gitBranch': git(['branch', '--show-current']),
    'gitDirty': bool(git(['status', '--short'])),
    'createdAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
}
runtime_start = {
    'approved': (val('RUNTIME_START_APPROVED') or 'false').lower() in {'1', 'true', 'yes'},
    'command': val('RUNTIME_START_COMMAND'),
    'readyUrl': val('RUNTIME_READY_URL'),
}
runtime_start = {k: v for k, v in runtime_start.items() if v is not None and v != ''}
if runtime_start:
    ctx['runtimeStart'] = runtime_start
ctx = {k: v for k, v in ctx.items() if v is not None and v != ''}
out.write_text(json.dumps(ctx, indent=2, sort_keys=True) + '\n')

env = {
    'RECIPE_RUNTIME_CONTEXT': str(out),
    'RECIPE_RUNTIME_STRICT': '1' if ctx.get('strict') else '0',
    'RECIPE_SLOT_ID': ctx.get('slotId'),
    'RECIPE_MACHINE': ctx.get('machine'),
    'RECIPE_PLATFORM': ctx.get('platform'),
    'RECIPE_RUNTIME_OWNER': ctx.get('runtimeOwner'),
    'RECIPE_CDP_PORT': ctx.get('cdpPort'),
    'CDP_PORT': ctx.get('cdpPort'),
    'RECIPE_WATCHER_PORT': ctx.get('watcherPort'),
    'WATCHER_PORT': ctx.get('watcherPort'),
    'RECIPE_METRO_PORT': ctx.get('metroPort'),
    'METRO_PORT': ctx.get('metroPort'),
    'RECIPE_DEV_SERVER_PORT': ctx.get('devServerPort'),
    'IOS_SIMULATOR': ctx.get('simulator'),
    'SIMULATOR': ctx.get('simulator'),
    'ANDROID_SERIAL': ctx.get('adbSerial'),
    'ADB_SERIAL': ctx.get('adbSerial'),
    'RECIPE_HARNESS_EXTENSION_ID': ctx.get('extensionId'),
}
runtime_start_ctx = ctx.get('runtimeStart') or {}
env.update({
    'RECIPE_RUNTIME_START_APPROVED': '1' if runtime_start_ctx.get('approved') else '0',
    'RECIPE_RUNTIME_START_CMD': runtime_start_ctx.get('command'),
    'RECIPE_RUNTIME_READY_URL': runtime_start_ctx.get('readyUrl'),
})
lines = [
    '# shellcheck shell=sh',
    '# Generic agentic runtime context. Safe to source; generated by write-runtime-context.sh.',
]
for key, value in env.items():
    if value is None or value == '':
        continue
    s = str(value).replace("'", "'\"'\"'")
    lines.append(f"export {key}='{s}'")
env_out.write_text('\n'.join(lines) + '\n')
print(out)
PY
