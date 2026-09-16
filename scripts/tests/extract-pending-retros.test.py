#!/usr/bin/env python3
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "extract-pending-retros.py"
SPEC = importlib.util.spec_from_file_location("extract_pending_retros", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ExtractPendingRetrosTest(unittest.TestCase):
    def test_real_items_uses_named_triage_column(self):
        excerpt = """\
| # | ID | Author | File | Triage | Action |
|---|----|--------|------|--------|--------|
| 1 | 123 | reviewer | src/a.ts | REAL | Fix the race |
"""

        self.assertEqual(
            MODULE.real_review_items(excerpt),
            [
                {
                    "author": "reviewer",
                    "file": "src/a.ts",
                    "triage": "REAL",
                    "action": "Fix the race",
                }
            ],
        )

    def test_digest_keeps_structured_real_count_when_excerpt_has_no_table(self):
        run = {
            "id": "run-1",
            "project": "test-farm",
            "flowType": "pr-complete",
            "summary": "Review follow-up",
            "branch": "fix/example",
        }
        decision = {
            "id": "retro-1",
            "createdAt": "2026-09-02T00:00:00Z",
            "payload": {
                "outcome": "success",
                "commentsTriageSummary": {"real": 2},
                "reportExcerpt": "### Finding 1 - REAL - fixed",
            },
        }

        with tempfile.TemporaryDirectory() as tmp:
            original_out = MODULE.OUT_DIR
            MODULE.OUT_DIR = Path(tmp)
            try:
                output = MODULE.write_digest("test-farm", [(run, decision)], "2026-09-02")
                digest = output.read_text()
            finally:
                MODULE.OUT_DIR = original_out

        self.assertIn("review items flagged REAL (2)", digest)
        self.assertNotIn("none REAL", digest)

    def test_full_artifact_and_exact_decision_snapshot_survive_zero_triage_count(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            task = root / "task"
            (task / "artifacts").mkdir(parents=True)
            (task / "artifacts/learnings.md").write_text("The rendered outcome was not asserted.\n")
            run = {"id": "run-1", "flowType": "review-pr", "taskFile": str(task / "TASK.md")}
            decision = {"id": "retro-1", "payload": {"workerLearnings": "Truncated old text"}}
            original = MODULE.OUT_DIR
            MODULE.OUT_DIR = root / "digest"
            try:
                output = MODULE.write_digest("test", [(run, decision)], "2026-09-15")
                text = output.read_text()
                snapshot = json.loads(output.with_suffix(".json").read_text())
            finally:
                MODULE.OUT_DIR = original
            self.assertIn("The rendered outcome was not asserted.", text)
            self.assertNotIn("all out-of-scope/clean", text)
            self.assertEqual(snapshot["decisions"][0]["decisionId"], "retro-1")
            self.assertEqual(len(snapshot["decisions"][0]["decisionHash"]), 64)


if __name__ == "__main__":
    unittest.main()
