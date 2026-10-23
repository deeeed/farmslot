"""Failure-focused review protocol checks, with no model or tmux processes."""

import argparse
import concurrent.futures
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import common
import review


def reviewer_command(argv):
    return argv[0] in review.REVIEWERS


class ReviewTests(unittest.TestCase):
    def test_existing_legacy_pr_cannot_restart_new_rounds(self):
        legacy = self.root / 'legacy' / 'project-12'
        legacy.mkdir(parents=True)
        self.config['reviews'] = {'legacy_root': str(legacy.parent)}
        with self.assertRaisesRegex(RuntimeError, 'legacy verdict'):
            review.review(self.config, self.args)
        self.assertFalse(review.review_state_path(self.config, self.args.repo, self.args.pr).exists())

    def setUp(self):
        self.started = time.monotonic()
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.config = {"state_dir": str(self.root / "state")}
        self.args = argparse.Namespace(repo="example/project", pr=12, cwd=str(self.root),
                                       report=str(self.root / "REPORT.md"), base="main", conflict_only=False)
        self.head = "a" * 40
        self.base = "0" * 40
        self.verdicts = {"codex": "REQUEST_CHANGES", "claude": "APPROVE"}
        self.prompts = []
        self.commands = []
        self.conflict_paths = ["example.py"]
        self.runner = patch.object(review, "run", side_effect=self.run_command)
        self.runner.start()
        self.addCleanup(self.runner.stop)

    def tearDown(self):
        print(f"{self.id().split('.')[-1]}: {time.monotonic() - self.started:.3f}s")

    def run_command(self, argv, **kwargs):
        self.commands.append(argv)
        if argv[:2] == ["git", "rev-parse"]:
            output = self.head
        elif argv[:2] == ["git", "merge-base"]:
            output = self.base
        elif argv[0] == "node" and argv[1].endswith("review-diff-scope.cjs"):
            output = "## Diff scope\nShared packet for entire contribution"
        elif argv[:3] == ["git", "diff", "--name-only"]:
            output = "\0".join(self.conflict_paths) + ("\0" if self.conflict_paths else "")
        else:
            self.assertTrue(reviewer_command(argv), f"Unexpected test subprocess: {argv}")
            reviewer = argv[0]
            self.prompts.append(kwargs["input"])
            verdict = self.verdicts[reviewer]
            if isinstance(verdict, Exception):
                raise verdict
            output = f"VERDICT: {verdict}\nCOMMIT: {self.head}\nBlockers: example.py:4 fails on a real request.\n"
        return subprocess.CompletedProcess(argv, 0, output, "")

    def state(self):
        return json.loads(review.review_state_path(self.config, self.args.repo, self.args.pr).read_text())

    def directory(self):
        return review.review_dir(self.config, self.args.repo, self.args.pr)

    def test_nested_or_stale_verdicts_never_approve(self):
        directory = self.directory()
        (directory / "r1").mkdir(parents=True)
        history = directory / "r1" / "codex.md"
        approved = f"VERDICT: APPROVE\nCOMMIT: {self.head}\n"
        history.write_text(approved)
        self.assertFalse(review.parse_verdict(history, self.head))
        (directory / "archive").mkdir()
        archived = directory / "archive" / "codex.md"
        archived.write_text(approved)
        self.assertFalse(review.parse_verdict(archived, self.head))
        path = directory / "codex.md"
        self.assertFalse(review.parse_verdict(path, self.head))
        for text in ("Summary\n" + approved,
                     approved.replace(self.head, self.base),
                     approved.replace("VERDICT: APPROVE", "VERDICT: APPROVE with nits"),
                     approved.replace("COMMIT:", "HEAD:")):
            with self.subTest(text=text):
                path.write_text(text)
                self.assertFalse(review.parse_verdict(path, self.head))
        path.write_text(approved + "IMPROVEMENTS: a nit\n")
        self.assertTrue(review.parse_verdict(path, self.head))

    def test_round_five_stops_and_restart_cannot_review_six(self):
        for number in range(1, 6):
            self.head = f"{number:040x}"
            state = review.review(self.config, self.args)
            self.assertEqual(number, state["round"])
            if number == 4:
                self.assertTrue(Path(self.args.report).read_text().startswith("ESCALATE example/project#12 r4:"))
        self.assertEqual("stopped", state["status"])
        self.assertTrue(Path(self.args.report).read_text().startswith("STOPPED example/project#12 r5:"))
        model_calls = len([command for command in self.commands if reviewer_command(command)])
        with self.assertRaisesRegex(RuntimeError, "maximum 5"):
            review.review(self.config, self.args)
        self.assertEqual(model_calls, len([command for command in self.commands if reviewer_command(command)]))
        self.assertFalse((self.directory() / "r6").exists())

    def test_approvals_freeze_without_ci_and_new_head_is_rejected(self):
        self.verdicts = {name: "APPROVE" for name in review.REVIEWERS}
        state = review.review(self.config, self.args)
        self.assertEqual("frozen", state["status"])
        self.assertEqual(self.head, state["frozen_sha"])
        self.assertNotIn("MERGE-READY", Path(self.args.report).read_text())
        state = review.review(self.config, self.args)
        self.assertEqual(1, state["round"])
        self.head = "b" * 40
        with self.assertRaisesRegex(RuntimeError, "frozen"):
            review.review(self.config, self.args)
        self.assertEqual(1, self.state()["round"])

    def test_delta_history_is_immutable_and_prompt_carries_settled_rules(self):
        review.review(self.config, self.args)
        prior_sha = self.head
        history = {path: path.read_bytes() for path in (self.directory() / "r1").iterdir()}
        self.head = "b" * 40
        state = review.review(self.config, self.args)
        self.assertEqual(prior_sha, state["rounds"][-1]["base"])
        self.assertEqual("delta", state["rounds"][-1]["mode"])
        for path, content in history.items():
            self.assertEqual(content, path.read_bytes())
        prompt = self.prompts[-1]
        self.assertIn(f"Saved range: {prior_sha}..{self.head}", prompt)
        self.assertIn("Review ONLY this saved delta", prompt)
        self.assertIn("Do not reopen settled issues", prompt)
        self.assertIn("user-data loss", prompt)
        self.assertIn("Apply the shared approval policy", prompt)
        self.assertIn("Round 1, claude", prompt)
        self.assertIn("## Diff scope", prompt)
        scope_commands = [command for command in self.commands if command[0] == "node"]
        self.assertTrue(all(command[4] == "main" for command in scope_commands))

    def test_comment_is_a_valid_nonapproval_and_project_policy_reaches_the_renderer(self):
        self.config["projects"] = {self.args.repo: {"approvalPolicy": {"maxNits": 0}}}
        self.verdicts["codex"] = "COMMENT"
        state = review.review(self.config, self.args)
        self.assertEqual("needs_changes", state["status"])
        self.assertEqual("COMMENT", state["reviewers"]["codex"]["verdict"])
        self.assertFalse(review.parse_verdict(self.directory() / "codex.md", self.head))
        packet = next(command for command in self.commands if command[0] == "node")
        self.assertEqual({"maxNits": 0}, json.loads(packet[-1]))

    def test_real_reviewer_failure_cannot_inherit_prior_approval(self):
        review.review(self.config, self.args)
        self.assertTrue(review.parse_verdict(self.directory() / "claude.md", self.head))
        self.verdicts["claude"] = RuntimeError("reviewer process exited")
        state = review.review(self.config, self.args)
        self.assertEqual("review_error", state["status"])
        self.assertFalse((self.directory() / "claude.md").exists())
        self.assertEqual("reviewer process exited", (self.directory() / "r2" / "claude.error.txt").read_text())
        self.assertEqual(2, self.state()["round"])

    def test_head_changed_during_review_never_freezes(self):
        self.verdicts = {name: "APPROVE" for name in review.REVIEWERS}
        original = self.run_command
        head_reads = 0

        def moving_head(argv, **kwargs):
            nonlocal head_reads
            if argv == ["git", "rev-parse", "HEAD"]:
                head_reads += 1
                if head_reads == 2:
                    return subprocess.CompletedProcess(argv, 0, "e" * 40, "")
            return original(argv, **kwargs)

        with patch.object(review, "run", side_effect=moving_head):
            state = review.review(self.config, self.args)
        self.assertEqual("review_error", state["status"])
        self.assertNotIn("frozen_sha", state)
        result = json.loads((self.directory() / "r1" / "result.json").read_text())
        self.assertIn("HEAD changed", result["error"])

    def test_claude_lead_context_does_not_block_independent_subprocess(self):
        original = self.run_command
        observed = {}

        def inspect_environment(argv, **kwargs):
            if reviewer_command(argv):
                observed[argv[0]] = kwargs["env"]
            return original(argv, **kwargs)

        with patch.dict("os.environ", {"CLAUDECODE": "1"}):
            with patch.object(review, "run", side_effect=inspect_environment):
                review.review(self.config, self.args)
        self.assertCountEqual(["codex", "claude"], observed)
        self.assertNotIn("CLAUDECODE", observed["claude"])

    def test_reserved_round_survives_crash_and_still_stops(self):
        for _ in range(4):
            review.review(self.config, self.args)
        state = self.state()
        state.update(round=5, status="running")
        review.write_json(review.review_state_path(self.config, self.args.repo, self.args.pr), state)
        with self.assertRaisesRegex(RuntimeError, "maximum 5"):
            review.review(self.config, self.args)
        self.assertEqual("stopped", self.state()["status"])
        self.assertTrue(Path(self.args.report).read_text().startswith("STOPPED example/project#12 r5:"))

    def test_conflict_only_saves_frozen_to_new_head_range(self):
        self.verdicts = {name: "APPROVE" for name in review.REVIEWERS}
        review.review(self.config, self.args)
        frozen = self.head
        self.head = "c" * 40
        self.args.conflict_only = True
        self.args.conflict_files = ["example.py"]
        state = review.review(self.config, self.args)
        self.assertEqual("conflict-only", state["rounds"][-1]["mode"])
        self.assertEqual(frozen, state["rounds"][-1]["base"])
        self.assertIn("Review ONLY merge-conflict resolutions", self.prompts[-1])
        self.assertEqual(self.head, state["frozen_sha"])

    def test_failed_conflict_round_still_requires_conflict_scope_and_next_delta(self):
        self.verdicts = {name: "APPROVE" for name in review.REVIEWERS}
        review.review(self.config, self.args)
        self.verdicts["codex"] = "REQUEST_CHANGES"
        self.head = "c" * 40
        self.args.conflict_only = True
        self.args.conflict_files = ["example.py"]
        review.review(self.config, self.args)
        previous = self.head
        self.head = "d" * 40
        self.args.conflict_only = False
        self.args.conflict_files = None
        with self.assertRaisesRegex(RuntimeError, "conflict-only"):
            review.review(self.config, self.args)
        self.args.conflict_only = True
        state = review.review(self.config, self.args)
        self.assertEqual(previous, state["rounds"][-1]["base"])
        self.assertEqual("conflict-only", state["rounds"][-1]["mode"])

    def test_conflict_only_rejects_undeclared_changes_before_spawning_reviewers(self):
        self.verdicts = {name: "APPROVE" for name in review.REVIEWERS}
        review.review(self.config, self.args)
        self.head = "c" * 40
        self.args.conflict_only = True
        with self.assertRaisesRegex(RuntimeError, "--conflict-files"):
            review.review(self.config, self.args)
        self.args.conflict_files = ["example.py"]
        self.conflict_paths = ["example.py", "extra.py"]
        model_calls = len([command for command in self.commands if reviewer_command(command)])
        with self.assertRaisesRegex(RuntimeError, "outside saved manifest"):
            review.review(self.config, self.args)
        self.assertEqual(model_calls, len([command for command in self.commands if reviewer_command(command)]))
        self.assertEqual(1, self.state()["round"])

    def test_saved_conflict_tree_excludes_changes_imported_from_main(self):
        self.verdicts = {"codex": "APPROVE", "claude": "APPROVE"}
        review.review(self.config, self.args)
        self.head = "b" * 40
        self.args.conflict_only = True
        self.args.conflict_files = ["example.py"]
        self.args.conflict_base = "c" * 40
        self.verdicts["codex"] = "REQUEST_CHANGES"
        state = review.review(self.config, self.args)
        self.assertEqual(state["rounds"][-1]["base"], "c" * 40)
        self.assertIn(["git", "diff", "--name-only", "-z", "c" * 40, self.head], self.commands)
        self.head = "d" * 40
        self.args.conflict_base = "e" * 40
        with self.assertRaisesRegex(RuntimeError, "baseline cannot change"):
            review.review(self.config, self.args)

    def test_conflict_manifest_cannot_widen_after_failed_resolution(self):
        self.verdicts = {name: "APPROVE" for name in review.REVIEWERS}
        review.review(self.config, self.args)
        self.verdicts["codex"] = "REQUEST_CHANGES"
        self.head = "c" * 40
        self.args.conflict_only = True
        self.args.conflict_files = ["example.py"]
        review.review(self.config, self.args)
        self.head = "d" * 40
        self.args.conflict_files = ["example.py", "extra.py"]
        with self.assertRaisesRegex(RuntimeError, "cannot widen"):
            review.review(self.config, self.args)
        self.assertEqual(["example.py"], self.state()["conflict_manifest"]["files"])

    def configure_lanes(self):
        self.config["lanes"] = [{"id": f"{model}-lane", "runner": model, "cwd": str(self.root)}
                                for model in review.REVIEWERS]
        self.config["reviews"] = {"lanes": {model: f"{model}-lane" for model in review.REVIEWERS},
                                  "clean_sessions": {model: f"{model}-session" for model in review.REVIEWERS},
                                  "timeout": 0.2}

        def observe(config, lane_id):
            model = lane_id.split("-")[0]
            return {"id": lane_id, "state": model, "status": "idle", "phase": "idle",
                    "observation": {"session_id": f"{model}-session", "source": "native-session"}}

        def send(config, lane_id, message):
            model = lane_id.split("-")[0]
            current = self.state()["round"]
            output = self.directory() / f"r{current}" / f"{model}.lane-output.md"
            self.assertIn(str(output), message)
            self.assertIn("Do not edit implementation files", message)
            output.write_text(f"VERDICT: {self.verdicts[model]}\nCOMMIT: {self.head}\n")
            return {"delivery": {"verification": "submitted"}}

        observed = patch.object(review.lanes, "observe", side_effect=observe)
        sent = patch.object(review.lanes, "send", side_effect=send)
        mocked_observe, mocked_send = observed.start(), sent.start()
        self.addCleanup(observed.stop)
        self.addCleanup(sent.stop)
        return mocked_observe, mocked_send, observe, send

    def test_retained_lanes_keep_native_identity_and_skip_goal_dispatch(self):
        _, sent, _, _ = self.configure_lanes()
        state = review.review(self.config, self.args)
        self.assertEqual("declared-clean-session", state["reviewers"]["codex"]["continuity"])
        self.config["reviews"].pop("clean_sessions")
        self.head = "b" * 40
        state = review.review(self.config, self.args)
        self.assertEqual("retained", state["reviewers"]["codex"]["continuity"])
        self.assertEqual("claude-session", state["reviewer_bindings"]["claude"]["session_id"])
        self.assertEqual(4, sent.call_count)
        self.assertEqual([], [command for command in self.commands if reviewer_command(command)])

    def test_approved_delta_keeps_warm_sessions_and_records_new_head(self):
        _, sent, _, _ = self.configure_lanes()
        self.verdicts = {name: "APPROVE" for name in review.REVIEWERS}
        first = review.review(self.config, self.args)
        bindings = first["reviewer_bindings"]
        frozen = self.head
        self.head = "b" * 40
        self.args.approved_delta = True
        state = review.review(self.config, self.args)
        self.assertEqual("approved-delta", state["rounds"][-1]["mode"])
        self.assertEqual(frozen, state["rounds"][-1]["base"])
        self.assertEqual(self.head, state["frozen_sha"])
        self.assertEqual(bindings, state["reviewer_bindings"])
        prompt = (self.directory() / "r2" / "prompt.md").read_text()
        self.assertIn("WARM", prompt)
        self.assertIn("CI/test fixes", prompt)
        for name in review.REVIEWERS:
            self.assertEqual("retained", state["reviewers"][name]["continuity"])
            self.assertTrue(review.parse_verdict(self.directory() / f"{name}.md", self.head))
            self.assertFalse(review.parse_verdict(self.directory() / f"{name}.md", frozen))
        self.assertEqual(4, sent.call_count)
        self.assertEqual([], [command for command in self.commands if reviewer_command(command)])

    def test_approved_delta_requires_prior_approval_and_a_real_new_delta(self):
        _, sent, _, _ = self.configure_lanes()
        self.args.approved_delta = True
        with self.assertRaisesRegex(RuntimeError, "existing frozen approval"):
            review.review(self.config, self.args)
        self.assertEqual(0, sent.call_count)
        self.args.approved_delta = False
        self.verdicts = {name: "APPROVE" for name in review.REVIEWERS}
        review.review(self.config, self.args)
        self.args.approved_delta = True
        with self.assertRaisesRegex(RuntimeError, "changed head"):
            review.review(self.config, self.args)
        self.head = "b" * 40
        self.conflict_paths = []
        with self.assertRaisesRegex(RuntimeError, "changed review inputs"):
            review.review(self.config, self.args)
        self.assertEqual(2, sent.call_count)
        self.assertEqual(1, self.state()["round"])
        self.assertFalse((self.directory() / "r2").exists())

    def test_approved_delta_never_falls_back_to_fresh_commands(self):
        self.verdicts = {name: "APPROVE" for name in review.REVIEWERS}
        review.review(self.config, self.args)
        self.head = "b" * 40
        self.args.approved_delta = True
        before = len([argv for argv in self.commands if reviewer_command(argv)])
        with self.assertRaisesRegex(RuntimeError, "saved retained reviewers"):
            review.review(self.config, self.args)
        self.assertEqual(before, len([argv for argv in self.commands if reviewer_command(argv)]))
        self.assertEqual(1, self.state()["round"])

    def test_approved_delta_checks_both_retained_sessions_before_dispatch(self):
        observed, sent, observe, _ = self.configure_lanes()
        self.verdicts = {name: "APPROVE" for name in review.REVIEWERS}
        review.review(self.config, self.args)
        self.head = "b" * 40
        self.args.approved_delta = True
        for problem in ["missing", "foreign-session", "busy", "question", "queued"]:
            with self.subTest(problem=problem):
                def unavailable(config, lane_id):
                    item = observe(config, lane_id)
                    if lane_id == "claude-lane":
                        if problem == "missing":
                            return {"status": "missing", "state": "missing"}
                        if problem == "foreign-session":
                            item["observation"]["session_id"] = "another-pr-session"
                        else:
                            item["phase"] = problem
                    return item
                observed.side_effect = unavailable
                with patch.object(review.lanes, "launch") as launched:
                    with self.assertRaises(RuntimeError):
                        review.review(self.config, self.args)
                self.assertEqual(0, launched.call_count)
                self.assertEqual(2, sent.call_count)
                self.assertEqual(1, self.state()["round"])
                self.assertFalse((self.directory() / "r2").exists())

    def test_approved_delta_fix_round_uses_last_reviewed_head(self):
        self.configure_lanes()
        self.verdicts = {name: "APPROVE" for name in review.REVIEWERS}
        review.review(self.config, self.args)
        self.args.approved_delta = True
        self.head = "b" * 40
        self.verdicts["codex"] = "COMMENT"
        state = review.review(self.config, self.args)
        self.assertEqual("needs_changes", state["status"])
        self.assertEqual("a" * 40, state["frozen_sha"])
        self.head = "c" * 40
        self.verdicts["codex"] = "APPROVE"
        state = review.review(self.config, self.args)
        self.assertEqual("b" * 40, state["rounds"][-1]["base"])
        self.assertEqual(self.head, state["frozen_sha"])

    def test_approved_delta_keeps_the_round_limit_and_excludes_conflict_mode(self):
        self.configure_lanes()
        for number in range(1, 5):
            self.head = f"{number:040x}"
            review.review(self.config, self.args)
        self.verdicts = {name: "APPROVE" for name in review.REVIEWERS}
        review.review(self.config, self.args)
        self.head = "b" * 40
        self.args.approved_delta = True
        self.args.conflict_only = True
        with self.assertRaisesRegex(ValueError, "cannot be combined"):
            review.review(self.config, self.args)
        self.args.conflict_only = False
        with self.assertRaisesRegex(RuntimeError, "maximum 5"):
            review.review(self.config, self.args)
        self.assertEqual(5, self.state()["round"])

    def test_approved_delta_uses_real_git_history_without_reviewing_a_rewrite(self):
        def git(*args):
            return subprocess.check_output([
                "git", "-c", "user.name=fixture", "-c", "user.email=fixture@example.com",
                "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", *args,
            ], cwd=self.root, text=True, stderr=subprocess.DEVNULL).strip()

        git("init", "-b", "main")
        source = self.root / "example.test.py"
        source.write_text("assert True\n")
        git("add", source.name)
        git("commit", "-m", "initial fixture")
        self.head = git("rev-parse", "HEAD")
        frozen = self.head
        _, sent, _, _ = self.configure_lanes()
        self.verdicts = {name: "APPROVE" for name in review.REVIEWERS}
        original = self.run_command

        def real_git(argv, **kwargs):
            return common.run(argv, **kwargs) if argv[0] == "git" else original(argv, **kwargs)

        with patch.object(review, "run", side_effect=real_git):
            review.review(self.config, self.args)
            source.write_text("assert True\nassert 1 == 1\n")
            git("add", source.name)
            git("commit", "-m", "fix fixture assertion")
            self.head = git("rev-parse", "HEAD")
            self.args.approved_delta = True
            state = review.review(self.config, self.args)
            self.assertEqual(frozen, state["rounds"][-1]["base"])
            self.assertEqual(self.head, state["frozen_sha"])
            git("checkout", "--orphan", "rewrite")
            source.write_text("assert 2 == 2\n")
            git("add", source.name)
            git("commit", "-m", "unrelated fixture history")
            self.head = git("rev-parse", "HEAD")
            with self.assertRaisesRegex(RuntimeError, "git failed"):
                review.review(self.config, self.args)
        self.assertEqual(4, sent.call_count)
        self.assertEqual(2, self.state()["round"])
        self.assertFalse((self.directory() / "r3").exists())

    def test_lane_session_cannot_be_rebound_to_another_pr(self):
        _, sent, _, _ = self.configure_lanes()
        review.review(self.config, self.args)
        self.args.pr = 13
        state = review.review(self.config, self.args)
        self.assertEqual("review_error", state["status"])
        self.assertIn("another canonical PR", state["reviewers"]["codex"]["error"])
        self.assertEqual(2, sent.call_count)

    def test_existing_lane_needs_clean_context_and_question_is_never_answered(self):
        observed, sent, observe, _ = self.configure_lanes()
        self.config["reviews"].pop("clean_sessions")
        state = review.review(self.config, self.args)
        self.assertIn("clean_sessions", state["reviewers"]["codex"]["error"])
        self.assertEqual(0, sent.call_count)
        self.config["reviews"]["clean_sessions"] = {model: f"{model}-session" for model in review.REVIEWERS}

        def question(config, lane_id):
            result = observe(config, lane_id)
            result.update(phase="question", status="question")
            result["observation"]["question"] = {"text": "Which scope?"}
            return result

        observed.side_effect = question
        state = review.review(self.config, self.args)
        self.assertIn("pending question", state["reviewers"]["claude"]["error"])
        self.assertEqual(0, sent.call_count)

    def test_missing_lane_launches_without_worker_goal_and_records_fresh_context(self):
        observed, _, observe, _ = self.configure_lanes()
        self.config["reviews"].pop("clean_sessions")
        missing = set(review.REVIEWERS)

        def first_missing(config, lane_id):
            model = lane_id.split("-")[0]
            if model in missing:
                return {"status": "missing", "state": "missing", "phase": "missing"}
            return observe(config, lane_id)

        def launch(config, lane_id, **kwargs):
            self.assertFalse(kwargs["submit_goal"])
            missing.remove(lane_id.split("-")[0])
            return {"status": "launched", "resume_id": None}

        observed.side_effect = first_missing
        with patch.object(review.lanes, "launch", side_effect=launch) as launched:
            state = review.review(self.config, self.args)
        self.assertEqual(2, launched.call_count)
        self.assertEqual("fresh-lane", state["reviewers"]["claude"]["continuity"])

    def test_lane_session_change_invalidates_even_written_approval(self):
        observed, sent, observe, send = self.configure_lanes()
        submitted = set()

        def tracking_send(config, lane_id, message):
            result = send(config, lane_id, message)
            submitted.add(lane_id)
            return result

        def switched(config, lane_id):
            item = observe(config, lane_id)
            if lane_id in submitted:
                item["observation"]["session_id"] = "unrelated-session"
            return item

        sent.side_effect = tracking_send
        observed.side_effect = switched
        state = review.review(self.config, self.args)
        self.assertEqual("review_error", state["status"])
        self.assertIn("session changed", state["reviewers"]["codex"]["error"])
        self.assertFalse((self.directory() / "codex.md").exists())

    def test_lane_disappearance_never_promotes_written_verdict(self):
        observed, sent, observe, send = self.configure_lanes()
        submitted = set()

        def tracking_send(config, lane_id, message):
            result = send(config, lane_id, message)
            submitted.add(lane_id)
            return result

        observed.side_effect = lambda config, lane_id: (
            {"status": "missing", "state": "missing"} if lane_id in submitted else observe(config, lane_id)
        )
        sent.side_effect = tracking_send
        state = review.review(self.config, self.args)
        self.assertEqual("review_error", state["status"])
        self.assertIn("disappeared", state["reviewers"]["claude"]["error"])
        self.assertFalse((self.directory() / "claude.md").exists())

    def test_lane_artifact_requires_native_idle_completion(self):
        observed, sent, observe, send = self.configure_lanes()
        self.config["reviews"]["timeout"] = 0.01
        submitted = set()

        def tracking_send(config, lane_id, message):
            result = send(config, lane_id, message)
            submitted.add(lane_id)
            return result

        def busy(config, lane_id):
            item = observe(config, lane_id)
            if lane_id in submitted:
                item.update(phase="busy", status="busy")
            return item

        sent.side_effect = tracking_send
        observed.side_effect = busy
        state = review.review(self.config, self.args)
        self.assertEqual("review_error", state["status"])
        self.assertIn("did not finish", state["reviewers"]["claude"]["error"])
        self.assertEqual(1, state["round"])

    def test_two_independent_commands_launch_before_either_finishes(self):
        barrier = threading.Barrier(2)
        original = self.run_command

        def concurrent_runner(argv, **kwargs):
            if reviewer_command(argv):
                barrier.wait(timeout=0.5)
            return original(argv, **kwargs)

        with patch.object(review, "run", side_effect=concurrent_runner):
            state = review.review(self.config, self.args)
        self.assertEqual("needs_changes", state["status"])
        models = [command[0] for command in self.commands if reviewer_command(command)]
        self.assertCountEqual(["codex", "claude"], models)

    def test_simultaneous_same_pr_review_is_rejected(self):
        entered = threading.Event()
        release = threading.Event()
        original = self.run_command

        def blocked_runner(argv, **kwargs):
            if reviewer_command(argv):
                entered.set()
                if not release.wait(timeout=0.5):
                    raise RuntimeError("test did not release review")
            return original(argv, **kwargs)

        with patch.object(review, "run", side_effect=blocked_runner):
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                first = pool.submit(review.review, self.config, self.args)
                try:
                    self.assertTrue(entered.wait(timeout=0.5))
                    with self.assertRaisesRegex(RuntimeError, "already has a review"):
                        review.review(self.config, self.args)
                finally:
                    release.set()
                first.result(timeout=0.5)
        self.assertEqual(1, self.state()["round"])


if __name__ == "__main__":
    unittest.main()
