"""Configuration and process helpers shared by the orchestration commands."""

import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

DRIVER_DIR = Path(__file__).resolve().parents[2] / "tmux-model-driver" / "scripts"


def load_config(path):
    source = Path(path).expanduser().resolve()
    config = json.loads(source.read_text())
    if config.get("version") != 1:
        raise ValueError("configuration version must be 1")
    config["_path"] = str(source)
    config["_dir"] = str(source.parent)
    config["state_dir"] = str(resolve_path(config, config.get("state_dir", "state")))
    config.setdefault("lanes", [])
    config.setdefault("projects", {})
    ids, sessions = set(), set()
    for lane in config["lanes"]:
        if lane["id"] in ids or not re.fullmatch(r"[A-Za-z0-9_-]+", lane["id"]):
            raise ValueError("lane ids must be unique safe session names")
        ids.add(lane["id"])
        session = lane.get("session", lane["id"])
        if session in sessions or not re.fullmatch(r"[A-Za-z0-9_-]+", session):
            raise ValueError("lane session names must be unique safe names")
        sessions.add(session)
        for field in ("cwd", "goal", "report"):
            lane[field] = str(resolve_path(config, lane[field]))
    return config


def resolve_path(config, value):
    path = Path(value).expanduser()
    return path.resolve() if path.is_absolute() else (Path(config["_dir"]) / path).resolve()


def run(argv, *, cwd=None, env=None, input=None, timeout=60, check=True):
    result = subprocess.run(argv, cwd=cwd, env=env, input=input, text=True,
                            capture_output=True, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError(f"{argv[0]} failed ({result.returncode}): {result.stderr.strip()}")
    return result


def tmux_argv(config, *args):
    socket = config.get("tmux", {}).get("socket")
    return ["tmux", *(["-L", socket] if socket else []), *args]


def driver_env(config, lane=None):
    env = os.environ.copy()
    socket = config.get("tmux", {}).get("socket")
    if socket:
        env["TMUX_MODEL_DRIVER_SOCKET"] = socket
    else:
        env.pop("TMUX_MODEL_DRIVER_SOCKET", None)
    if lane:
        for key, value in lane.get("env", {}).items():
            env[key] = str(value)
    return env


def write_json(path, value):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", dir=target.parent, delete=False) as stream:
        temporary = Path(stream.name)
        json.dump(value, stream, indent=2)
        stream.write("\n")
    os.replace(temporary, target)


def read_json(path, default=None):
    target = Path(path)
    return json.loads(target.read_text()) if target.exists() else default


def append_report(path, line):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    existing = target.read_text() if target.exists() else ""
    if line not in existing.splitlines():
        with target.open("a") as stream:
            stream.write(("\n" if existing and not existing.endswith("\n") else "") + line + "\n")


def gh(argv, *, write=False, input=None):
    env = os.environ.copy()
    if write:
        env.pop("GH_TOKEN", None)
    return run(["gh", *argv], env=env, input=input)


def project_hook(config, repo, name):
    project = config["projects"].get(repo, {})
    command = project.get("hooks", {}).get(name)
    if not command or not isinstance(command, list) or not all(isinstance(v, str) for v in command):
        raise ValueError(f"project {repo} needs an argv hook for {name}")
    cwd = str(resolve_path(config, project.get("cwd", ".")))
    result = run(command, cwd=cwd, timeout=project.get("hook_timeout", 60))
    return result.stdout
