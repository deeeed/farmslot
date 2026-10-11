"""Detached lane sessions and durable file ownership."""

from contextlib import contextmanager
import fcntl
import hashlib
import json
from pathlib import Path
import time

from common import DRIVER_DIR, append_report, driver_env, run, tmux_argv, write_json


COMMANDS = {"lanes-status", "launch", "restore", "send", "flush", "reserve", "transfer"}


def lane_by_id(config, lane_id):
    for lane in config.get("lanes", []):
        if lane["id"] == lane_id:
            return lane
    raise ValueError(f"unknown lane: {lane_id}")


def registry_path(config):
    return Path(config["state_dir"]) / "lanes.json"


def _reservation(lane, value):
    path = Path(value).expanduser()
    return str((path if path.is_absolute() else Path(lane["cwd"]) / path).resolve())


def _overlap(left, right):
    left, right = Path(left), Path(right)
    return left == right or left in right.parents or right in left.parents


def _validate_ownership(registry):
    owned = []
    for owner, record in registry["lanes"].items():
        for path in record["reservations"]:
            for other_owner, other_path in owned:
                if owner != other_owner and _overlap(path, other_path):
                    raise ValueError(f"reservation conflict: {owner} owns {path}; "
                                     f"{other_owner} owns {other_path}")
            owned.append((owner, path))


@contextmanager
def _registry(config):
    path = registry_path(config)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.with_suffix(".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        registry = json.loads(path.read_text()) if path.exists() else {"version": 1, "lanes": {}}
        if registry.get("version") != 1 or not isinstance(registry.get("lanes"), dict):
            raise ValueError("invalid lane registry")
        for lane in config.get("lanes", []):
            registry["lanes"].setdefault(lane["id"], {
                "reservations": sorted({_reservation(lane, value)
                                        for value in lane.get("reservations", [])}),
            })
        _validate_ownership(registry)
        yield registry
        _validate_ownership(registry)
        write_json(path, registry)


def _record(config, lane_id):
    with _registry(config) as registry:
        return dict(registry["lanes"][lane_id])


def _update(config, lane_id, values):
    with _registry(config) as registry:
        registry["lanes"][lane_id].update(values)


def _session(lane):
    return lane.get("session", lane["id"])


def _panes(config, lane):
    result = run(tmux_argv(config, "list-panes", "-s", "-t", "=" + _session(lane),
                           "-F", "#{pane_id}"), check=False)
    # A missing session or a stopped server is normal during crash recovery.
    return result.stdout.splitlines() if result.returncode == 0 else []


def _pane(config, lane, record):
    panes = _panes(config, lane)
    if not panes:
        return None
    if record.get("pane_id") in panes:
        return record["pane_id"]
    if len(panes) == 1:
        return panes[0]
    raise ValueError(f"lane {lane['id']} has several panes and no matching registered pane")


def _env(config, lane, record):
    env = driver_env(config, lane)
    runtime = record.get("runtime_dir", str(Path(config["state_dir"]) / "lanes" /
                                           lane["id"] / "runtime"))
    env["TMUX_MODEL_DRIVER_RUNTIME_DIR"] = runtime
    env["TMUX_MODEL_DRIVER_OBSERVABILITY_DIR"] = record.get("observability_dir", str(Path(runtime) / ".observability"))
    env["TMUX_MODEL_DRIVER_STATE_DIR"] = str(Path(config["state_dir"]) / "transport")
    # Do not inherit a different pane's binding from the calling lead session.
    for name, value in (("SESSION_ID", record.get("session_id", lane.get("resume_id"))),
                        ("SESSION_PATH", record.get("session_path"))):
        key = "TMUX_MODEL_DRIVER_" + name
        if value:
            env[key] = value
        else:
            env.pop(key, None)
    env.pop("TMUX_MODEL_DRIVER_BINDINGS", None)
    return env


def _observe(config, lane, pane, record):
    result = run(["bash", str(DRIVER_DIR / "pane-state.sh"), pane, lane["runner"]],
                 cwd=str(DRIVER_DIR.parents[3]), env=_env(config, lane, record))
    observation = json.loads(result.stdout)
    observed = {key: observation[key] for key in ("session_id", "session_path")
                if observation.get(key)}
    accepted = observation.get("accepted") or {}
    goal = record.get("goal_payload")
    if goal and accepted.get("payload_hash") == hashlib.sha256(goal.encode()).hexdigest():
        observed["goal_submitted"] = True
    _update(config, lane["id"], {"pane_id": pane, **observed})
    return observation


def observe(config, lane_id):
    lane = lane_by_id(config, lane_id)
    record = _record(config, lane_id)
    item = {"id": lane_id, "runner": lane["runner"], "session": _session(lane),
            "goal": lane["goal"], "report": lane["report"],
            "reservations": record["reservations"]}
    pane = _pane(config, lane, record)
    if pane is None:
        item.update(status="missing", state="missing", phase="missing")
    else:
        observation = _observe(config, lane, pane, record)
        phase = observation.get("phase", "unknown")
        state = observation.get("state", "unknown")
        item.update(pane_id=pane, state=state, phase=phase,
                    status=phase if state == lane["runner"] else state,
                    observation=observation)
    return item


def status(config):
    return [observe(config, lane["id"]) for lane in config.get("lanes", [])]


def _send(config, lane, pane, record, payload, *, flushing=False):
    script = "flush-queued.sh" if flushing else "send-and-verify.sh"
    result = run(["bash", str(DRIVER_DIR / script), pane, lane["runner"],
                  str(Path(config["state_dir"]) / "transport.jsonl")],
                 cwd=str(DRIVER_DIR.parents[3]), env=_env(config, lane, record), input=payload,
                 timeout=lane.get("send_timeout", 30), check=False)
    if not result.stdout.strip():
        raise RuntimeError(f"lane {lane['id']} driver returned no result: {result.stderr.strip()}")
    delivery = json.loads(result.stdout)
    if result.returncode:
        raise RuntimeError(f"lane {lane['id']} delivery refused: {json.dumps(delivery)}")
    return delivery


def send(config, lane_id, payload):
    lane = lane_by_id(config, lane_id)
    record = _record(config, lane_id)
    pane = _pane(config, lane, record)
    if pane is None:
        raise ValueError(f"lane {lane_id} is missing; launch or restore it first")
    delivery = _send(config, lane, pane, record, payload)
    _observe(config, lane, pane, record)
    return {"lane": lane_id, "pane_id": pane, "delivery": delivery}


def flush(config, lane_id):
    lane = lane_by_id(config, lane_id)
    record = _record(config, lane_id)
    pane = _pane(config, lane, record)
    if pane is None:
        raise ValueError(f"lane {lane_id} is missing; launch or restore it first")
    delivery = _send(config, lane, pane, record, "", flushing=True)
    if record.get("goal_payload") and delivery.get("payload") == record["goal_payload"]:
        _update(config, lane_id, {"goal_submitted": True})
    observation = _observe(config, lane, pane, _record(config, lane_id))
    return {"lane": lane_id, "pane_id": pane, "delivery": delivery, "observation": observation}


def _goal_prompt(lane, reservations, prefix):
    instruction = (f'Read "{lane["goal"]}" and do it end to end. '
                   f'Keep "{lane["report"]}" current. '
                   "Continue from the report after a restart. ")
    if reservations:
        instruction += "Your file reservations are " + json.dumps(reservations) + ". "
    instruction += ("Write MERGE-READY <owner/repo>#<n> <sha> only after both top-level "
                    "reviews approve the exact head and all CI checks pass, then freeze it. "
                    "At review round 4 write ESCALATE <PR> r4; at round 5 write STOPPED <PR> r5 "
                    "with a design or scope diagnosis. Record extra work under FOLLOW-UPS.")
    return (prefix + " " if prefix else "") + instruction


def _runner_adapter(config, lane, record):
    runtime = record.get("runtime_dir", str(Path(config["state_dir"]) / "lanes" / lane["id"] / "runtime"))
    resume_id = record.get("session_id", lane.get("resume_id"))
    request = {**lane, "runtime_dir": runtime, "resume_id": resume_id}
    result = run(["node", "--import", "tsx", str(DRIVER_DIR / "runner-launch.mjs")],
                 cwd=str(DRIVER_DIR.parents[3]), input=json.dumps(request))
    return json.loads(result.stdout)


def _require_goal(lane, adapter):
    if not Path(lane["goal"]).is_file():
        raise ValueError(f"lane {lane['id']} needs an existing GOAL file")
    if not adapter.get("goal_supported"):
        raise ValueError(f"lane {lane['id']} does not support /goal; install its goal command "
                         "and configure goal_command before launch")


def _submit_goal(config, lane, pane, record, adapter=None):
    if adapter is None:
        adapter = record if "goal_prefix" in record else _runner_adapter(config, lane, record)
    _require_goal(lane, adapter)
    payload = _goal_prompt(lane, record["reservations"], adapter.get("goal_prefix", "/goal"))
    _update(config, lane["id"], {"goal_payload": payload})
    delivery = _send(config, lane, pane, record, payload)
    _update(config, lane["id"], {"goal_submitted": True})
    observation = _observe(config, lane, pane, _record(config, lane["id"]))
    return {"lane": lane["id"], "status": "launched", "pane_id": pane,
            "delivery": delivery, "observation": observation}


def launch(config, lane_id, *, restoring=False, submit_goal=True):
    lane_by_id(config, lane_id)
    path = Path(config["state_dir"]) / "launch" / f"{lane_id}.lock"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError(f"lane {lane_id} launch is already running") from error
        return _launch(config, lane_id, restoring=restoring, submit_goal=submit_goal)


def _launch(config, lane_id, *, restoring, submit_goal):
    lane = lane_by_id(config, lane_id)
    record = _record(config, lane_id)
    pane = _pane(config, lane, record)
    if pane is not None:
        observation = _observe(config, lane, pane, record)
        record = _record(config, lane_id)
        if (submit_goal and not record.get("goal_submitted") and
                observation.get("state") == lane["runner"] and observation.get("phase") == "idle"):
            return _submit_goal(config, lane, pane, _record(config, lane_id))
        return {"lane": lane_id, "status": "existing", "pane_id": pane, "observation": observation}
    if not Path(lane["cwd"]).is_dir():
        raise ValueError(f"lane {lane_id} needs an existing cwd")
    adapter = _runner_adapter(config, lane, record)
    if submit_goal:
        _require_goal(lane, adapter)
    resume_id = record.get("session_id", lane.get("resume_id"))
    pane = run(tmux_argv(config, "new-session", "-d", "-P", "-F", "#{pane_id}",
                         "-s", _session(lane), "-c", lane["cwd"], adapter["command"])).stdout.strip()
    if not pane.startswith("%") or not pane[1:].isdigit():
        raise RuntimeError(f"tmux did not return a pane id for lane {lane_id}")
    record.update(pane_id=pane, runtime_dir=adapter["runtime_dir"],
                  observability_dir=adapter["observability_dir"], session_id=resume_id,
                  goal_supported=adapter.get("goal_supported", False), goal_prefix=adapter.get("goal_prefix", "/goal"))
    _update(config, lane_id, record)
    if not Path(lane["report"]).exists():
        append_report(lane["report"], "# Lane report")
    deadline = time.monotonic() + lane.get("launch_timeout", 120)
    while True:
        observation = _observe(config, lane, pane, record)
        phase = observation.get("phase", "unknown")
        if observation.get("state") == lane["runner"]:
            if phase == "idle":
                break
            if phase in {"question", "queued", "pending-question", "launch-blocker"} or (phase == "busy" and not adapter.get("bootstrap_pending")):
                append_report(lane["report"], f"LAUNCH {lane_id}: {phase}; inspect before sending")
                return {"lane": lane_id, "status": phase, "pane_id": pane,
                        "observation": observation}
        if time.monotonic() >= deadline:
            raise TimeoutError(f"lane {lane_id} did not become ready; last state: {json.dumps(observation)}")
        time.sleep(0.05)
    if not submit_goal or restoring and resume_id and record.get("goal_submitted"):
        return {"lane": lane_id, "status": "restored" if restoring else "launched", "pane_id": pane,
                "resume_id": resume_id, "observation": observation}
    output = _submit_goal(config, lane, pane, _record(config, lane_id), adapter)
    return {**output, "status": "restored" if restoring else "launched", "resume_id": resume_id}


def reserve(config, lane_id, paths):
    lane = lane_by_id(config, lane_id)
    with _registry(config) as registry:
        record = registry["lanes"][lane_id]
        record["reservations"] = sorted(set(record["reservations"]) |
                                         {_reservation(lane, value) for value in paths})
        _validate_ownership(registry)
        return {"lane": lane_id, "reservations": record["reservations"]}


def transfer(config, source, destination, paths):
    lane = lane_by_id(config, source)
    lane_by_id(config, destination)
    if source == destination:
        raise ValueError("ownership transfer needs different lanes")
    paths = {_reservation(lane, value) for value in paths}
    with _registry(config) as registry:
        source_record = registry["lanes"][source]
        destination_record = registry["lanes"][destination]
        missing = paths - set(source_record["reservations"])
        if missing:
            raise ValueError(f"lane {source} does not own exact reservations: {sorted(missing)}")
        source_record["reservations"] = sorted(set(source_record["reservations"]) - paths)
        destination_record["reservations"] = sorted(set(destination_record["reservations"]) | paths)
        _validate_ownership(registry)
        return {"source": source, "destination": destination, "paths": sorted(paths)}


def add_parser(subparsers):
    subparsers.add_parser("lanes-status", help="show each lane's native state and ownership")
    for command in ("launch", "send", "flush", "reserve"):
        parser = subparsers.add_parser(command)
        parser.add_argument("lane")
        if command == "send":
            parser.add_argument("--file", required=True)
        elif command == "reserve":
            parser.add_argument("paths", nargs="+")
    subparsers.add_parser("restore", help="restore missing sessions without touching existing panes")
    parser = subparsers.add_parser("transfer")
    parser.add_argument("source")
    parser.add_argument("destination")
    parser.add_argument("paths", nargs="+")


def dispatch(config, args):
    if args.command == "lanes-status":
        return status(config)
    if args.command == "launch":
        return launch(config, args.lane)
    if args.command == "restore":
        return [launch(config, lane["id"], restoring=True) for lane in config.get("lanes", [])]
    if args.command == "send":
        return send(config, args.lane, Path(args.file).read_text())
    if args.command == "flush":
        return flush(config, args.lane)
    if args.command == "reserve":
        return reserve(config, args.lane, args.paths)
    if args.command == "transfer":
        return transfer(config, args.source, args.destination, args.paths)
    raise ValueError(f"unknown lanes command: {args.command}")
