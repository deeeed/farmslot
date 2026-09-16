#!/usr/bin/env python3
"""Seed the gateway feedback ledger from an approved rule-coverage receipt.

The ledger (`$FARMSLOT_HOME/state/feedback-ledger.json`, or `FARMSLOT_FEEDBACK_LEDGER`) records
which canonical rule consumed which PR feedback candidate. The gateway reads it when it builds
retrospectives, so already-landed human feedback shows as consumed instead of being re-proposed.

Input coverage format (one object per approved rule):
  {"rules": [{"lesson": "...", "source": "<comment url>", "destination": "<path in library>",
              "candidates": [{"id": "...", "reviewedCommit": "...", "runIds": [...]}]}]}

Provider revisions are recomputed from saved GitHub evidence (`--github-dir`, files named
`<owner>--<repo>--<number>.json` holding the GraphQL pull request) with the same fingerprint the
gateway's PR monitor uses (`sha256("<updatedAt>:<body>")`) so a later monitor read matches. A rule
without that evidence is refused (exit 1, nothing written) unless `--allow-unknown-revision` is
given, because an unknown revision can never match and would flag the candidate as revised.

Run this while no approval is being recorded through the gateway (it is an offline operator
step): the gateway serializes its own appends but cannot see this process.

Usage:
  python3 scripts/seed-feedback-ledger.py --coverage <coverage.json> --repo <library repo url> \
      --commit <merged library sha> [--github-dir <dir>] [--ledger <path>] [--dry-run]
"""
import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path


def sha256(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def ledger_path() -> Path:
    override = os.environ.get("FARMSLOT_FEEDBACK_LEDGER", "").strip()
    if override:
        return Path(override).expanduser()
    home = os.environ.get("FARMSLOT_HOME", "").strip() or "~/.farmslot"
    return Path(home).expanduser() / "state" / "feedback-ledger.json"


def parse_source(url: str):
    match = re.match(r"https://github\.com/([^/]+/[^/]+)/pull/(\d+)#discussion_r(\d+)$", url)
    if match:
        return match.group(1), int(match.group(2)), "review-comment", match.group(3)
    match = re.match(r"https://github\.com/([^/]+/[^/]+)/pull/(\d+)#pullrequestreview-(\d+)$", url)
    if match:
        return match.group(1), int(match.group(2)), "review", match.group(3)
    raise ValueError(f"unsupported feedback source url: {url}")


def load_ledger(path: Path) -> dict:
    if not path.exists():
        return {"version": 1, "entries": []}
    value = json.loads(path.read_text())
    if value.get("version") != 1 or not isinstance(value.get("entries"), list):
        raise ValueError(f"{path} is not a version-1 feedback ledger")
    return value


def write_atomic(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=path.name, dir=path.parent)
    try:
        with os.fdopen(fd, "w") as handle:
            json.dump(value, handle)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def provider_revision(github_dir: Path | None, repo: str, number: int, kind: str, provider_id: str):
    """(provider fingerprint, body hash) from saved GraphQL evidence, or (None, None) when absent."""
    if github_dir is None:
        return None, None
    evidence = github_dir / f"{repo.replace('/', '--')}--{number}.json"
    if not evidence.exists():
        return None, None
    pr = json.loads(evidence.read_text())["pr"]
    if kind == "review-comment":
        for thread in pr.get("reviewThreads", {}).get("nodes", []):
            for comment in thread.get("comments", {}).get("nodes", []):
                if str(comment.get("databaseId")) == provider_id:
                    body = comment.get("body") or ""
                    return sha256(f"{comment.get('updatedAt')}:{body}"), sha256(" ".join(body.split()))
    else:
        for review in pr.get("reviews", {}).get("nodes", []):
            if str(review.get("databaseId")) == provider_id:
                return review.get("updatedAt") or review.get("submittedAt"), None
    return None, None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--coverage", type=Path, required=True)
    ap.add_argument("--repo", required=True, help="Canonical library repository url the rules landed in")
    ap.add_argument("--commit", required=True, help="Merged library commit that contains the rules")
    ap.add_argument("--github-dir", type=Path, help="Saved GitHub GraphQL evidence directory")
    ap.add_argument("--ledger", type=Path, default=None)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument(
        "--allow-unknown-revision",
        action="store_true",
        help="Seed rules whose provider revision cannot be recomputed (their candidates will show as revised until re-observed)",
    )
    args = ap.parse_args()

    coverage = json.loads(args.coverage.read_text())
    target = args.ledger or ledger_path()
    ledger = load_ledger(target)
    existing = {(e["sourceKey"], e["destination"], e["rule"], e.get("revision")) for e in ledger["entries"]}
    recorded_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    added = []
    for rule in coverage.get("rules", []):
        repo, number, kind, provider_id = parse_source(rule["source"])
        source_key = f"github.com/{repo.lower()}#{number}:{kind}:{provider_id}"
        destination = f"{args.repo}:{rule['destination']}"
        revision, body_revision = provider_revision(args.github_dir, repo, number, kind, provider_id)
        if not revision and not args.allow_unknown_revision:
            print(
                f"ERROR: no provider revision evidence for {source_key} ({rule['lesson']}); "
                "pass --github-dir with the saved comment or --allow-unknown-revision",
                file=sys.stderr,
            )
            return 1
        key = (source_key, destination, rule["lesson"], revision or "unknown-at-seed")
        if key in existing:
            continue
        run_ids = sorted({run_id for candidate in rule.get("candidates", []) for run_id in candidate.get("runIds", [])})
        entry = {
            "sourceKey": source_key,
            "candidateId": sha256(source_key),
            "revision": revision or "unknown-at-seed",
            **({"bodyRevision": body_revision} if body_revision else {}),
            "destination": destination,
            "rule": rule["lesson"],
            "recordedAt": recorded_at,
            "commit": args.commit,
            "source": "approved-audit",
            "runIds": run_ids,
            "auditCandidateIds": [candidate.get("id") for candidate in rule.get("candidates", []) if candidate.get("id")],
        }
        existing.add(key)
        ledger["entries"].append(entry)
        added.append(entry)
        print(f"  {'DRY ' if args.dry_run else 'ADD '} {source_key} -> {rule['lesson']} (rev {entry['revision'][:8]})")

    print(f"\n{'previewed' if args.dry_run else 'seeded'}: added={len(added)} total={len(ledger['entries'])} ledger={target}")
    if not args.dry_run and added:
        write_atomic(target, ledger)
    return 0


if __name__ == "__main__":
    sys.exit(main())
