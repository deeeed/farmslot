"""Independent review rounds with durable limits and frozen approvals."""

import concurrent.futures
import fcntl
import json
import os
import re
import time
from pathlib import Path

from common import append_report, resolve_path, run, write_json
import lanes


REVIEWERS = ("codex", "claude")
DEFAULT_COMMANDS = {
    "codex": ["codex", "exec", "--sandbox", "read-only", "-"],
    "claude": ["claude", "-p", "--permission-mode", "plan"],
}


def review_dir(config, repo, pr):
    if not re.fullmatch(r"[\w.-]+/[\w.-]+", repo) or int(pr) < 1:
        raise ValueError("review requires owner/repository and a positive PR number")
    return Path(config["state_dir"]) / "reviews" / f"{repo.replace('/', '%2F')}-{pr}"


def review_state_path(config, repo, pr):
    return review_dir(config, repo, pr) / "state.json"


def legacy_review_dir(config, repo, pr):
    root = config.get("reviews", {}).get("legacy_root")
    if not root:
        return None
    name = repo.split("/")[1]
    prefixes = (name, name.removesuffix("_monorepo"), name.removeprefix("experimental-"),
                name.removeprefix("experimental-metamask-"),
                name.removeprefix("experimental-metamask-recipe-"))
    for prefix in prefixes:
        directory = resolve_path(config, root) / f"{prefix}-{pr}"
        if directory.is_dir():
            return directory
    return None


def verdict_dir(config, repo, pr):
    directory = review_dir(config, repo, pr)
    # New rounds own their verdicts exclusively. Never inherit legacy approval after a failed round.
    if review_state_path(config, repo, pr).exists():
        return directory, False
    legacy = legacy_review_dir(config, repo, pr)
    return (legacy, True) if legacy else (directory, False)


def _verdict(text, sha):
    lines = text.splitlines()
    if len(lines) < 2 or lines[1] != f"COMMIT: {sha}":
        return None
    if lines[0] == "VERDICT: APPROVE":
        return "APPROVE"
    if lines[0] == "VERDICT: COMMENT":
        return "COMMENT"
    if lines[0] == "VERDICT: REQUEST_CHANGES":
        return "REQUEST_CHANGES"
    return None


def parse_verdict(path, sha, *, legacy=False):
    """Only exact, current, top-level reviewer approvals can open a merge gate."""
    path = Path(path)
    if (
        not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", sha)
        or path.name not in {f"{reviewer}.md" for reviewer in REVIEWERS}
        or not legacy and not re.fullmatch(r"[\w.-]+%2F[\w.-]+-[1-9]\d*", path.parent.name)
        or not path.is_file()
    ):
        return False
    return _verdict(path.read_text(), sha) == "APPROVE"


def _save_text(path, text):
    """Round artifacts are create-only, including malformed reviewer output."""
    with path.open("x") as handle:
        handle.write(text)


def _prompt(repo, pr, sha, base, number, mode, previous, diff_scope=""):
    scope = (
        "Review the complete PR diff for this first round."
        if number == 1
        else "Review ONLY this saved delta and whether earlier blockers were fixed."
    )
    if mode == "conflict-only":
        scope = "Review ONLY merge-conflict resolutions in this saved delta."
    elif mode == "approved-delta":
        scope = ("WARM: continue your retained PR review session. Review ONLY this saved delta. "
                 "Verify these new commits are required CI/test fixes; report unrelated changes as scope findings.")
    return f"""You are an independent, read-only PR reviewer. Do not edit repository files or run long validators.
Your requested review artifact is the only allowed file write.
PR: {repo}#{pr}
Round: {number}, hard maximum 5
Target commit: {sha}
Mode: {mode}
Saved range: {base}..{sha}
{scope}
Use git diff {base} {sha} to inspect the range. Verify the target commit, not an uncommitted working tree.

Return plain text, without Markdown fences, beginning with EXACTLY these two lines:
VERDICT: APPROVE, VERDICT: COMMENT or VERDICT: REQUEST_CHANGES
COMMIT: {sha}
Choose one verdict on line 1. Then list blockers, improvements, evidence, and validation.
Apply the shared approval policy below. COMMENT records concrete asks and never authorizes merge.
Every blocker must name a realistic failure and its changed file and line.
Crafted input with no realistic source belongs in improvements unless it risks real funds or credentials.
Do not reopen settled issues or unchanged code from earlier rounds, except for loss of real funds,
credential exposure, or user-data loss. Check prior findings only to verify the named fixes.
At round 4 or 5, block only realistic failures in changed code and state whether scope creep
or a design problem prevents convergence. Suggest a concrete scope cut or redesign when blocking.
Check new duplication, portability, and migration feature loss. Deleted capabilities need a new
home or proof they are dead. Evidence must prove behavior; recipe captures need the HUD when supported.
New default tests must finish in 5 seconds each and the default suite in 5 minutes. No fixed waits
of 1 second or more and no background processes without teardown. Require measured test durations.

Earlier independent reviews, supplied only to verify fixes and preserve settled decisions:
{previous or 'None, this is the first round.'}

{diff_scope}
"""


class ReviewerFailure(RuntimeError):
    def __init__(self, message, metadata):
        super().__init__(message)
        self.metadata = metadata


def _reviewer_binding(fields, lane_id, session_id):
    return {"repo": fields["repo"], "pr": fields["pr"], "lane": lane_id, "session_id": session_id}


def _claim_session(config, reviewer, lane_id, session_id, fields, fresh, prior, *, retained_only=False):
    """A retained session belongs to one canonical PR, even after a config change."""
    path = Path(config["state_dir"]) / "review-sessions.json"
    with path.with_suffix(".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        bindings = json.loads(path.read_text()) if path.exists() else {}
        key = f"{reviewer}:{session_id}"
        current = _reviewer_binding(fields, lane_id, session_id)
        if retained_only and prior != current:
            raise RuntimeError("approved-delta requires the same retained reviewer session")
        owner = bindings.get(key)
        if owner and owner != current:
            raise RuntimeError("reviewer session is already bound to another canonical PR or lane")
        if owner or prior == current:
            continuity = "retained"
        elif fresh:
            continuity = "fresh-lane"
        elif config.get("reviews", {}).get("clean_sessions", {}).get(reviewer) == session_id:
            continuity = "declared-clean-session"
        else:
            raise RuntimeError("existing reviewer session needs an exact reviews.clean_sessions declaration")
        if prior and prior != current and continuity != "retained":
            continuity += "-fallback"
        bindings[key] = current
        write_json(path, bindings)
    return {**current, "transport": "lane", "continuity": continuity}


def _lane_observation(config, lane_id, reviewer):
    item = lanes.observe(config, lane_id)
    observation = item.get("observation", {})
    if item.get("status") == "missing" or item.get("state") != reviewer:
        raise RuntimeError("reviewer lane disappeared or is not the expected model")
    if observation.get("pending_question") or observation.get("question") or item.get("phase") in {"question", "pending-question"}:
        raise RuntimeError("reviewer lane has a pending question; inspect it before continuing")
    if observation.get("queued") or item.get("phase") == "queued":
        raise RuntimeError("reviewer lane has queued input; inspect it before continuing")
    if not observation.get("session_id"):
        raise RuntimeError("reviewer lane has no native session identity")
    return item, observation["session_id"]


def _lane_reviewer(config, reviewer, prompt_file, cwd, fields, prior):
    lane_id = config["reviews"]["lanes"][reviewer]
    metadata = {"transport": "lane", "lane": lane_id, "session_id": None, "continuity": "unverified"}
    deadline = time.monotonic() + config["reviews"].get("timeout", 1800)
    try:
        lane = lanes.lane_by_id(config, lane_id)
        if lane["runner"] != reviewer or Path(lane["cwd"]).resolve() != cwd:
            raise RuntimeError("reviewer lane must use the expected model and PR worktree")
        timeout = config["reviews"].get("timeout", 1800)
        config = {**config, "lanes": [
            {**entry, **{name: min(entry.get(name, timeout), timeout)
                         for name in ("launch_timeout", "send_timeout", "observe_timeout")}}
            if entry["id"] == lane_id else entry for entry in config["lanes"]
        ]}
        initial = lanes.observe(config, lane_id)
        fresh = False
        if initial.get("status") == "missing":
            if fields.get("mode") == "approved-delta":
                raise RuntimeError("approved-delta cannot replace a missing reviewer session")
            launched = lanes.launch(config, lane_id, restoring=bool(prior), submit_goal=False)
            fresh = launched.get("status") in {"launched", "restored"} and not launched.get("resume_id")
        item, session_id = _lane_observation(config, lane_id, reviewer)
        if item.get("phase") != "idle":
            raise RuntimeError("reviewer lane must be natively idle before review dispatch")
        metadata = _claim_session(config, reviewer, lane_id, session_id, fields, fresh, prior,
                                  retained_only=fields.get("mode") == "approved-delta")
        output = prompt_file.parent / f"{reviewer}.lane-output.md"
        if output.exists():
            raise RuntimeError("this round already has a reviewer lane artifact")
        message = (f'Read {json.dumps(str(prompt_file))}. Review only. Write your final plain text verdict '
                   f'to {json.dumps(str(output))}, then finish. Do not edit implementation files.')
        lanes.send(config, lane_id, message)
        while True:
            item, observed_session = _lane_observation(config, lane_id, reviewer)
            if observed_session != session_id:
                raise RuntimeError("reviewer native session changed during this round")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("reviewer lane did not finish with a verdict artifact")
            if output.is_file() and item.get("phase") == "idle":
                return output.read_text(), metadata
            time.sleep(min(0.1, remaining))
    except Exception as error:
        raise ReviewerFailure(str(error), metadata) from error


def _reviewer(config, reviewer, prompt, prompt_file, cwd, fields, prior):
    reviews = config.get("reviews", {})
    if reviewer in reviews.get("lanes", {}):
        return _lane_reviewer(config, reviewer, prompt_file, cwd, fields, prior)
    command = reviews.get(f"{reviewer}_command", DEFAULT_COMMANDS[reviewer])
    if not isinstance(command, list) or not command or not all(isinstance(arg, str) for arg in command):
        raise ValueError(f"reviews.{reviewer}_command must be a nonempty argv list")
    argv = [arg.format(**fields, prompt_file=str(prompt_file), cwd=str(cwd)) for arg in command]
    env = os.environ.copy()
    # The lead may itself be a Claude session; this subprocess is an independent reviewer.
    env.pop("CLAUDECODE", None)
    metadata = {"transport": "subprocess", "session_id": None, "continuity": "fresh-process-fallback"}
    try:
        output = run(argv, cwd=cwd, env=env, input=prompt, timeout=reviews.get("timeout", 1800)).stdout
        return output, metadata
    except Exception as error:
        raise ReviewerFailure(str(error), metadata) from error


def _previous(directory, rounds):
    documents = []
    for item in rounds:
        for reviewer in REVIEWERS:
            path = directory / f"r{item['number']}" / f"{reviewer}.md"
            if path.is_file():
                documents.append(f"Round {item['number']}, {reviewer}:\n{path.read_text()}")
    return "\n\n".join(documents)


def _require_retained_reviewers(config, state, cwd, fields):
    for reviewer in REVIEWERS:
        lane_id = config.get("reviews", {}).get("lanes", {}).get(reviewer)
        prior = state.get("reviewer_bindings", {}).get(reviewer)
        if not lane_id or not prior:
            raise RuntimeError("approved-delta requires saved retained reviewers in reviews.lanes")
        lane = lanes.lane_by_id(config, lane_id)
        if lane["runner"] != reviewer or Path(lane["cwd"]).resolve() != cwd:
            raise RuntimeError("approved-delta reviewer lane must keep its runner and PR worktree")
        item, session_id = _lane_observation(config, lane_id, reviewer)
        current = _reviewer_binding(fields, lane_id, session_id)
        if prior != current or item.get("phase") != "idle":
            raise RuntimeError("approved-delta requires the same idle retained reviewer session")


def _conflict_manifest(args, state, cwd, sha):
    declared = getattr(args, "conflict_files", None)
    declared_base = getattr(args, "conflict_base", None)
    if declared_base and not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", declared_base):
        raise ValueError("conflict baseline must be a full saved tree or commit SHA")
    saved = state.get("conflict_manifest", {})
    if saved.get("frozen_sha") == state["frozen_sha"]:
        files = saved["files"]
        baseline = saved.get("baseline", state["frozen_sha"])
        if declared_base and declared_base != baseline:
            raise RuntimeError("saved conflict baseline cannot change during conflict-only fixes")
        if declared and sorted(set(declared)) != files:
            raise RuntimeError("saved conflict-file manifest cannot widen during conflict-only fixes")
    else:
        if not declared:
            raise RuntimeError("conflict-only review requires --conflict-files to save its allowed scope")
        files = sorted(set(declared))
        baseline = declared_base or state["frozen_sha"]
        if any(Path(name).is_absolute() or ".." in Path(name).parts or str(Path(name)) != name for name in files):
            raise ValueError("conflict files must be normalized repository-relative paths")
    changed = run(["git", "diff", "--name-only", "-z", baseline, sha], cwd=cwd).stdout
    paths = set(changed.rstrip("\0").split("\0")) if changed else set()
    if paths - set(files):
        raise RuntimeError(f"conflict-only delta changes files outside saved manifest: {sorted(paths - set(files))}")
    if not paths:
        raise RuntimeError("conflict-only review requires a nonempty resolution delta")
    return {"frozen_sha": state["frozen_sha"], "head": sha, "files": files, "baseline": baseline}


def _stop_reason(directory, number):
    diagnosis = []
    for reviewer in REVIEWERS:
        path = directory / f"r{number}" / f"{reviewer}.md"
        if path.is_file():
            diagnosis.extend(path.read_text().splitlines()[2:])
    meaningful = [line.strip() for line in diagnosis if line.strip()]
    detail = " ".join(meaningful)[:600] or "independent reviewers did not return two valid approvals"
    return f"design problem | scope creep: {detail}; proposed cut or redesign: return the named blockers to the lead before changing scope"


def _report_status(report, repo, pr, state, directory):
    number = state["round"]
    identity = f"{repo}#{pr}"
    if state["status"] == "frozen":
        append_report(report, f"FROZEN {identity} {state['frozen_sha']}: both reviews approve; lead must check CI and merge gates")
    elif number >= 5:
        append_report(report, f"STOPPED {identity} r5: {_stop_reason(directory, number)}")
    elif number == 4:
        append_report(report, f"ESCALATE {identity} r4: {_stop_reason(directory, number)}")
    else:
        append_report(report, f"REVIEW {identity} r{number} {state['head']}: {state['status']}; artifacts {directory}")
    if state["status"] != "frozen" and number >= 4:
        target = Path(report)
        lines = target.read_text().splitlines()
        prefix = f"{'STOPPED' if number >= 5 else 'ESCALATE'} {identity} r{number}:"
        alarms = [line for line in lines if line.startswith(prefix)]
        target.write_text("\n".join(alarms + [line for line in lines if not line.startswith(prefix)]) + "\n")


def review(config, args):
    directory = review_dir(config, args.repo, args.pr)
    if not review_state_path(config, args.repo, args.pr).exists() and legacy_review_dir(config, args.repo, args.pr):
        raise RuntimeError("existing PR keeps its legacy verdict files; do not restart or migrate its review")
    directory.mkdir(parents=True, exist_ok=True)
    # A process crash releases this lock. Its reserved round remains consumed in state.json.
    with (directory / ".lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError("this PR already has a review running") from error
        return _locked_review(config, args, directory)


def _locked_review(config, args, directory):
    path = review_state_path(config, args.repo, args.pr)
    state = json.loads(path.read_text()) if path.exists() else {"repo": args.repo, "pr": args.pr, "round": 0, "rounds": [], "status": "active"}
    cwd = resolve_path(config, args.cwd)
    args.report = str(resolve_path(config, args.report))
    sha = run(["git", "rev-parse", "HEAD"], cwd=cwd).stdout.strip()
    if not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", sha):
        raise RuntimeError("git did not return a full commit SHA")
    conflict_only = args.conflict_only
    approved_delta = getattr(args, "approved_delta", False)
    if conflict_only and approved_delta:
        raise ValueError("--approved-delta cannot be combined with --conflict-only")
    if getattr(args, "conflict_files", None) and not conflict_only:
        raise ValueError("--conflict-files requires --conflict-only")
    if getattr(args, "conflict_base", None) and not conflict_only:
        raise ValueError("--conflict-base requires --conflict-only")
    if state.get("frozen_sha") and not conflict_only and not approved_delta:
        if state["status"] != "frozen" or sha != state["frozen_sha"]:
            raise RuntimeError("approved PR is frozen; use --approved-delta for CI/test fixes or --conflict-only for resolutions")
        _report_status(args.report, args.repo, args.pr, state, directory)
        return state
    if state["round"] >= 5:
        if state["status"] != "frozen":
            state["status"] = "stopped"
            write_json(path, state)
            _report_status(args.report, args.repo, args.pr, state, directory)
        raise RuntimeError("hard maximum 5 review rounds reached; no new review or push is allowed")
    if conflict_only and not state.get("frozen_sha"):
        raise RuntimeError("conflict-only review requires an existing frozen approval")
    if conflict_only and sha == state["frozen_sha"]:
        raise RuntimeError("conflict-only review requires a changed head")
    if approved_delta and (not state.get("frozen_sha") or not state["rounds"]):
        raise RuntimeError("approved-delta requires an existing frozen approval")
    if approved_delta and sha == state["rounds"][-1]["head"]:
        raise RuntimeError("approved-delta requires a changed head")
    if state["round"] >= 4 and state["status"] == "running":
        # A crash in round 4 must still alarm before round 5 is reserved.
        _report_status(args.report, args.repo, args.pr, state, directory)
    number = state["round"] + 1
    if conflict_only:
        previous = state["rounds"][-1]
        mode = "conflict-only"
        state["conflict_manifest"] = _conflict_manifest(args, state, cwd, sha)
        base = previous["head"] if previous["mode"] == "conflict-only" else state["conflict_manifest"]["baseline"]
    elif state["rounds"]:
        base = state["rounds"][-1]["head"]
        mode = "approved-delta" if approved_delta else "delta"
    else:
        base = run(["git", "merge-base", args.base, sha], cwd=cwd).stdout.strip()
        mode = "full"
    fields = {"repo": args.repo, "pr": str(args.pr), "head": sha, "base": base,
              "round": str(number), "mode": mode}
    if approved_delta:
        run(["git", "merge-base", "--is-ancestor", base, sha], cwd=cwd)
        if not run(["git", "diff", "--name-only", "-z", base, sha], cwd=cwd).stdout:
            raise RuntimeError("approved-delta requires changed review inputs")
        _require_retained_reviewers(config, state, cwd, fields)
    round_dir = directory / f"r{number}"
    round_dir.mkdir()
    scope_script = Path(__file__).resolve().parents[4] / "packages/agent-runtime/scripts/review-diff-scope.cjs"
    approval_policy = config.get("projects", {}).get(args.repo, {}).get("approvalPolicy", {})
    diff_scope = run(["node", str(scope_script), "packet", str(cwd), args.base, sha, json.dumps(approval_policy)], cwd=cwd).stdout
    prompt = _prompt(args.repo, args.pr, sha, base, number, mode, _previous(directory, state["rounds"]), diff_scope)
    prompt_file = round_dir / "prompt.md"
    _save_text(prompt_file, prompt)
    item = {"number": number, "head": sha, "base": base, "mode": mode, "started_at": time.time()}
    if conflict_only:
        item["conflict_manifest"] = state["conflict_manifest"]
    write_json(round_dir / "request.json", item)
    state.update(round=number, head=sha, status="running", report=str(args.report))
    state.pop("error", None)
    state["rounds"].append(item)
    # Reserve before subprocesses start: failures, timeouts and crashes cannot reset the cap.
    write_json(path, state)
    for reviewer in REVIEWERS:
        (directory / f"{reviewer}.md").unlink(missing_ok=True)
    outcomes = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        futures = {
            reviewer: pool.submit(_reviewer, config, reviewer, prompt, prompt_file, cwd, fields,
                                  state.get("reviewer_bindings", {}).get(reviewer))
            for reviewer in REVIEWERS
        }
        for reviewer, future in futures.items():
            try:
                output, metadata = future.result()
            except Exception as error:
                # Preserve a failed reviewer as a failed round, never synthesize its verdict.
                _save_text(round_dir / f"{reviewer}.error.txt", str(error))
                outcomes[reviewer] = {"verdict": None, "error": str(error), "session_id": None,
                                      "continuity": "unverified", **getattr(error, "metadata", {})}
            else:
                _save_text(round_dir / f"{reviewer}.md", output)
                (directory / f"{reviewer}.md").write_text(output)
                verdict = _verdict(output, sha)
                outcomes[reviewer] = {"verdict": verdict, **metadata}
    result = {"head": sha, "reviewers": outcomes, "finished_at": time.time()}
    unchanged = run(["git", "rev-parse", "HEAD"], cwd=cwd).stdout.strip() == sha
    approved = unchanged and all(outcomes[name]["verdict"] == "APPROVE" for name in REVIEWERS)
    if approved:
        state.update(status="frozen", frozen_sha=sha)
    elif number >= 5:
        state["status"] = "stopped"
    else:
        state["status"] = "needs_changes" if all(outcomes[name]["verdict"] for name in REVIEWERS) else "review_error"
    if not unchanged:
        state["status"] = "stopped" if number >= 5 else "review_error"
        result["error"] = "worktree HEAD changed during independent review"
        state["error"] = result["error"]
    _save_text(round_dir / "result.json", json.dumps(result, indent=2) + "\n")
    state["reviewers"] = outcomes
    for reviewer, outcome in outcomes.items():
        if outcome.get("session_id"):
            state.setdefault("reviewer_bindings", {})[reviewer] = {
                key: outcome[key] for key in ("repo", "pr", "lane", "session_id")
            }
    write_json(path, state)
    _report_status(args.report, args.repo, args.pr, state, directory)
    return state


def add_parser(subparsers):
    parser = subparsers.add_parser("review", help="run one durable independent review round")
    parser.add_argument("--repo", required=True)
    parser.add_argument("--pr", required=True, type=int)
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--base", default="origin/main")
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--conflict-only", action="store_true", help="review only conflict resolutions after freeze")
    modes.add_argument("--approved-delta", action="store_true", help="WARM review of CI/test fixes after approval, in retained sessions")
    parser.add_argument("--conflict-files", nargs="+", help="allowed repository-relative conflict paths, saved before review")
    parser.add_argument("--conflict-base", help="saved AUTO_MERGE tree SHA before resolving imported main changes")


def dispatch(config, args):
    return review(config, args)
