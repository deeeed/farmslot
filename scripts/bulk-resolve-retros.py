#!/usr/bin/env python3
"""Bulk-resolve pending retros after their learnings have been consolidated.

Calls the gateway over WS via `apps/command-center/scripts/cdp.mjs gateway run.resolveDecision`,
using actionId='dismiss' (closest existing action; improvement-engine only fires on 'accept').

Inputs (any one):
  --run-ids id1 id2 ...        Explicit list of run IDs.
  --from-digest <path>         Read run IDs out of a Pass-1 digest's fenced block.
  --all-pending                Process every pending retro on disk (use with care).

Always writes an audit log:
  .omc/retro-digest/<YYYY-MM-DD>-resolved.log

Refuses to run if the gateway is not reachable.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import urllib.parse
import urllib.request
from datetime import datetime
from glob import glob
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
RUNS_DIR = REPO / ".runs"
DIGEST_DIR = REPO / ".omc" / "retro-digest"
CDP_BIN = REPO / "apps" / "command-center" / "scripts" / "cdp.mjs"


def _gateway_endpoints() -> tuple[str, str]:
    """Normalize FARMSLOT_GATEWAY ONCE into (ws url, health url) so the
    reachability gate and the cdp.mjs RPC target the same instance — a value
    normalized only for the probe would let health pass while every RPC
    fails on the raw form. Userinfo is dropped (cdp.mjs authenticates via
    FARMSLOT_GATEWAY_TOKEN/PASSWORD, and credentials must not leak into
    error output); wss maps to https for the probe; IPv6 hosts re-bracket."""
    raw = os.environ.get("FARMSLOT_GATEWAY", "").strip() or "ws://localhost:7777"
    parts = urllib.parse.urlsplit(raw)
    if not parts.netloc:
        # Bare host:port without a scheme — reparse so netloc populates.
        parts = urllib.parse.urlsplit(f"ws://{raw}")
    ws_scheme = "wss" if parts.scheme.lower() == "wss" else "ws"
    host = parts.hostname or "localhost"
    if ":" in host:
        host = f"[{host}]"
    port = f":{parts.port}" if parts.port else ""
    authority = f"{host}{port}"
    http_scheme = "https" if ws_scheme == "wss" else "http"
    # The WS path survives (path-routing proxies serve RPC at e.g. /ws);
    # only query/fragment/userinfo are dropped. Health stays authority-rooted.
    path = parts.path if parts.path not in ("", "/") else ""
    return f"{ws_scheme}://{authority}{path}", f"{http_scheme}://{authority}/health"


GATEWAY_WS, GATEWAY_HEALTH = _gateway_endpoints()


def gateway_alive() -> bool:
    try:
        with urllib.request.urlopen(GATEWAY_HEALTH, timeout=2) as r:
            return r.status == 200
    except Exception:
        return False


def find_pending_retros(run_id: str):
    """Return every unresolved retro on the run — supersession can leave duplicates."""
    f = RUNS_DIR / f"{run_id}.json"
    if not f.exists():
        return None, []
    try:
        run = json.load(open(f))
    except Exception:
        return None, []
    pending = [dec for dec in (run.get("decisions") or []) if dec.get("type") == "retrospective" and not dec.get("resolvedAt")]
    return run, pending


def run_ids_from_digest(path: Path):
    text = path.read_text()
    # First fenced block holds the run IDs (per extract-pending-retros.py output).
    m = re.search(r"```\n([A-Za-z0-9-]+(?:\n[A-Za-z0-9-]+)*)\n```", text)
    if not m:
        return []
    return [line.strip() for line in m.group(1).splitlines() if line.strip()]


def all_pending_run_ids():
    out = []
    for f in sorted(glob(str(RUNS_DIR / "*.json"))):
        try:
            run = json.load(open(f))
        except Exception:
            continue
        for dec in run.get("decisions") or []:
            if dec.get("type") == "retrospective" and not dec.get("resolvedAt"):
                out.append(run["id"])
                break
    return out


def resolve_one(run_id: str, decision_id: str, dry_run: bool) -> tuple[bool, str]:
    payload = json.dumps({"runId": run_id, "decisionId": decision_id, "actionId": "dismiss"})
    cmd = ["node", str(CDP_BIN), "gateway", "run.resolveDecision", payload]
    if dry_run:
        return True, f"DRY: {' '.join(cmd)}"
    try:
        # The SAME normalized target the health gate probed — never the raw env.
        env = {**os.environ, "FARMSLOT_GATEWAY": GATEWAY_WS}
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=10, env=env)
    except subprocess.TimeoutExpired:
        return False, "timeout"
    if r.returncode != 0:
        return False, f"rc={r.returncode} stderr={r.stderr.strip()[:300]}"
    return True, r.stdout.strip()[:200] or "ok"


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--run-ids", nargs="+")
    g.add_argument("--from-digest", type=Path)
    g.add_argument("--all-pending", action="store_true")
    ap.add_argument("--dry-run", action="store_true", help="Print actions without calling the gateway")
    ap.add_argument("--reason", default="Batch-extracted into LEARNINGS.md", help="Recorded in audit log only")
    args = ap.parse_args()

    if not args.dry_run and not gateway_alive():
        print("ERROR: gateway not reachable at", GATEWAY_HEALTH, file=sys.stderr)
        print("Start it with: cd apps/command-center && yarn dev > /tmp/farmslot-dev.log 2>&1 &", file=sys.stderr)
        return 2

    if args.run_ids:
        ids = list(dict.fromkeys(args.run_ids))
    elif args.from_digest:
        ids = run_ids_from_digest(args.from_digest)
    else:
        ids = all_pending_run_ids()

    if not ids:
        print("nothing to resolve")
        return 0

    DIGEST_DIR.mkdir(parents=True, exist_ok=True)
    today = datetime.utcnow().strftime("%Y-%m-%d")
    log_path = DIGEST_DIR / f"{today}-resolved.log"

    with open(log_path, "a") as log:
        ts_run = datetime.utcnow().isoformat() + "Z"
        log.write(f"\n# bulk-resolve pass {ts_run} — reason: {args.reason}\n")
        ok = 0
        skipped = 0
        failed = 0
        for run_id in ids:
            run, decisions = find_pending_retros(run_id)
            if not decisions:
                print(f"  SKIP {run_id[:8]} — no pending retro")
                log.write(f"SKIP {run_id} no-pending-retro\n")
                skipped += 1
                continue
            for dec in decisions:
                ok_call, detail = resolve_one(run_id, dec["id"], args.dry_run)
                short = f"{run_id[:8]}/{dec['id'][:8]} flow={run.get('flowType','?')} project={run.get('project','?')}"
                if ok_call:
                    print(f"  OK   {short}")
                    log.write(f"OK   {run_id} {dec['id']} flow={run.get('flowType')} project={run.get('project')} {detail}\n")
                    ok += 1
                else:
                    print(f"  FAIL {short} — {detail}")
                    log.write(f"FAIL {run_id} {dec['id']} {detail}\n")
                    failed += 1

    print(f"\nresolved: ok={ok} skipped={skipped} failed={failed}")
    print(f"audit log: {log_path.relative_to(REPO)}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
