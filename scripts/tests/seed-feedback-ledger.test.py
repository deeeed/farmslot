#!/usr/bin/env python3
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "seed-feedback-ledger.py"
SPEC = importlib.util.spec_from_file_location("seed_feedback_ledger", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

URL = "https://github.com/Org/Repo/pull/7#discussion_r55"
COVERAGE = {"rules": [{"lesson": "Rule A", "source": URL, "destination": "review/antipatterns.md", "candidates": [{"id": "c1", "runIds": ["run-1"]}]}]}


def run(argv):
    original = sys.argv
    sys.argv = ["seed-feedback-ledger.py", *argv]
    try:
        return MODULE.main()
    finally:
        sys.argv = original


class SeedFeedbackLedgerTest(unittest.TestCase):
    def test_refuses_to_seed_without_revision_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "coverage.json").write_text(json.dumps(COVERAGE))
            ledger = root / "ledger.json"
            code = run(["--coverage", str(root / "coverage.json"), "--repo", "git@x:o/lib.git", "--commit", "abc", "--ledger", str(ledger)])
            self.assertEqual(code, 1)
            self.assertFalse(ledger.exists())

    def test_seeds_provider_revision_from_saved_evidence_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "coverage.json").write_text(json.dumps(COVERAGE))
            github = root / "github"
            github.mkdir()
            (github / "Org--Repo--7.json").write_text(json.dumps({"pr": {"reviewThreads": {"nodes": [{"comments": {"nodes": [{"databaseId": 55, "updatedAt": "2026-09-01T00:00:00Z", "body": "late  defaults"}]}}]}}}))
            ledger = root / "ledger.json"
            args = ["--coverage", str(root / "coverage.json"), "--repo", "git@x:o/lib.git", "--commit", "abc", "--ledger", str(ledger), "--github-dir", str(github)]
            self.assertEqual(run(args), 0)
            entries = json.loads(ledger.read_text())["entries"]
            self.assertEqual(len(entries), 1)
            self.assertEqual(entries[0]["sourceKey"], "github.com/org/repo#7:review-comment:55")
            self.assertEqual(entries[0]["revision"], MODULE.sha256("2026-09-01T00:00:00Z:late  defaults"))
            self.assertEqual(entries[0]["bodyRevision"], MODULE.sha256("late defaults"))
            self.assertEqual(run(args), 0)
            self.assertEqual(len(json.loads(ledger.read_text())["entries"]), 1)


if __name__ == "__main__":
    unittest.main()
