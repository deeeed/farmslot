#!/usr/bin/env python3
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "bulk-resolve-retros.py"
SPEC = importlib.util.spec_from_file_location("bulk_resolve_retros", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def write_run(runs_dir: Path, run_id: str, decision: dict, status: str = "done") -> dict:
    run = {"id": run_id, "status": status, "flowType": "pr-complete", "project": "p", "decisions": [decision]}
    (runs_dir / f"{run_id}.json").write_text(json.dumps(run))
    return run


class BulkResolveRetrosTest(unittest.TestCase):
    def run_main(self, argv, runs_dir: Path, digest_dir: Path):
        calls = []

        def fake_resolve(run_id, decision_id, dry_run):
            calls.append((run_id, decision_id, dry_run))
            return True, "ok"

        original = (MODULE.RUNS_DIR, MODULE.DIGEST_DIR, MODULE.resolve_one, sys.argv)
        MODULE.RUNS_DIR, MODULE.DIGEST_DIR, MODULE.resolve_one = runs_dir, digest_dir, fake_resolve
        sys.argv = ["bulk-resolve-retros.py", *argv]
        try:
            code = MODULE.main()
        finally:
            MODULE.RUNS_DIR, MODULE.DIGEST_DIR, MODULE.resolve_one, sys.argv = original
        return code, calls

    def test_plan_mode_resolves_only_matching_decisions_with_a_recorded_destination(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            runs = root / "runs"
            runs.mkdir()
            matching = {"id": "dec-match", "type": "retrospective", "resolvedAt": None, "payload": {"outcome": "success"}}
            drifted = {"id": "dec-drift", "type": "retrospective", "resolvedAt": None, "payload": {"outcome": "success"}}
            undecided = {"id": "dec-nodest", "type": "retrospective", "resolvedAt": None, "payload": {}}
            active = {"id": "dec-active", "type": "retrospective", "resolvedAt": None, "payload": {}}
            resolved = {"id": "dec-done", "type": "retrospective", "resolvedAt": "2026-09-16T00:00:00Z", "payload": {}}
            write_run(runs, "run-match", matching)
            write_run(runs, "run-drift", drifted)
            write_run(runs, "run-nodest", undecided)
            write_run(runs, "run-active", active, status="monitoring")
            write_run(runs, "run-done", resolved)
            plan = {
                "version": 1,
                "decisions": [
                    {"runId": "run-match", "decisionId": "dec-match", "decisionHash": MODULE.decision_hash(matching), "destination": "lib:review/antipatterns.md"},
                    # Audited hash captured before the decision changed on disk.
                    {"runId": "run-drift", "decisionId": "dec-drift", "decisionHash": "0" * 64, "destination": "lib:review/antipatterns.md"},
                    {"runId": "run-nodest", "decisionId": "dec-nodest", "decisionHash": MODULE.decision_hash(undecided)},
                    {"runId": "run-active", "decisionId": "dec-active", "decisionHash": MODULE.decision_hash(active), "destination": "lib:x"},
                    {"runId": "run-done", "decisionId": "dec-done", "decisionHash": MODULE.decision_hash(resolved), "destination": "lib:x"},
                    {"runId": "run-missing", "decisionId": "dec-missing", "decisionHash": "1" * 64, "destination": "lib:x"},
                ],
            }
            plan_path = root / "plan.json"
            plan_path.write_text(json.dumps(plan))
            receipt = root / "receipt.jsonl"

            code, calls = self.run_main(
                ["--from-plan", str(plan_path), "--dry-run", "--receipt", str(receipt), "--reason", "test"],
                runs,
                root / "digest",
            )
            self.assertEqual(code, 0)
            self.assertEqual(calls, [("run-match", "dec-match", True)])
            rows = [json.loads(line) for line in receipt.read_text().splitlines()]
            outcomes = {(row["runId"], row["decisionId"]): (row["status"], row["reason"]) for row in rows}
            self.assertEqual(outcomes[("run-match", "dec-match")], ("DRY", "test"))
            self.assertEqual(outcomes[("run-drift", "dec-drift")], ("SKIP", "changed-since-audit"))
            self.assertEqual(outcomes[("run-nodest", "dec-nodest")], ("SKIP", "no-recorded-destination"))
            self.assertEqual(outcomes[("run-active", "dec-active")], ("SKIP", "run-active:monitoring"))
            self.assertEqual(outcomes[("run-done", "dec-done")], ("SKIP", "already-resolved-or-missing"))
            self.assertEqual(outcomes[("run-missing", "dec-missing")], ("SKIP", "run-missing"))
            self.assertEqual(rows[0]["destination"], "lib:review/antipatterns.md")
            self.assertTrue(all(row["dryRun"] for row in rows))

    def test_plan_rejects_malformed_rows(self):
        with self.assertRaises(ValueError):
            MODULE._snapshot_rows({"version": 1, "decisions": [{"runId": "a", "decisionId": "b", "decisionHash": "zz"}]}, require_destination=True)
        with self.assertRaises(ValueError):
            MODULE._snapshot_rows({"version": 1, "decisions": [{"runId": "a", "decisionId": "b", "decisionHash": "0" * 64, "destination": " "}]}, require_destination=True)

    def test_digest_mode_skips_changed_decisions_without_a_destination_requirement(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            runs = root / "runs"
            runs.mkdir()
            decision = {"id": "dec-1", "type": "retrospective", "resolvedAt": None, "payload": {}}
            write_run(runs, "run-1", decision)
            digest = root / "2026-09-16-p.md"
            digest.write_text("# digest")
            digest.with_suffix(".json").write_text(json.dumps({
                "version": 1,
                "decisions": [{"runId": "run-1", "decisionId": "dec-1", "decisionHash": MODULE.decision_hash(decision)}],
            }))
            code, calls = self.run_main(["--from-digest", str(digest), "--dry-run"], runs, root / "digest")
            self.assertEqual(code, 0)
            self.assertEqual(calls, [("run-1", "dec-1", True)])

            (runs / "run-1.json").write_text(json.dumps({**json.loads((runs / "run-1.json").read_text()), "decisions": [{**decision, "payload": {"outcome": "changed"}}]}))
            code, calls = self.run_main(["--from-digest", str(digest), "--dry-run"], runs, root / "digest")
            self.assertEqual(code, 0)
            self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
