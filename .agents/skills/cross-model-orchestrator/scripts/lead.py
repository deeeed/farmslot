"""Lead heartbeat, exact-head merge gate, and run attention."""

from datetime import datetime, timezone
from pathlib import Path
import json
import re
import time

from common import append_report, gh, project_hook, read_json, resolve_path, write_json
from review import parse_verdict, review_dir, review_state_path

READY = re.compile(r"^MERGE-READY ([\w.-]+/[\w.-]+)#(\d+) ([0-9a-f]{40})$", re.M)
PRIVATE = re.compile(r"~/|(?:/Users|/home)/[^/\s]+/")


def portability(diff, patterns=()):
    forbidden = [PRIVATE, *(re.compile(pattern) for pattern in patterns)]
    for line in diff.splitlines():
        if line.startswith("+") and not line.startswith("+++"):
            if any(pattern.search(line[1:]) for pattern in forbidden):
                return False
    return True


def check_ci(checks, required=()):
    if not checks:
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
    if not successes:
        return "no successful CI check present"
    if set(required) - successes:
        return "required CI checks missing or not successful"
    return None


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
    pr = json.loads(gh(["pr", "view", str(number), "-R", repo, "--json",
                       "state,headRefOid,isDraft,mergeable,statusCheckRollup"]).stdout)
    result = {"repo": repo, "pr": number, "head": pr["headRefOid"], "state": pr["state"], "ready": False}
    if pr["state"] != "OPEN" or pr["isDraft"] or pr["headRefOid"] != sha:
        return {**result, "reason": "PR not open, draft, or head changed"}
    directory = review_dir(config, repo, number)
    if not all(parse_verdict(directory / f"{reviewer}.md", sha) for reviewer in ("codex", "claude")):
        return {**result, "reason": "both latest verdicts must approve exact head"}
    issue = check_ci(pr["statusCheckRollup"], project.get("required_checks", []))
    if issue:
        return {**result, "reason": issue}
    if pr["mergeable"] != "MERGEABLE":
        return {**result, "reason": "mergeability not confirmed"}
    if unresolved_threads(repo, number):
        return {**result, "reason": "unresolved review threads"}
    diff = gh(["pr", "diff", str(number), "-R", repo]).stdout
    if not portability(diff, project.get("forbidden_patterns", [])):
        return {**result, "reason": "portability grep failed"}
    return {**result, "ready": True, "reason": "head, verdicts, CI, threads and portability pass"}


def candidates(config):
    seen = set()
    for lane in config["lanes"]:
        path = Path(lane["report"])
        text = path.read_text() if path.exists() else ""
        for repo, number, sha in READY.findall(text):
            key = (repo, int(number), sha)
            if key not in seen:
                seen.add(key)
                yield lane, key


def merge_watch(config, execute=False):
    results = []
    for lane, (repo, number, sha) in candidates(config):
        result = gate(config, repo, number, sha)
        if result["ready"]:
            if not execute:
                result["action"] = "WOULD-MERGE"
            elif config["projects"][repo].get("auto_merge") is not True:
                result["action"] = "LEAD-MERGE-REQUIRED"
            else:
                gh(["pr", "merge", str(number), "-R", repo, "--squash",
                    *(["--admin"] if config["projects"][repo].get("merge_admin") is True else []),
                    "--match-head-commit", sha], write=True)
                result["action"] = "MERGED"
                append_report(lane["report"], f"MERGED {repo}#{number} {sha}")
        results.append(result)
    return results


def ready(config, repo, number, sha, report):
    result = gate(config, repo, number, sha)
    if result["ready"]:
        append_report(report, f"MERGE-READY {repo}#{number} {sha}")
        state_path = review_state_path(config, repo, number)
        state = read_json(state_path, {})
        state.update({"status": "frozen", "frozen_sha": sha})
        write_json(state_path, state)
    return result


def run_attention(config, repo):
    data = json.loads(project_hook(config, repo, "runs"))
    runs = data.get("runs", data) if isinstance(data, dict) else data
    state_path = Path(config["state_dir"]) / "attention.json"
    seen = read_json(state_path, {})
    current, alerts = {}, []
    now = datetime.now(timezone.utc)
    stale = config["projects"][repo].get("run_stale_minutes", 20)
    for run in runs:
        status = run.get("status")
        changed = run.get("statusChangedAt")
        age = (now - datetime.fromisoformat(changed.replace("Z", "+00:00"))).total_seconds() / 60 if changed else None
        active = status in ("slot-finding", "preparing", "dispatching", "completing", "self-reviewing")
        bad = status in ("failed", "blocked") or (active and (age is None or age > stale))
        key = f"{repo}:{run['id']}"
        token = f"{status}:{changed}"
        if bad:
            current[key] = token
            if seen.get(key) != token:
                alerts.append({"id": run["id"], "status": status, "age_minutes": age,
                               "reason": "failed/blocked or stale active run"})
    # Retain other projects while clearing recovered runs in this one.
    write_json(state_path, {**{k: v for k, v in seen.items() if not k.startswith(repo + ":")}, **current})
    return alerts


def heartbeat(config):
    from lanes import status
    result = {"lanes": status(config), "projects": {}, "reviews": []}
    for repo, project in config["projects"].items():
        info = {}
        for hook in ("heartbeat", "nodes"):
            if hook in project.get("hooks", {}):
                info[hook] = project_hook(config, repo, hook)
        if "nodes" in info:
            nodes = json.loads(info["nodes"])
            actual = nodes.get("nodes", nodes) if isinstance(nodes, dict) else nodes
            names = {node["machine"] if isinstance(node, dict) else node for node in actual}
            info["missing_nodes"] = sorted(set(project.get("expected_nodes", [])) - names)
            version = nodes.get("gatewayProtocolVersion") if isinstance(nodes, dict) else None
            if version:
                info["version_mismatches"] = [node["machine"] for node in actual if node.get("protocolVersion") != version]
        result["projects"][repo] = info
    for path in (Path(config["state_dir"]) / "reviews").glob("*/state.json"):
        state = read_json(path)
        repo, number = state["repo"], state["pr"]
        alarm = "review round >=4" if state.get("round", 0) >= 4 and state.get("status") != "frozen" else None
        sha = state.get("frozen_sha", state.get("head"))
        entry = {"repo": repo, "pr": number, "round": state.get("round"), "alarm": alarm}
        if sha:
            entry["gate"] = gate(config, repo, number, sha)
            if state.get("frozen_sha") and entry["gate"].get("state") == "OPEN":
                entry["alarm"] = "approved but unmerged"
        result["reviews"].append(entry)
    return result


def add_parser(subparsers):
    subparsers.add_parser("heartbeat")
    watch = subparsers.add_parser("merge-watch")
    watch.add_argument("--execute", action="store_true")
    watch.add_argument("--watch", action="store_true")
    watch.add_argument("--interval", type=float, default=60)
    attention = subparsers.add_parser("attention")
    attention.add_argument("repo")
    ready_parser = subparsers.add_parser("ready")
    for field in ("repo", "pr", "sha", "report"):
        ready_parser.add_argument(field, type=int if field == "pr" else str)
    hook = subparsers.add_parser("hook")
    hook.add_argument("repo")
    hook.add_argument("name")


def dispatch(config, args):
    if args.command == "heartbeat":
        return heartbeat(config)
    if args.command == "attention":
        return run_attention(config, args.repo)
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
