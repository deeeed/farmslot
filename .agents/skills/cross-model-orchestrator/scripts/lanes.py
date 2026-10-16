"""Detached lane sessions and durable file ownership."""

from contextlib import contextmanager
import fcntl
import hashlib
import json
import subprocess
from pathlib import Path
import time

from common import DRIVER_DIR, append_report, driver_env, read_json, resolve_path, run, tmux_argv, write_json


COMMANDS = {"lanes-status", "launch", "restore", "send", "flush", "reserve", "transfer"}
ACK_BUSY_SECONDS = 5


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
    preferred = record.get("pane_id", lane.get("pane_id"))
    if preferred in panes:
        return preferred
    if len(panes) == 1:
        return panes[0]
    raise ValueError(f"lane {lane['id']} has several panes and no matching registered pane")


def _env(config, lane, record):
    env = driver_env(config, lane)
    env.pop("TMUX_MODEL_DRIVER_READ_ONLY", None)
    runtime = record.get("runtime_dir", lane.get("runtime_dir",
        str(Path(config["state_dir"]) / "lanes" / lane["id"] / "runtime")))
    env["TMUX_MODEL_DRIVER_RUNTIME_DIR"] = runtime
    env["TMUX_MODEL_DRIVER_OBSERVABILITY_DIR"] = str(resolve_path(config,
        record.get("observability_dir", lane.get("observability_dir", str(Path(runtime) / ".observability")))))
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


def _pulled_back(config, lane, accepted):
    with _registry(config) as registry:
        record = registry["lanes"][lane["id"]]
        # A delivery recorded meanwhile, including a retry re-proven under the same receipt,
        # keeps its own outcome.
        if record.get("last_delivery") == accepted:
            record["last_delivery"] = {**accepted, "pulled_back": True}


def _acknowledge(config, lane, pane, accepted):
    if not accepted.get("receipt_id"):
        return None
    # A concurrent send or inspection holds the driver lock only briefly. An unacknowledged
    # receipt would hand its retained evidence to a later identical payload, so wait it out.
    deadline = time.monotonic() + ACK_BUSY_SECONDS
    while True:
        result = run(["bash", str(DRIVER_DIR / "ack-acceptance.sh"), pane, lane["runner"],
                      accepted["receipt_id"]], cwd=str(DRIVER_DIR.parents[3]),
                     env=_env(config, lane, _record(config, lane["id"])), check=False)
        acknowledgement = json.loads(result.stdout)
        verification = acknowledgement.get("verification")
        if verification != "driver_busy" or time.monotonic() >= deadline:
            break
        time.sleep(0.25)
    if verification == "receipt_unverified":
        # The runner no longer proves the recorded delivery: its input was pulled back unsent.
        _pulled_back(config, lane, accepted)
    elif not acknowledgement.get("acknowledged") and verification not in {
            "driver_busy", "no_accepted_receipt"}:
        raise RuntimeError(f"lane {lane['id']} acceptance acknowledgement failed: {acknowledgement}")
    return verification


def _observe(config, lane, pane, record, *, persist=True):
    env = _env(config, lane, record)
    env.pop("TMUX_MODEL_DRIVER_READ_ONLY", None)
    if not persist:
        env["TMUX_MODEL_DRIVER_READ_ONLY"] = "1"
    result = run(["bash", str(DRIVER_DIR / "pane-state.sh"), pane, lane["runner"]],
                 cwd=str(DRIVER_DIR.parents[3]), env=env)
    observation = json.loads(result.stdout)
    if not persist:
        return observation
    observed = {key: observation[key] for key in ("session_id", "session_path")
                if observation.get(key)}
    accepted = observation.get("accepted") or {}
    goal = record.get("goal_payload")
    if goal and accepted.get("payload_hash") == hashlib.sha256(goal.encode()).hexdigest():
        observed["goal_submitted"] = True
    if accepted:
        observed["last_delivery"] = accepted
    _update(config, lane["id"], {"pane_id": pane, **observed})
    _acknowledge(config, lane, pane, accepted)
    return observation


def observe(config, lane_id, *, read_only=False):
    lane = lane_by_id(config, lane_id)
    record = (read_json(registry_path(config), {"lanes": {}})["lanes"].get(lane_id,
              {"reservations": sorted({_reservation(lane, value) for value in lane.get("reservations", [])})})
              if read_only else _record(config, lane_id))
    item = {"id": lane_id, "runner": lane["runner"], "session": _session(lane),
            "goal": lane["goal"], "report": lane["report"],
            "session_id": record.get("session_id") or lane.get("resume_id"),
            "reservations": record["reservations"]}
    pane = _pane(config, lane, record)
    if pane is None:
        item.update(status="missing", state="missing", phase="missing")
    else:
        observation = (_observe(config, lane, pane, record, persist=False) if read_only
                       else _observe(config, lane, pane, record))
        phase = observation.get("phase", "unknown")
        state = observation.get("state", "unknown")
        item.update(pane_id=pane, state=state, phase=phase,
                    session_id=observation.get("session_id") or item["session_id"],
                    status=phase if state == lane["runner"] else state,
                    observation=observation)
    return item


def status(config):
    registry = read_json(registry_path(config), {"version": 1, "lanes": {}})
    for lane in config.get("lanes", []):
        registry["lanes"].setdefault(lane["id"], {"reservations": sorted(
            {_reservation(lane, value) for value in lane.get("reservations", [])})})
    _validate_ownership(registry)
    observations = []
    for lane in config.get("lanes", []):
        try:
            observations.append(observe(config, lane["id"], read_only=True))
        except (RuntimeError, OSError, ValueError, subprocess.TimeoutExpired) as error:
            observations.append({"id": lane["id"], "state": "unknown", "phase": "unknown",
                                 "status": "unknown", "error": str(error)})
    return observations


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
    output = {"lane": lane_id, "pane_id": pane, "delivery": delivery}
    if delivery.get("submitted") and delivery.get("evidence"):
        # Observation can find an older alias receipt. Persist and acknowledge this handoff too.
        _update(config, lane_id, {"last_delivery": delivery["evidence"]})
        if _acknowledge(config, lane, pane, delivery["evidence"]) == "receipt_unverified":
            output["pulled_back"] = True
    return output


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
    resume_id = lane.get("resume_id") or record.get("session_id")
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


def _pane_owner(observation):
    fields = ("pane_id", "pane_pid", "pane_started_at", "socket_path")
    return ({key: observation[key] for key in fields}
            if all(observation.get(key) for key in fields) else None)


def _launch(config, lane_id, *, restoring, submit_goal):
    lane = lane_by_id(config, lane_id)
    record = _record(config, lane_id)
    pane = _pane(config, lane, record)
    created = pane is None
    if pane is not None:
        observation = _observe(config, lane, pane, record)
        record = _record(config, lane_id)
        if observation.get("state") != "shell":
            if (submit_goal and not record.get("goal_submitted") and
                    observation.get("state") == lane["runner"] and observation.get("phase") == "idle"):
                return _submit_goal(config, lane, pane, _record(config, lane_id))
            return {"lane": lane_id, "status": "existing", "pane_id": pane, "observation": observation}
        owned = _pane_owner(observation)
        if not (lane.get("resume_id") or record.get("session_id") or
                owned and record.get("launch_pane_owner") == owned):
            raise ValueError(f"lane {lane_id} has a shell but no recorded session; configure resume_id")
    if not Path(lane["cwd"]).is_dir():
        raise ValueError(f"lane {lane_id} needs an existing cwd")
    adapter = _runner_adapter(config, lane, record)
    if submit_goal:
        _require_goal(lane, adapter)
    resume_id = lane.get("resume_id") or record.get("session_id")
    if pane is None:
        pane = run(tmux_argv(config, "new-session", "-d", "-P", "-F", "#{pane_id}",
                             "-s", _session(lane), "-c", lane["cwd"], adapter["command"])).stdout.strip()
    else:
        # The shell transport rechecks ownership and proves staged-script execution.
        staged = run(["bash", str(DRIVER_DIR / "send-shell-script.sh"), pane, lane["cwd"],
                      str(Path(config["state_dir"]) / "transport.jsonl")],
                     cwd=str(DRIVER_DIR.parents[3]), env=_env(config, lane, record),
                     input=adapter["command"], timeout=lane.get("send_timeout", 30), check=False)
        if not staged.stdout.strip():
            raise RuntimeError(f"lane {lane_id} shell launcher returned no receipt (exit {staged.returncode})")
        delivery = json.loads(staged.stdout)
        if staged.returncode or not delivery.get("submitted"):
            raise RuntimeError(f"lane {lane_id} shell launch refused: {delivery.get('verification', 'unverified')}")
    if not pane.startswith("%") or not pane[1:].isdigit():
        raise RuntimeError(f"tmux did not return a pane id for lane {lane_id}")
    if resume_id != record.get("session_id"):
        record["goal_submitted"] = False
    record.update(pane_id=pane, runtime_dir=adapter["runtime_dir"],
                  observability_dir=adapter["observability_dir"], session_id=resume_id,
                  goal_supported=adapter.get("goal_supported", False), goal_prefix=adapter.get("goal_prefix", "/goal"))
    _update(config, lane_id, record)
    if not Path(lane["report"]).exists():
        append_report(lane["report"], "# Lane report")
    deadline = time.monotonic() + lane.get("launch_timeout", 120)
    while True:
        observation = _observe(config, lane, pane, record)
        owner = _pane_owner(observation)
        if created and owner:
            record["launch_pane_owner"] = owner
            _update(config, lane_id, {"launch_pane_owner": record["launch_pane_owner"]})
            created = False
        phase = observation.get("phase", "unknown")
        if observation.get("state") == lane["runner"]:
            if observation.get("auto_action") == "codex-skip-update":
                remaining = max(1, int(deadline - time.monotonic()))
                run(["bash", str(DRIVER_DIR / "resolve-launch-blockers.sh"), pane,
                     lane["runner"], str(remaining)], cwd=str(DRIVER_DIR.parents[3]),
                    env=_env(config, lane, record), timeout=remaining + 5)
                continue
            if phase == "idle":
                break
            if phase in {"question", "queued", "pending-question", "launch-blocker"} or (phase == "busy" and not adapter.get("bootstrap_pending")):
                append_report(lane["report"], f"LAUNCH {lane_id}: {phase}; inspect before sending")
                return {"lane": lane_id, "status": phase, "pane_id": pane,
                        "observation": observation}
        if time.monotonic() >= deadline:
            raise TimeoutError(f"lane {lane_id} did not become ready; last state: {json.dumps(observation)}")
        time.sleep(0.05)
    if not submit_goal or resume_id and record.get("goal_submitted"):
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
