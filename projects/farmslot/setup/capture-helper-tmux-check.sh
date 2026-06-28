#!/usr/bin/env bash
# Verify capture-helper Screen Recording TCC from the current shell (tmux pane or direct).
# Exit 0 when doctor ok=true; exit 1 with remediation when screen_recording_denied.
set -euo pipefail

OUT="${1:-/tmp/capture-helper-pane-check.json}"
BIN="${CAPTURE_HELPER_PATH:-${SITEED_CAPTURE_HELPER_BIN:-capture-helper}}"

echo "[capture-helper-tmux-check] running doctor via ${BIN}" >&2
"${BIN}" doctor --json >"${OUT}" 2>&1 || true

python3 - <<'PY' "${OUT}"
import json, sys
path = sys.argv[1]
raw = open(path).read()
try:
    doc = json.loads(raw)
except json.JSONDecodeError:
    print(f"FAIL: doctor did not return JSON (see {path})", file=sys.stderr)
    sys.exit(1)
ok = doc.get("ok") is True
print(f"ok={ok} version={doc.get('build', {}).get('version', '?')}")
if ok:
    for check in doc.get("checks", []):
        if check.get("id") == "window_enumeration":
            details = check.get("details") or {}
            print(f"windows={details.get('windowCount', '?')}")
    sys.exit(0)
failed = [c for c in doc.get("checks", []) if c.get("required") and not c.get("ok")]
for check in failed:
    print(f"FAIL {check.get('id')}: {check.get('code')} — {check.get('message')}", file=sys.stderr)
if any(c.get("code") == "screen_recording_denied" for c in failed):
    print("Remediation: System Settings → Privacy → Screen Recording → enable tmux AND your terminal app", file=sys.stderr)
    print("Then restart tmux or open a fresh session and re-run this script.", file=sys.stderr)
sys.exit(1)
PY