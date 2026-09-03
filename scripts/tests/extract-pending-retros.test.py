#!/usr/bin/env python3
import importlib.util
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


if __name__ == "__main__":
    unittest.main()
