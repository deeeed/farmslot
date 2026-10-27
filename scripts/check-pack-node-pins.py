#!/usr/bin/env python3
"""Compare committed farm Node fixtures with their product main requirements."""

import argparse
import base64
import json
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote


def github_slug(repo_url):
    match = re.fullmatch(
        r"(?:git@github\.com[^:]*:|https://github\.com/)([^/]+/[^/]+?)(?:\.git)?",
        repo_url,
    )
    if not match:
        raise ValueError("unsupported repository URL")
    return match[1]


def github_read(slug, suffix):
    return json.loads(
        subprocess.check_output(
            ["gh", "api", "repos/" + slug + "/" + suffix],
            text=True,
            stderr=subprocess.PIPE,
        )
    )


def main_head(slug):
    return github_read(slug, "git/ref/heads/main")["object"]["sha"]


def main_file(slug, head, name):
    data = github_read(slug, "contents/" + quote(name, safe="/") + "?ref=" + head)
    return base64.b64decode(data["content"]).decode()


def node_fixture(config):
    return next(
        (
            entry.get("src")
            for entry in config.get("fixtures", {}).get("templates", [])
            if entry.get("dst") == ".tool-versions"
        ),
        None,
    )


def check_node_pins(farm, projects):
    if not (farm / "pool").is_dir():
        print(
            f"pack-node-pins: UNVERIFIED: missing pool directory {farm / 'pool'}; pass a Farmslot checkout root"
        )
        return 1
    project_names = set()
    for pool_file in sorted((farm / "pool").glob("*.json")):
        if pool_file.name == "example.json":
            continue
        pool = json.loads(pool_file.read_text())
        project_names.update(
            (
                slot.get("project") or pool["project"]
                for slot in pool.get("slots", [])
                if slot.get("enabled", True)
            )
        )
    failed = checked = 0
    for project in sorted(project_names):
        pack = projects / project
        try:
            tracked = subprocess.run(
                ["git", "-C", str(pack), "ls-files", "--error-unmatch", "project.json"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            if tracked.returncode:
                # Untracked private packs have no upstream Node contract to compare.
                if not node_fixture(json.loads((pack / "project.json").read_text())):
                    continue
                raise ValueError("Node fixture has no tracked farm project.json")
            origin = subprocess.check_output(
                ["git", "-C", str(pack), "remote", "get-url", "origin"],
                text=True,
                stderr=subprocess.PIPE,
            ).strip()
            prefix = subprocess.check_output(
                ["git", "-C", str(pack), "rev-parse", "--show-prefix"],
                text=True,
                stderr=subprocess.PIPE,
            ).strip()
            farm_slug = github_slug(origin)
            head = main_head(farm_slug)
            config = json.loads(main_file(farm_slug, head, prefix + "project.json"))
            source = node_fixture(config)
            if not source:
                continue
            fixture = main_file(farm_slug, head, prefix + "fixtures/" + source)
            pin = next(
                (
                    line.split()[1]
                    for line in fixture.splitlines()
                    if len(line.split()) >= 2 and line.split()[0] == "nodejs"
                ),
                None,
            )
            product_slug = github_slug(config["repo_url"])
            product_head = main_head(product_slug)
            required = (
                main_file(product_slug, product_head, ".nvmrc")
                .strip()
                .removeprefix("v")
            )
        except (subprocess.CalledProcessError, OSError, ValueError, KeyError) as error:
            if isinstance(error, subprocess.CalledProcessError):
                cause = (error.stderr or "").splitlines()
                detail = f"{error.cmd[0]} {error.cmd[-1]} exited {error.returncode}"
                if cause:
                    detail += f": {cause[0]}"
            else:
                detail = str(error)
            print(f"pack-node-pins: UNVERIFIED {project}: {detail}")
            failed = 1
            continue
        checked += 1
        if pin and required == "lts/*":
            continue
        if pin and re.fullmatch(r"[0-9]+(?:\.[0-9]+){0,2}", required):
            if pin == required or (
                required.count(".") < 2 and pin.startswith(required + ".")
            ):
                continue
        print(
            f"pack-node-pins: DRIFT {project}: farm main {head[:12]} fixtures/{source} nodejs {pin or 'MISSING'}, product main {product_head[:12]} .nvmrc requires {required or 'MISSING'}"
        )
        failed = 1
    if not failed:
        print(f"pack-node-pins: Node pins match ({checked} projects)")
    return failed


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "checkout", nargs="?", type=Path, default=Path(__file__).resolve().parent.parent
    )
    checkout = parser.parse_args().checkout.expanduser().resolve()
    sys.exit(check_node_pins(checkout, checkout / "projects"))
