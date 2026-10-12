import argparse
from concurrent.futures import ThreadPoolExecutor
import fcntl
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import lanes


def result(stdout="", returncode=0, stderr=""):
    return subprocess.CompletedProcess([], returncode, stdout, stderr)


class LaneTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.config = {"version": 1, "state_dir": str(root / "state"),
                       "tmux": {"socket": "lanes-test-private"}, "lanes": []}
        for lane_id, runner in (("one", "codex"), ("two", "claude")):
            cwd = root / "repo"
            cwd.mkdir(exist_ok=True)
            goal = root / f"{lane_id}-GOAL.md"
            goal.write_text("Implement the approved task.")
            self.config["lanes"].append({"id": lane_id, "runner": runner, "cwd": str(cwd),
                                         "goal": str(goal), "report": str(root / f"{lane_id}-REPORT.md")})

    def reserve(self, lane_id, *paths):
        return lanes.reserve(self.config, lane_id, paths)

    def test_initial_config_parent_child_conflict(self):
        self.config["lanes"][0]["reservations"] = ["src"]
        self.config["lanes"][1]["reservations"] = ["src/main.py"]
        with self.assertRaisesRegex(ValueError, "reservation conflict"):
            lanes.status(self.config)
        self.assertFalse(lanes.registry_path(self.config).exists())

    def test_reserve_rejects_both_parent_and_child(self):
        self.reserve("one", "src/main.py")
        for path in ("src", "src/main.py/child", "src/main.py"):
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, "reservation conflict"):
                self.reserve("two", path)
        self.assertEqual(lanes._record(self.config, "two")["reservations"], [])

    def test_transfer_is_persistent_and_does_not_reseed_config(self):
        self.config["lanes"][0]["reservations"] = ["src"]
        output = lanes.transfer(self.config, "one", "two", ["src"])
        self.assertEqual(output["destination"], "two")
        self.assertEqual(lanes._record(self.config, "one")["reservations"], [])
        self.assertEqual(lanes._record(self.config, "two")["reservations"], output["paths"])
        self.reserve("one", "other")

    def test_transfer_requires_exact_owner_and_preserves_source(self):
        self.reserve("one", "src")
        with self.assertRaisesRegex(ValueError, "exact reservations"):
            lanes.transfer(self.config, "one", "two", ["src/main.py"])
        self.assertEqual(len(lanes._record(self.config, "one")["reservations"]), 1)

    def test_transfer_cannot_leave_overlapping_reservations(self):
        self.reserve("one", "src", "src/main.py")
        with self.assertRaisesRegex(ValueError, "reservation conflict"):
            lanes.transfer(self.config, "one", "two", ["src/main.py"])
        self.assertEqual(lanes._record(self.config, "two")["reservations"], [])

    def test_simultaneous_reservations_have_one_owner(self):
        def attempt(lane_id):
            try:
                self.reserve(lane_id, "shared")
                return True
            except ValueError as error:
                self.assertIn("reservation conflict", str(error))
                return False
        with ThreadPoolExecutor(max_workers=2) as pool:
            accepted = list(pool.map(attempt, ("one", "two")))
        self.assertEqual(accepted.count(True), 1)
        self.assertEqual(sum(len(lanes._record(self.config, lane)["reservations"])
                             for lane in ("one", "two")), 1)

    def test_status_preserves_questions_and_queue_details(self):
        def command(argv, **kwargs):
            if "list-panes" in argv:
                return result("%1\n" if "=one" in argv else "%2\n")
            runner = argv[-1]
            phase = "question" if runner == "codex" else "queued"
            return result(json.dumps({"state": runner, "phase": phase,
                                      "question": {"text": "Which target?"} if phase == "question" else None,
                                      "queued": phase == "queued", "session_id": runner + "-session"}))
        with patch.object(lanes, "run", side_effect=command) as mocked:
            statuses = lanes.status(self.config)
        self.assertEqual([item["status"] for item in statuses], ["question", "queued"])
        self.assertEqual(statuses[0]["observation"]["question"]["text"], "Which target?")
        self.assertFalse(lanes.registry_path(self.config).exists())
        for call in mocked.call_args_list:
            argv, kwargs = call.args[0], call.kwargs
            if argv[0] == "tmux":
                self.assertEqual(argv[1:3], ["-L", "lanes-test-private"])
            else:
                self.assertEqual(kwargs["env"]["TMUX_MODEL_DRIVER_SOCKET"], "lanes-test-private")
                self.assertIn("TMUX_MODEL_DRIVER_OBSERVABILITY_DIR", kwargs["env"])
                self.assertEqual(kwargs["env"]["TMUX_MODEL_DRIVER_READ_ONLY"], "1")

    def test_status_uses_configured_pane_and_observability_without_acknowledging(self):
        lane = self.config['lanes'][0]
        lane['pane_id'] = '%2'
        lane['observability_dir'] = str(Path(self.config['state_dir']) / 'existing-hooks')
        def command(argv, **kwargs):
            if 'list-panes' in argv:return result('%1\n%2\n')
            self.assertEqual(argv[-2], '%2')
            self.assertEqual(kwargs['env']['TMUX_MODEL_DRIVER_OBSERVABILITY_DIR'], str(Path(lane['observability_dir']).resolve()))
            return result(json.dumps({'state': 'codex', 'phase': 'idle', 'accepted': {'receipt_id': 'late'}}))
        with patch.object(lanes, 'run', side_effect=command):
            self.assertEqual(lanes.observe(self.config, 'one', read_only=True)['status'], 'idle')
        self.assertFalse(lanes.registry_path(self.config).exists())

    def test_transport_environment_does_not_inherit_observation_mode(self):
        with patch.dict('os.environ', {'TMUX_MODEL_DRIVER_READ_ONLY': '1'}):
            self.assertNotIn('TMUX_MODEL_DRIVER_READ_ONLY', lanes._env(self.config, self.config['lanes'][0], {}))

    def test_status_retains_session_after_exit_without_writing(self):
        lanes._update(self.config, "one", {"session_id": "recorded-session"})
        before = lanes.registry_path(self.config).read_bytes()
        for present in (False, True):
            def command(argv, **kwargs):
                if "list-panes" in argv:
                    return result("%1\n" if present and "=one" in argv else "", 0 if present else 1)
                return result(json.dumps({"state": "shell", "phase": "idle", "session_id": None}))
            with patch.object(lanes, "run", side_effect=command):
                item = lanes.status(self.config)[0]
            self.assertEqual(item["session_id"], "recorded-session")
            self.assertEqual(item["status"], "shell" if present else "missing")
        self.assertEqual(lanes.registry_path(self.config).read_bytes(), before)

    def test_launch_resumes_preserved_shell_through_guard_without_resubmitting_goal(self):
        lane = self.config["lanes"][0]
        lane["resume_id"] = "chosen-session"
        lanes._update(self.config, "one", {"session_id": "chosen-session", "goal_submitted": True})
        calls = []
        reads = 0
        def command(argv, **kwargs):
            nonlocal reads
            calls.append(argv)
            if argv[0] == "node":
                request = json.loads(kwargs["input"])
                self.assertEqual(request["resume_id"], "chosen-session")
                return result(json.dumps({"command": "resumed-runner", "goal_supported": True,
                    "runtime_dir": request["runtime_dir"], "observability_dir": request["runtime_dir"] + "/.observability"}))
            if Path(argv[1]).name == "pane-state.sh":
                reads += 1
                return result(json.dumps({"state": "shell" if reads == 1 else "codex", "phase": "idle",
                    "session_id": None if reads == 1 else "chosen-session"}))
            self.assertEqual(Path(argv[1]).name, "send-shell-script.sh")
            self.assertEqual(kwargs["input"], "resumed-runner")
            return result(json.dumps({"submitted": True}))
        with patch.object(lanes, "_pane", return_value="%1"), patch.object(lanes, "run", side_effect=command):
            output = lanes.launch(self.config, "one")
        self.assertEqual(output["pane_id"], "%1")
        self.assertEqual(output["resume_id"], "chosen-session")
        self.assertEqual(lanes._record(self.config, "one")["session_id"], "chosen-session")
        self.assertFalse(any("new-session" in call or "send-and-verify.sh" in str(call) for call in calls))

    def test_launch_shell_requires_known_resume_id(self):
        with patch.object(lanes, "_pane", return_value="%1"), patch.object(lanes, "_observe", return_value={"state": "shell"}):
            with self.assertRaisesRegex(ValueError, "resume_id"):
                lanes.launch(self.config, "one")

    def test_launch_retries_owned_startup_failure_without_inventing_session(self):
        owner = {"pane_id": "%1", "pane_pid": "42", "process_started_at": 7, "socket_path": "fixture"}
        lanes._update(self.config, "one", {"launch_pane_owner": owner, "goal_submitted": True})
        runtime = str(Path(self.config["state_dir"]) / "runtime")
        adapter = {"command": "fresh-runner", "runtime_dir": runtime, "observability_dir": runtime + "/.observability"}
        def command(argv, **kwargs):
            self.assertEqual(Path(argv[1]).name, "send-shell-script.sh")
            self.assertEqual(kwargs["input"], "fresh-runner")
            return result('{"submitted":true}')
        states = [{**owner, "state": "shell", "phase": "idle"}, {**owner, "state": "codex", "phase": "idle"}]
        with patch.object(lanes, "_pane", return_value="%1"), patch.object(lanes, "_observe", side_effect=states), \
             patch.object(lanes, "_runner_adapter", return_value=adapter) as built, patch.object(lanes, "run", side_effect=command):
            output = lanes.launch(self.config, "one", submit_goal=False)
        self.assertIsNone(output['resume_id'])
        self.assertIsNone(built.call_args.args[2].get('session_id'))
        replacement = {**owner, "pane_pid": "99", "state": "shell"}
        with patch.object(lanes, "_pane", return_value="%1"), patch.object(lanes, "_observe", return_value=replacement), \
             patch.object(lanes, "_runner_adapter") as blocked:
            with self.assertRaisesRegex(ValueError, "resume_id"):
                lanes.launch(self.config, "one", submit_goal=False)
        blocked.assert_not_called()

    def test_launch_resolves_shared_update_gate_before_native_readiness(self):
        runtime = str(Path(self.config["state_dir"]) / "runtime")
        adapter = {"command": "runner", "runtime_dir": runtime, "observability_dir": runtime + "/.observability"}
        def command(argv, **kwargs):
            if "new-session" in argv: return result("%9\n")
            self.assertEqual(Path(argv[1]).name, "resolve-launch-blockers.sh")
            return result('{}')
        states = [{"state": "codex", "phase": "launch-blocker", "auto_action": "codex-skip-update"},
                  {"state": "codex", "phase": "idle"}]
        with patch.object(lanes, "_pane", return_value=None), patch.object(lanes, "_runner_adapter", return_value=adapter), \
             patch.object(lanes, "_observe", side_effect=states), patch.object(lanes, "run", side_effect=command) as mocked:
            self.assertEqual(lanes.launch(self.config, "one", submit_goal=False)["status"], "launched")
        self.assertEqual(sum("resolve-launch-blockers.sh" in str(call) for call in mocked.call_args_list), 1)

    def test_lane_model_and_effort_reach_shared_launch_and_resume_adapter(self):
        lane = self.config['lanes'][0]
        lane.update(model='chosen-model', effort='xhigh')
        def adapter(argv, **kwargs):
            request = json.loads(kwargs['input'])
            self.assertEqual((request['model'], request['effort']), ('chosen-model', 'xhigh'))
            return result(json.dumps({'command': 'configured-runner', 'runtime_dir': request['runtime_dir']}))
        with patch.object(lanes, 'run', side_effect=adapter):
            lanes._runner_adapter(self.config, lane, {})
            lanes._runner_adapter(self.config, lane, {'session_id': 'retained-session'})
            lane['resume_id'] = 'explicit-session'
            with patch.object(lanes, 'run', return_value=result('{}')) as explicit:
                lanes._runner_adapter(self.config, lane, {'session_id': 'older-session'})
            self.assertEqual(json.loads(explicit.call_args.kwargs['input'])['resume_id'], 'explicit-session')

    def test_send_refuses_shell_and_never_uses_raw_tmux_send(self):
        def command(argv, **kwargs):
            if "list-panes" in argv:
                return result("%1\n")
            self.assertEqual(Path(argv[1]).name, "send-and-verify.sh")
            self.assertEqual(argv[3], "codex")
            return result(json.dumps({"verification": "wrong_mode", "before_state": "shell"}), 2)
        with patch.object(lanes, "run", side_effect=command) as mocked:
            with self.assertRaisesRegex(RuntimeError, "wrong_mode"):
                lanes.send(self.config, "one", "Do the work")
        self.assertTrue(all("send-keys" not in call.args[0] for call in mocked.call_args_list))

    def test_launch_stages_detached_runner_and_submits_goal_through_driver(self):
        calls = []
        def command(argv, **kwargs):
            calls.append((argv, kwargs))
            if "list-panes" in argv:
                return result("", 1)
            if argv[0] == "node":
                request = json.loads(kwargs["input"])
                self.assertEqual(request["runner"], "codex")
                return result(json.dumps({"command": "runner-from-shared-adapter", "goal_supported": True,
                                          "runtime_dir": request["runtime_dir"],
                                          "observability_dir": request["runtime_dir"] + "/.observability",
                                          "goal_prefix": "/goal"}))
            if "new-session" in argv:
                self.assertIn("-d", argv)
                self.assertEqual(argv[-1], "runner-from-shared-adapter")
                return result("%9\n")
            if Path(argv[1]).name == "pane-state.sh":
                return result(json.dumps({"state": "codex", "phase": "idle", "session_id": "native-session"}))
            self.assertEqual(Path(argv[1]).name, "send-and-verify.sh")
            self.assertTrue(kwargs["input"].startswith("/goal Read "))
            self.assertIn(self.config["lanes"][0]["report"], kwargs["input"])
            self.assertEqual(kwargs["env"]["TMUX_MODEL_DRIVER_SESSION_ID"], "native-session")
            return result(json.dumps({"verification": "submitted"}))
        with patch.object(lanes, "run", side_effect=command):
            output = lanes.launch(self.config, "one")
        self.assertEqual(output["status"], "launched")
        self.assertTrue(lanes._record(self.config, "one")["goal_submitted"])
        self.assertEqual(lanes._record(self.config, "one")["session_id"], "native-session")
        self.assertTrue(all("kill-server" not in argv and "select-pane" not in argv and
                            "send-keys" not in argv for argv, _ in calls))

    def test_accepted_goal_is_persisted_before_owner_acknowledges(self):
        goal = "/goal Complete the approved task"
        lanes._update(self.config, "one", {"goal_payload": goal, "goal_submitted": False})
        calls = []
        def command(argv, **kwargs):
            calls.append(argv)
            if "list-panes" in argv:
                return result("%1\n")
            if Path(argv[1]).name == "ack-acceptance.sh":
                record = lanes._record(self.config, "one")
                self.assertTrue(record["goal_submitted"])
                self.assertEqual(record["last_delivery"]["receipt_id"], "accepted-goal")
                return result(json.dumps({"acknowledged": True}))
            self.assertEqual(Path(argv[1]).name, "pane-state.sh")
            return result(json.dumps({"state": "codex", "phase": "idle", "accepted": {
                "receipt_id": "accepted-goal", "payload_hash": hashlib.sha256(goal.encode()).hexdigest()}}))
        with patch.object(lanes, "run", side_effect=command):
            output = lanes.launch(self.config, "one")
        self.assertEqual(output["status"], "existing")
        self.assertEqual(sum(Path(argv[1]).name == "ack-acceptance.sh" for argv in calls), 1)

    def test_concurrent_acknowledgements_do_not_abort_observers(self):
        for verification in ("driver_busy", "no_accepted_receipt"):
            with self.subTest(verification=verification):
                def command(argv, **kwargs):
                    if "list-panes" in argv:
                        return result("%1\n")
                    if Path(argv[1]).name == "ack-acceptance.sh":
                        return result(json.dumps({"acknowledged": False, "verification": verification}), 2)
                    return result(json.dumps({"state": "codex", "phase": "idle", "accepted": {
                        "receipt_id": "shared-accepted-receipt", "payload_hash": "known-prompt"}}))
                with patch.object(lanes, "run", side_effect=command):
                    self.assertEqual(lanes.observe(self.config, "one")["status"], "idle")
                self.assertEqual(lanes._record(self.config, "one")["last_delivery"]["receipt_id"], "shared-accepted-receipt")

    def test_send_records_its_queue_delivery_before_acknowledging_the_exact_receipt(self):
        accepted = {"receipt_id": "this-handoff", "payload_hash": "payload", "source": "runner-queue", "session_id": None}
        def command(argv, **kwargs):
            self.assertEqual(Path(argv[1]).name, "ack-acceptance.sh")
            self.assertEqual(argv[-1], accepted["receipt_id"])
            self.assertEqual(lanes._record(self.config, "one")["last_delivery"], accepted)
            return result(json.dumps({"acknowledged": True}))
        def older_observation(*args):
            lanes._update(self.config, "one", {"last_delivery": {"receipt_id": "older-alias"}})
        with patch.object(lanes, "_pane", return_value="%1"), \
             patch.object(lanes, "_send", return_value={"submitted": True, "evidence": accepted}), \
             patch.object(lanes, "_observe", side_effect=older_observation), \
             patch.object(lanes, "run", side_effect=command):
            output = lanes.send(self.config, "one", "handoff")
        self.assertTrue(output["delivery"]["submitted"])
        self.assertEqual(lanes._record(self.config, "one")["last_delivery"], accepted)

    def test_mismatched_acknowledgement_still_refuses(self):
        def command(argv, **kwargs):
            if "list-panes" in argv:
                return result("%1\n")
            if Path(argv[1]).name == "ack-acceptance.sh":
                return result(json.dumps({"acknowledged": False, "verification": "receipt_mismatch"}), 2)
            return result(json.dumps({"state": "codex", "phase": "idle", "accepted": {
                "receipt_id": "changed-receipt", "payload_hash": "known-prompt"}}))
        with patch.object(lanes, "run", side_effect=command):
            with self.assertRaisesRegex(RuntimeError, "receipt_mismatch"):
                lanes.observe(self.config, "one")

    def test_late_goal_acceptance_prevents_duplicate_retry(self):
        goal = "/goal Complete the approved task"
        lanes._update(self.config, "one", {"goal_payload": goal, "goal_submitted": False})
        def command(argv, **kwargs):
            if "list-panes" in argv:
                return result("%1\n")
            self.assertEqual(Path(argv[1]).name, "pane-state.sh")
            return result(json.dumps({"state": "codex", "phase": "idle", "accepted": {
                "payload_hash": hashlib.sha256(goal.encode()).hexdigest()}}))
        with patch.object(lanes, "run", side_effect=command):
            output = lanes.launch(self.config, "one")
        self.assertEqual(output["status"], "existing")
        self.assertTrue(lanes._record(self.config, "one")["goal_submitted"])

    def test_existing_lane_is_observed_without_goal_resubmission(self):
        def command(argv, **kwargs):
            if "list-panes" in argv:
                return result("%1\n")
            self.assertEqual(Path(argv[1]).name, "pane-state.sh")
            return result(json.dumps({"state": "codex", "phase": "busy"}))
        with patch.object(lanes, "run", side_effect=command):
            output = lanes.launch(self.config, "one", restoring=True)
        self.assertEqual(output["status"], "existing")

    def test_launch_retry_after_question_submits_one_goal(self):
        created = False
        phase = "question"
        sent = []
        def command(argv, **kwargs):
            nonlocal created
            if "list-panes" in argv:
                return result("%1\n") if created else result("", 1)
            if argv[0] == "node":
                runtime = json.loads(kwargs["input"])["runtime_dir"]
                return result(json.dumps({"command": "runner", "goal_supported": True,
                                          "goal_prefix": "/goal", "runtime_dir": runtime,
                                          "observability_dir": runtime + "/.observability"}))
            if "new-session" in argv:
                self.assertFalse(created)
                created = True
                return result("%1\n")
            if Path(argv[1]).name == "pane-state.sh":
                return result(json.dumps({"state": "codex", "phase": phase, "session_id": "session"}))
            self.assertEqual(Path(argv[1]).name, "send-and-verify.sh")
            sent.append(kwargs["input"])
            return result(json.dumps({"verification": "submitted"}))
        with patch.object(lanes, "run", side_effect=command):
            self.assertEqual(lanes.launch(self.config, "one")["status"], "question")
            self.assertEqual(sent, [])
            phase = "idle"
            self.assertEqual(lanes.launch(self.config, "one")["status"], "launched")
            self.assertEqual(lanes.launch(self.config, "one")["status"], "existing")
        self.assertEqual(len(sent), 1)
        self.assertTrue(sent[0].startswith("/goal Read "))
        self.assertTrue(lanes._record(self.config, "one")["goal_submitted"])

    def test_registered_approved_goal_is_not_resubmitted_when_idle(self):
        lanes._update(self.config, "one", {"goal_submitted": True})
        def command(argv, **kwargs):
            if "list-panes" in argv:
                return result("%1\n")
            self.assertEqual(Path(argv[1]).name, "pane-state.sh")
            return result(json.dumps({"state": "codex", "phase": "idle"}))
        with patch.object(lanes, "run", side_effect=command):
            self.assertEqual(lanes.launch(self.config, "one")["status"], "existing")

    def test_reviewer_launch_does_not_require_or_submit_goal(self):
        Path(self.config["lanes"][1]["goal"]).unlink()
        def command(argv, **kwargs):
            if "list-panes" in argv:
                return result("", 1)
            if argv[0] == "node":
                runtime = json.loads(kwargs["input"])["runtime_dir"]
                return result(json.dumps({"command": "reviewer", "goal_supported": False,
                                          "runtime_dir": runtime, "observability_dir": runtime + "/.observability"}))
            if "new-session" in argv:
                return result("%8\n")
            self.assertEqual(Path(argv[1]).name, "pane-state.sh")
            return result(json.dumps({"state": "claude", "phase": "idle", "session_id": "review-session"}))
        with patch.object(lanes, "run", side_effect=command):
            output = lanes.launch(self.config, "two", submit_goal=False)
        self.assertEqual(output["status"], "launched")
        self.assertEqual(output["observation"]["session_id"], "review-session")
        self.assertFalse(lanes._record(self.config, "two").get("goal_submitted", False))

    def test_single_lane_observation_does_not_inspect_other_lanes(self):
        def command(argv, **kwargs):
            if "list-panes" in argv:
                self.assertIn("=one", argv)
                return result("%1\n")
            self.assertEqual(argv[-1], "codex")
            return result(json.dumps({"state": "codex", "phase": "idle"}))
        with patch.object(lanes, "run", side_effect=command) as mocked:
            self.assertEqual(lanes.observe(self.config, "one")["status"], "idle")
        self.assertEqual(mocked.call_count, 2)

    def test_duplicate_launch_fails_before_touching_tmux(self):
        path = Path(self.config["state_dir"]) / "launch" / "one.lock"
        path.parent.mkdir(parents=True)
        with path.open("a") as lock, patch.object(lanes, "run") as mocked:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(RuntimeError, "already running"):
                lanes.launch(self.config, "one")
        mocked.assert_not_called()

    def test_flush_uses_bound_driver_without_resending_payload(self):
        lanes._update(self.config, "one", {"goal_payload": "saved goal", "session_id": "native-session"})
        def command(argv, **kwargs):
            if "list-panes" in argv:
                return result("%1\n")
            if Path(argv[1]).name == "pane-state.sh":
                return result(json.dumps({"state": "codex", "phase": "busy"}))
            self.assertEqual(Path(argv[1]).name, "flush-queued.sh")
            self.assertEqual(kwargs["input"], "")
            self.assertEqual(kwargs["env"]["TMUX_MODEL_DRIVER_SOCKET"], "lanes-test-private")
            self.assertEqual(kwargs["env"]["TMUX_MODEL_DRIVER_SESSION_ID"], "native-session")
            self.assertIn("TMUX_MODEL_DRIVER_OBSERVABILITY_DIR", kwargs["env"])
            return result(json.dumps({"verification": "submitted", "payload": "saved goal"}))
        with patch.object(lanes, "run", side_effect=command):
            output = lanes.flush(self.config, "one")
        self.assertEqual(output["delivery"]["verification"], "submitted")
        self.assertTrue(lanes._record(self.config, "one")["goal_submitted"])

    def test_flush_does_not_mark_unrelated_prompt_as_goal(self):
        lanes._update(self.config, "one", {"goal_payload": "saved goal"})
        with patch.object(lanes, "_pane", return_value="%1"), \
                patch.object(lanes, "_send", return_value={"verification": "submitted", "payload": "follow-up"}), \
                patch.object(lanes, "_observe", return_value={"state": "codex", "phase": "busy"}):
            lanes.flush(self.config, "one")
        self.assertFalse(lanes._record(self.config, "one").get("goal_submitted", False))

    def test_unsupported_goal_fails_before_creating_session(self):
        def command(argv, **kwargs):
            if "list-panes" in argv:
                return result("", 1)
            self.assertEqual(argv[0], "node")
            return result(json.dumps({"goal_supported": False}))
        with patch.object(lanes, "run", side_effect=command):
            with self.assertRaisesRegex(ValueError, "goal_command"):
                lanes.launch(self.config, "two")

    def test_restore_uses_saved_session_without_overwriting_active_goal(self):
        lanes._update(self.config, "one", {"session_id": "saved-session", "goal_submitted": True})
        def command(argv, **kwargs):
            if "list-panes" in argv:
                return result("", 1)
            if argv[0] == "node":
                request = json.loads(kwargs["input"])
                self.assertEqual(request["resume_id"], "saved-session")
                return result(json.dumps({"command": "resumed-runner", "goal_supported": True,
                                          "runtime_dir": request["runtime_dir"],
                                          "observability_dir": request["runtime_dir"] + "/.observability"}))
            if "new-session" in argv:
                return result("%4\n")
            self.assertEqual(Path(argv[1]).name, "pane-state.sh")
            return result(json.dumps({"state": "codex", "phase": "idle", "session_id": "saved-session"}))
        with patch.object(lanes, "run", side_effect=command):
            output = lanes.launch(self.config, "one", restoring=True)
        self.assertEqual(output["status"], "restored")
        self.assertEqual(output["resume_id"], "saved-session")

    def test_launch_surfaces_pending_question_without_answering(self):
        def command(argv, **kwargs):
            if "list-panes" in argv:
                return result("", 1)
            if argv[0] == "node":
                runtime = json.loads(kwargs["input"])["runtime_dir"]
                return result(json.dumps({"command": "runner", "goal_supported": True,
                                          "runtime_dir": runtime, "observability_dir": runtime + "/.observability"}))
            if "new-session" in argv:
                return result("%4\n")
            self.assertEqual(Path(argv[1]).name, "pane-state.sh")
            return result(json.dumps({"state": "codex", "phase": "question", "pending_question": True}))
        with patch.object(lanes, "run", side_effect=command):
            output = lanes.launch(self.config, "one")
        self.assertEqual(output["status"], "question")
        self.assertIn("question; inspect", Path(self.config["lanes"][0]["report"]).read_text())

    def test_ambiguous_existing_session_refuses_delivery(self):
        with patch.object(lanes, "run", return_value=result("%1\n%2\n")) as mocked:
            with self.assertRaisesRegex(ValueError, "several panes"):
                lanes.send(self.config, "one", "Do the work")
        self.assertEqual(mocked.call_count, 1)

    def test_cli_arguments(self):
        parser = argparse.ArgumentParser()
        lanes.add_parser(parser.add_subparsers(dest="command", required=True))
        args = parser.parse_args(["transfer", "one", "two", "src/main.py"])
        self.assertEqual((args.source, args.destination, args.paths), ("one", "two", ["src/main.py"]))
        args = parser.parse_args(["send", "one", "--file", "prompt.txt"])
        self.assertEqual(args.file, "prompt.txt")
        args = parser.parse_args(["flush", "one"])
        self.assertEqual((args.command, args.lane), ("flush", "one"))


if __name__ == "__main__":
    unittest.main()
