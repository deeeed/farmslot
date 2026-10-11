"""Lead heartbeat, exact-head merge gate, and run attention."""

from datetime import datetime, timezone
from pathlib import Path
import glob
import json
import re
import time

from common import append_report, gh, locked_state, project_hook, read_json, resolve_path, write_json
from review import parse_verdict, verdict_dir, review_state_path

READY = re.compile(r"\bMERGE-READY ([\w.-]+/[\w.-]+)#(\d+) ([0-9a-f]{40})(?![0-9a-f])")
PR_REF = re.compile(r"\b([\w.-]+/[\w.-]+)(?:#|/pull/)([1-9]\d*)\b")
ROUND = re.compile(r"\b(?:REVIEW|ESCALATE|STOPPED) ([\w.-]+/[\w.-]+)#([1-9]\d*) r([1-5])\b")
PRIVATE = re.compile(r"~/[\w.-]+/|(?:/Users|/home)/[\w.-]+/")


def portability(diff, patterns=(), exclusions=()):
    forbidden = [PRIVATE, *(re.compile(pattern) for pattern in patterns)]
    excluded = [re.compile(pattern) for pattern in exclusions]
    filename = ""
    for line in diff.splitlines():
        if line.startswith("+++ b/"):
            filename = line[6:]
        if line.startswith("+") and not line.startswith("+++"):
            if any(pattern.search(filename) or pattern.search(line[1:]) for pattern in excluded):
                continue
            if any(pattern.search(line[1:]) for pattern in forbidden):
                return False
    return True


def check_ci(checks, required=(), *, allow_no_ci=False, required_workflows=(), workflows=()):
    checks = [check for check in checks if check.get("name", check.get("context")) != "Vercel"]
    if not checks and not allow_no_ci:
        return "no CI checks present"
    successes = set()
    for check in checks:
        name = check.get("name", check.get("context"))
        if check.get("__typename") == "StatusContext" or "context" in check:
            if check.get("state") != "SUCCESS":
                return f"CI {check.get('context')} is {check.get('state')}"
            successes.add(name)
        else:
            if check.get("status") != "COMPLETED" or check.get("conclusion") not in ("SUCCESS", "SKIPPED", "NEUTRAL"):
                return f"CI {check.get('name')} is unfinished or not green"
            if check.get("conclusion") == "SUCCESS":
                successes.add(name)
    if set(required) - successes:
        return "required CI checks missing or not successful"
    latest = {}
    for workflow in workflows:
        name = workflow["name"]
        if name not in latest or (workflow.get("created_at", ""), workflow["id"]) > (latest[name].get("created_at", ""), latest[name]["id"]):
            latest[name] = workflow
    for name in required_workflows:
        workflow = latest.get(name)
        if not workflow or workflow.get("status") != "completed" or workflow.get("conclusion") != "success":
            return f"required CI workflow {name} missing or not successful"
    return None


def ci_issue(config, repo, pr):
    project = config["projects"][repo]
    policy = config.get("ci", {})
    skipped = list(policy.get("workflow_skip_repos", []))
    if policy.get("workflow_skip_file"):
        skipped.extend(resolve_path(config, policy["workflow_skip_file"]).read_text().splitlines())
    required = [] if repo in skipped else project.get("required_workflows", [])
    workflows = []
    if required:
        data = json.loads(gh(["api", f"repos/{repo}/actions/runs?head_sha={pr['headRefOid']}&per_page=100",
                              "--paginate", "--slurp"]).stdout)
        workflows = [workflow for page in data for workflow in page["workflow_runs"]]
    return check_ci(pr["statusCheckRollup"], project.get("required_checks", []),
                    allow_no_ci=repo in policy.get("no_ci_repos", []),
                    required_workflows=required, workflows=workflows)


def pr_view(repo, number):
    return json.loads(gh(["pr", "view", str(number), "-R", repo, "--json",
                         "state,headRefOid,isDraft,mergeable,statusCheckRollup"]).stdout)


def approvals(config, repo, number, sha):
    directory, legacy = verdict_dir(config, repo, number)
    return {name: parse_verdict(directory / f"{name}.md", sha, legacy=legacy)
            for name in ("codex", "claude")}


def unresolved_threads(repo, number):
    owner, name = repo.split("/")
    cursor = None
    while True:
        query = """query($owner:String!,$name:String!,$number:Int!,$cursor:String){
          repository(owner:$owner,name:$name){pullRequest(number:$number){
            reviewThreads(first:100,after:$cursor){nodes{isResolved}
              pageInfo{hasNextPage endCursor}}}}}"""
        args = ["api", "graphql", "-f", f"query={query}", "-f", f"owner={owner}",
                "-f", f"name={name}", "-F", f"number={number}"]
        if cursor:
            args.extend(["-f", f"cursor={cursor}"])
        body = json.loads(gh(args).stdout)
        if body.get("errors"):
            raise RuntimeError("GitHub review thread query failed")
        threads = body["data"]["repository"]["pullRequest"]["reviewThreads"]
        if any(not thread["isResolved"] for thread in threads["nodes"]):
            return True
        if not threads["pageInfo"]["hasNextPage"]:
            return False
        cursor = threads["pageInfo"]["endCursor"]


def gate(config, repo, number, sha):
    project = config["projects"].get(repo)
    if project is None:
        return {"ready": False, "reason": "project absent from config"}
    pr = pr_view(repo, number)
    result = {"repo": repo, "pr": number, "head": pr["headRefOid"], "state": pr["state"],
              "draft": pr["isDraft"], "ready": False}
    if pr["state"] != "OPEN" or pr["headRefOid"] != sha:
        return {**result, "reason": "PR not open or head changed"}
    if pr["mergeable"] == "CONFLICTING":
        return {**result, "reason": "merge conflict", "conflict": True}
    if not all(approvals(config, repo, number, sha).values()):
        return {**result, "reason": "both latest verdicts must approve exact head"}
    issue = ci_issue(config, repo, pr)
    if issue:
        return {**result, "reason": issue}
    if pr["mergeable"] != "MERGEABLE":
        return {**result, "reason": "mergeability not confirmed"}
    if unresolved_threads(repo, number):
        return {**result, "reason": "unresolved review threads"}
    diff = gh(["pr", "diff", str(number), "-R", repo]).stdout
    if not portability(diff, project.get("forbidden_patterns", []), project.get("portability_exclusions", [])):
        return {**result, "reason": "portability grep failed"}
    return {**result, "ready": True, "reason": "head, verdicts, CI, threads and portability pass"}


def reports(config):
    paths = [lane["report"] for lane in config["lanes"]]
    paths.extend(str(resolve_path(config, value)) for value in config.get("reports", []))
    for name in dict.fromkeys(path for value in paths for path in glob.glob(value)):
        yield Path(name)


def candidates(config):
    seen = set()
    for path in reports(config):
        text = path.read_text()
        for repo, number, sha in READY.findall(text):
            key = (repo, int(number), sha)
            if key not in seen:
                seen.add(key)
                yield {"report": str(path)}, key


def merge_watch(config, execute=False):
    with locked_state(config, "merge-watch", {"seen": [], "conflicts": []}) as state:
        return _merge_pass(config, state, execute)


def _merge_pass(config, state, execute):
    results = []
    for lane, (repo, number, sha) in candidates(config):
        key = f"{repo}#{number} {sha}"
        if key in state["seen"]:
            continue
        try:
            result = gate(config, repo, number, sha)
        except (RuntimeError, OSError, ValueError) as error:
            results.append({"repo": repo, "pr": number, "ready": False, "error": str(error)})
            continue
        if result.get("state") in ("MERGED", "CLOSED"):
            state["seen"].append(key)
        if result.get("conflict"):
            if key in state["conflicts"]:
                continue
            state["conflicts"].append(key)
            result["action"] = "CONFLICT"
        if result["ready"]:
            if not execute:
                result["action"] = "WOULD-MERGE"
            elif config["projects"][repo].get("auto_merge") is not True:
                result["action"] = "LEAD-MERGE-REQUIRED"
            else:
                if result["draft"]:
                    gh(["pr", "ready", str(number), "-R", repo], write=True)
                    result = gate(config, repo, number, sha)
                    if not result["ready"] or result["draft"]:
                        results.append(result)
                        continue
                gh(["pr", "merge", str(number), "-R", repo, "--squash",
                    *(["--admin"] if config["projects"][repo].get("merge_admin") is True else []),
                    "--match-head-commit", sha], write=True)
                result["action"] = "MERGED"
                state["seen"].append(key)
                append_report(lane["report"], f"MERGED {repo}#{number} {sha}")
        results.append(result)
        if result.get("action") == "MERGED":
            break
    return results


def ready(config, repo, number, sha, report):
    result = gate(config, repo, number, sha)
    if result["ready"]:
        append_report(report, f"MERGE-READY {repo}#{number} {sha}")
        state_path = review_state_path(config, repo, number)
        if state_path.exists():
            state = read_json(state_path)
            state.update({"status": "frozen", "frozen_sha": sha})
            write_json(state_path, state)
    return result


def run_attention(config, repo):
    data = json.loads(project_hook(config, repo, "runs"))
    runs = data.get("runs", data) if isinstance(data, dict) else data
    with locked_state(config, "attention", {"seen": []}) as state:
        return _attention(config, repo, runs, state)


def _attention(config, repo, runs, state):
    alerts = []
    # A read-only seed keeps pre-cutover acknowledgements without rewriting the legacy file.
    seed = config["projects"][repo].get("attention_seen_file")
    seen = set(resolve_path(config, seed).read_text().splitlines()) if seed else set()
    seen.update(state["seen"])
    state["seen"] = sorted(seen)
    now = datetime.now(timezone.utc)
    stale = config["projects"][repo].get("run_stale_minutes", 20)
    for run in runs:
        status = run.get("status")
        changed = run.get("statusChangedAt")
        age = (now - datetime.fromisoformat(changed.replace("Z", "+00:00"))).total_seconds() / 60 if changed else 0
        active = status in ("slot-finding", "preparing", "dispatching", "completing", "self-reviewing")
        bad = status in ("failed", "blocked") or (active and age > stale)
        key = f"{run['id']}|{status}"
        if bad and key not in seen:
            seen.add(key)
            state["seen"].append(key)
            alerts.append({"id": run["id"], "status": status, "age_minutes": age,
                           "ticket": run.get("ticketOrPr"), "slot": run.get("slotId"),
                           "error": run.get("error"), "reason": "failed/blocked or stale active run"})
    return alerts


def heartbeat(config, read_only=False):
    from lanes import status
    result = {"lanes": status(config), "projects": {}, "reviews": []}
    for repo, project in config["projects"].items():
        info = {}
        hooks = dict.fromkeys(["heartbeat", "nodes", *project.get("heartbeat_hooks", [])])
        for hook in hooks:
            if hook not in project.get("hooks", {}):
                continue
            if read_only and hook in project.get("mutating_heartbeat_hooks", []):
                info[hook] = {"skipped": "mutating hook in read-only heartbeat"}
                continue
            try:
                info[hook] = project_hook(config, repo, hook)
            except (RuntimeError, OSError, ValueError) as error:
                info[hook] = {"error": str(error)}
        if isinstance(info.get("nodes"), str):
            nodes = json.loads(info["nodes"])
            actual = nodes.get("nodes", nodes) if isinstance(nodes, dict) else nodes
            names = {node["machine"] if isinstance(node, dict) else node for node in actual}
            info["missing_nodes"] = sorted(set(project.get("expected_nodes", [])) - names)
            version = nodes.get("gatewayProtocolVersion") if isinstance(nodes, dict) else None
            if version:
                info["version_mismatches"] = [node["machine"] for node in actual if node.get("protocolVersion") != version]
        result["projects"][repo] = info
    states = {}
    for path in (Path(config["state_dir"]) / "reviews").glob("*/state.json"):
        state = read_json(path)
        states[state["repo"], state["pr"]] = state
    discovered, reported_rounds = set(), {}
    for path in reports(config):
        text = path.read_text()
        discovered.update((repo, int(number)) for repo, number in PR_REF.findall(text)
                          if repo in config["projects"])
        for repo, number, value in ROUND.findall(text):
            key = (repo, int(number))
            reported_rounds[key] = max(reported_rounds.get(key, 0), int(value))
    for repo, number in sorted(discovered | states.keys()):
        state = states.get((repo, number), {})
        number_round = state.get("round", reported_rounds.get((repo, number)))
        alarm = "review round >=4" if (number_round or 0) >= 4 and state.get("status") != "frozen" else None
        entry = {"repo": repo, "pr": number, "round": number_round, "alarm": alarm}
        try:
            pr = pr_view(repo, number)
            entry.update(head=pr["headRefOid"], state=pr["state"], draft=pr["isDraft"],
                         verdicts=approvals(config, repo, number, pr["headRefOid"]),
                         ci=ci_issue(config, repo, pr))
            if all(entry["verdicts"].values()) and pr["state"] == "OPEN":
                entry["alarm"] = "approved but unmerged"
            elif pr["state"] != "OPEN":
                entry["alarm"] = None
        except (RuntimeError, OSError, ValueError) as error:
            entry["error"] = str(error)
        result["reviews"].append(entry)
    return result


def add_parser(subparsers):
    subparsers.add_parser("heartbeat").add_argument("--read-only", action="store_true")
    watch = subparsers.add_parser("merge-watch")
    watch.add_argument("--execute", action="store_true")
    watch.add_argument("--watch", action="store_true")
    watch.add_argument("--interval", type=float, default=60)
    attention = subparsers.add_parser("attention")
    attention.add_argument("repo")
    attention.add_argument("--watch", action="store_true")
    attention.add_argument("--interval", type=float, default=120)
    ready_parser = subparsers.add_parser("ready")
    for field in ("repo", "pr", "sha", "report"):
        ready_parser.add_argument(field, type=int if field == "pr" else str)
    hook = subparsers.add_parser("hook")
    hook.add_argument("repo")
    hook.add_argument("name")


def dispatch(config, args):
    if args.command == "heartbeat":
        return heartbeat(config, args.read_only)
    if args.command == "attention":
        if not 0 < args.interval <= 120:
            raise ValueError("attention interval must be between 0 and 120 seconds")
        while True:
            alerts = run_attention(config, args.repo)
            if not args.watch or alerts:
                return alerts
            time.sleep(args.interval)
    if args.command == "ready":
        return ready(config, args.repo, args.pr, args.sha, str(resolve_path(config, args.report)))
    if args.command == "hook":
        return {"output": project_hook(config, args.repo, args.name)}
    if args.command == "merge-watch":
        if not 0 < args.interval <= 60:
            raise ValueError("merge-watch interval must be between 0 and 60 seconds")
        while True:
            results = merge_watch(config, args.execute)
            if not args.watch or any(r.get("action") == "MERGED" for r in results):
                return results
            print(json.dumps(results), flush=True)
            time.sleep(args.interval)
    raise ValueError("unknown lead command")
