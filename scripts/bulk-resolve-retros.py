#!/usr/bin/env python3
"""Bulk-resolve pending retros after their learnings have been consolidated.

Calls the gateway over WS via `apps/command-center/scripts/cdp.mjs gateway run.resolveDecision`,
using actionId='dismiss' (closest existing action; improvement-engine only fires on 'accept').

Inputs (any one):
  --run-ids id1 id2 ...        Explicit list of run IDs.
  --from-digest <path>         Resolve the decisions captured in a Pass-1 digest's `.json`
                               snapshot; a decision whose hash changed since extraction is skipped.
  --from-plan <path>           Resolve only audited decisions with a recorded `destination`
                               (`{"version":1,"decisions":[{runId,decisionId,decisionHash,destination}]}`).
                               Changed, missing, already-resolved or still-active decisions are skipped.
  --all-pending                Process every pending retro on disk. Never against a live farm
                               without a curated destination for each decision.

Always appends an audit log (`.omc/retro-digest/<YYYY-MM-DD>-resolved.log`); `--receipt <path>`
also appends one JSON line per decision with its outcome and reason.

Refuses to run if the gateway is not reachable.
"""
import argparse
import json
import hashlib
import os
import re
import subprocess
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from glob import glob
from pathlib import Path

REPO = Path(os.environ.get("FARMSLOT_ROOT", Path(__file__).resolve().parent.parent)).expanduser().resolve()
RUNS_DIR = Path(os.environ.get("FARMSLOT_RUNS_DIR", REPO / ".runs")).expanduser().resolve()
DIGEST_DIR = Path(os.environ.get("FARMSLOT_RETRO_DIGEST_DIR", REPO / ".omc" / "retro-digest")).expanduser().resolve()
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
        run = json.loads(Path(f).read_text())
    except Exception:
        return None, []
    pending = [dec for dec in (run.get("decisions") or []) if dec.get("type") == "retrospective" and not dec.get("resolvedAt")]
    return run, pending


# Run statuses the gateway treats as terminal; a retro on any other status belongs to live work.
TERMINAL_RUN_STATUSES = {"done", "failed", "cancelled"}


def decision_hash(decision) -> str:
    return hashlib.sha256(json.dumps(decision, sort_keys=True).encode()).hexdigest()


def _snapshot_rows(value, *, require_destination: bool):
    """Validate `{version:1, decisions:[{runId, decisionId, decisionHash[, destination]}]}` rows.

    Returns {runId: {decisionId: {"hash": ..., "destination": ...}}}. With
    `require_destination`, rows without a recorded destination are kept but marked so the
    resolver skips them explicitly instead of dropping them silently."""
    if value.get("version") != 1 or not isinstance(value.get("decisions"), list):
        raise ValueError("Invalid retrospective decision snapshot")
    selected = {}
    for row in value["decisions"]:
        if not all(isinstance(row.get(k), str) and re.fullmatch(r"[A-Za-z0-9_-]+", row[k]) for k in ["runId", "decisionId"]):
            raise ValueError("Invalid retrospective snapshot identity")
        if not isinstance(row.get("decisionHash"), str) or not re.fullmatch(r"[a-f0-9]{64}", row["decisionHash"]):
            raise ValueError("Invalid retrospective snapshot digest")
        destination = row.get("destination")
        if require_destination and destination is not None and (not isinstance(destination, str) or not destination.strip()):
            raise ValueError("Invalid retrospective plan destination")
        decisions = selected.setdefault(row["runId"], {})
        previous = decisions.get(row["decisionId"])
        if previous and previous["hash"] != row["decisionHash"]:
            raise ValueError("Conflicting retrospective snapshot revisions")
        decisions[row["decisionId"]] = {
            "hash": row["decisionHash"],
            "destination": destination.strip() if isinstance(destination, str) and destination.strip() else None,
        }
    return selected


def decisions_from_digest(path: Path):
    snapshot = path.with_suffix(".json")
    if not snapshot.exists():
        raise ValueError("Digest has no decision snapshot; regenerate it before resolving retros")
    return _snapshot_rows(json.loads(snapshot.read_text()), require_destination=False)


def decisions_from_plan(path: Path):
    return _snapshot_rows(json.loads(path.read_text()), require_destination=True)


def all_pending_run_ids():
    out = []
    for f in sorted(glob(str(RUNS_DIR / "*.json"))):
        try:
            run = json.loads(Path(f).read_text())
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
    g.add_argument("--from-plan", type=Path)
    g.add_argument("--all-pending", action="store_true")
    ap.add_argument("--dry-run", action="store_true", help="Print actions without calling the gateway")
    ap.add_argument("--reason", default="Batch-extracted into LEARNINGS.md", help="Recorded in audit log only")
    ap.add_argument("--receipt", type=Path, help="Append one JSON line per decision outcome to this file")
    args = ap.parse_args()

    if not args.dry_run and not gateway_alive():
        print("ERROR: gateway not reachable at", GATEWAY_HEALTH, file=sys.stderr)
        print(
            "Start it with: cd apps/command-center && yarn farmdev > /tmp/farmslot-dev.log 2>&1 &",
            file=sys.stderr,
        )
        return 2

    selection = None
    plan_mode = False
    if args.run_ids:
        ids = list(dict.fromkeys(args.run_ids))
    elif args.from_digest:
        selection = decisions_from_digest(args.from_digest)
        ids = list(selection)
    elif args.from_plan:
        selection = decisions_from_plan(args.from_plan)
        plan_mode = True
        ids = list(selection)
    else:
        print("WARNING: --all-pending resolves every pending retro without a curated destination", file=sys.stderr)
        ids = all_pending_run_ids()

    if not ids:
        print("nothing to resolve")
        return 0

    DIGEST_DIR.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc)
    today = now.strftime("%Y-%m-%d")
    log_path = DIGEST_DIR / f"{today}-resolved.log"

    ts_run = now.isoformat().replace("+00:00", "Z")
    receipt_rows = []

    def record(status, run_id, decision_id, reason, run=None, extra=None):
        row = {
            "at": ts_run,
            "status": status,
            "runId": run_id,
            "decisionId": decision_id,
            "reason": reason,
            "dryRun": bool(args.dry_run),
            "flow": (run or {}).get("flowType"),
            "project": (run or {}).get("project"),
            **(extra or {}),
        }
        receipt_rows.append(row)
        return row

    with open(log_path, "a") as log:
        log.write(f"\n# bulk-resolve pass {ts_run} — reason: {args.reason}\n")
        ok = 0
        skipped = 0
        failed = 0
        for run_id in ids:
            run, decisions = find_pending_retros(run_id)
            wanted = selection[run_id] if selection is not None else None
            if wanted is not None:
                # Every audited decision gets an explicit outcome, including ones no longer pending.
                pending_ids = {decision["id"] for decision in decisions}
                for decision_id in wanted:
                    if decision_id in pending_ids:
                        continue
                    reason = "run-missing" if run is None else "already-resolved-or-missing"
                    print(f"  SKIP {run_id[:8]}/{decision_id[:8]} — {reason}")
                    log.write(f"SKIP {run_id} {decision_id} {reason}\n")
                    record("SKIP", run_id, decision_id, reason, run)
                    skipped += 1
                decisions = [decision for decision in decisions if decision["id"] in wanted]
                if not decisions:
                    continue
            if not decisions:
                print(f"  SKIP {run_id[:8]} — no pending retro")
                log.write(f"SKIP {run_id} no-pending-retro\n")
                record("SKIP", run_id, None, "no-pending-retro", run)
                skipped += 1
                continue
            for dec in decisions:
                short = f"{run_id[:8]}/{dec['id'][:8]} flow={run.get('flowType','?')} project={run.get('project','?')}"
                current_hash = decision_hash(dec)
                skip_reason = None
                destination = None
                if wanted is not None:
                    expected = wanted[dec["id"]]
                    destination = expected["destination"]
                    if current_hash != expected["hash"]:
                        skip_reason = "changed-since-extraction" if not plan_mode else "changed-since-audit"
                    elif plan_mode and not destination:
                        skip_reason = "no-recorded-destination"
                if skip_reason is None and run.get("status") not in TERMINAL_RUN_STATUSES:
                    skip_reason = f"run-active:{run.get('status')}"
                if skip_reason:
                    print(f"  SKIP {short} — {skip_reason}")
                    log.write(f"SKIP {run_id} {dec['id']} {skip_reason}\n")
                    record("SKIP", run_id, dec["id"], skip_reason, run, {"decisionHash": current_hash})
                    skipped += 1
                    continue
                ok_call, detail = resolve_one(run_id, dec["id"], args.dry_run)
                extra = {"decisionHash": current_hash, **({"destination": destination} if destination else {})}
                if ok_call:
                    print(f"  OK   {short}")
                    log.write(f"OK   {run_id} {dec['id']} flow={run.get('flowType')} project={run.get('project')} {detail}\n")
                    record("DRY" if args.dry_run else "OK", run_id, dec["id"], args.reason, run, extra)
                    ok += 1
                else:
                    print(f"  FAIL {short} — {detail}")
                    log.write(f"FAIL {run_id} {dec['id']} {detail}\n")
                    record("FAIL", run_id, dec["id"], detail, run, extra)
                    failed += 1

    if args.receipt:
        args.receipt.parent.mkdir(parents=True, exist_ok=True)
        with open(args.receipt, "a") as receipt:
            for row in receipt_rows:
                receipt.write(json.dumps(row, sort_keys=True) + "\n")

    label = "previewed" if args.dry_run else "resolved"
    print(f"\n{label}: ok={ok} skipped={skipped} failed={failed}")
    print(f"audit log: {os.path.relpath(log_path, REPO)}")
    if args.receipt:
        print(f"receipt: {args.receipt}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
