#!/usr/bin/env python3
import base64
import contextlib
import hashlib
import importlib.util
import io
import json
import pathlib
import posixpath
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    "pack_node_pins", ROOT / "check-pack-node-pins.py"
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
scope = vars(module)


class CommittedPins(unittest.TestCase):
    def setUp(self):
        self.started = time.perf_counter()
        self.scratch = tempfile.TemporaryDirectory(prefix="pack-node-pins-")
        self.root = pathlib.Path(self.scratch.name)

    def tearDown(self):
        self.scratch.cleanup()
        print(f"{self.id()}: {time.perf_counter() - self.started:.3f}s")

    def build(self, pin="24.22.1", linked=False, declared=True):
        pack = self.root / "projects" / "mobile"
        self.pack = pack
        (pack / "fixtures").mkdir(parents=True)
        (pack / "setup").mkdir()
        (pack / "setup/tool-versions").write_text(
            "ruby 3.2.9\n" + ("nodejs " + pin + "\n" if pin else "")
        )
        fixture = pack / "fixtures/.tool-versions"
        if linked:
            fixture.symlink_to("../setup/tool-versions")
        else:
            fixture.write_bytes((pack / "setup/tool-versions").read_bytes())
        (pack / "project.json").write_text(
            json.dumps(
                {
                    "repo_url": "git@github.com:example/product.git",
                    "fixtures": {
                        "templates": [
                            {"src": ".tool-versions", "dst": ".tool-versions"}
                        ]
                        if declared
                        else []
                    },
                }
            )
        )

        def git(*args):
            return subprocess.check_output(
                ["git", "-c", "core.hooksPath=/dev/null", "-C", str(pack), *args],
                text=True,
                stderr=subprocess.DEVNULL,
            ).strip()

        git("init", "-q", "-b", "main")
        git("remote", "add", "origin", "git@github.com:example/mobile-farm.git")
        git("config", "user.name", "Fixture")
        git("config", "user.email", "fixture@example.invalid")
        git("add", ".")
        git("-c", "commit.gpgsign=false", "commit", "-qm", "test: seed committed pin")
        git("update-ref", "refs/remotes/origin/main", "HEAD")
        (self.root / "pool").mkdir()
        (self.root / "pool/test.json").write_text(
            json.dumps(
                {
                    "slots": [
                        {
                            "id": "old-slot",
                            "project": "mobile",
                            "repo": str(self.root / "stale-checkout"),
                        },
                        {
                            "id": "second-slot",
                            "project": "mobile",
                            "repo": str(self.root / "other-checkout"),
                        },
                    ]
                }
            )
        )
        (self.root / "stale-checkout").mkdir()
        (self.root / "stale-checkout/.nvmrc").write_text("18\n")
        return pack, git

    def run_check(self, required="24.22.1", failure=False):
        calls = []
        original = subprocess.check_output

        def output(argv, **kwargs):
            if argv[0] != "gh":
                return original(argv, **kwargs)
            calls.append(argv)
            if failure and argv[-1].startswith("repos/example/product/"):
                raise subprocess.CalledProcessError(
                    1, argv, stderr="gh: Bad credentials (HTTP 401)"
                )
            if argv[-1].startswith("repos/example/mobile-farm/"):

                def git(*args):
                    return original(
                        ["git", "-C", str(self.pack), *args],
                        text=True,
                        stderr=subprocess.DEVNULL,
                    ).strip()

                remote_head = git("rev-parse", "HEAD")
                if argv[-1].endswith("git/ref/heads/main"):
                    return json.dumps({"object": {"sha": remote_head}})
                name = argv[-1].split("/contents/", 1)[1].split("?ref=")[0]
                self.assertTrue(argv[-1].endswith("?ref=" + remote_head))
                while True:
                    data = git("show", remote_head + ":" + name) + "\n"
                    if not git("ls-tree", remote_head, "--", name).startswith(
                        "120000 "
                    ):
                        break
                    name = posixpath.normpath(
                        str(pathlib.PurePosixPath(name).parent / data.strip())
                    )
                return json.dumps({"content": base64.b64encode(data.encode()).decode()})
            if argv[-1].endswith("git/ref/heads/main"):
                return json.dumps({"object": {"sha": "a" * 40}})
            self.assertEqual(
                argv[-1], "repos/example/product/contents/.nvmrc?ref=" + "a" * 40
            )
            return json.dumps(
                {"content": base64.b64encode((required + "\n").encode()).decode()}
            )

        stream = io.StringIO()
        with (
            patch.object(subprocess, "check_output", side_effect=output),
            contextlib.redirect_stdout(stream),
        ):
            result = scope["check_node_pins"](self.root, self.root / "projects")
        return result, stream.getvalue(), calls

    def test_dirty_local_fix_cannot_hide_bad_committed_pin_and_deduplicates(self):
        pack, _ = self.build(pin="24.16.0")
        (pack / "fixtures/.tool-versions").write_text("nodejs 24.22.1\n")
        result, text, calls = self.run_check()
        self.assertEqual(result, 1)
        for expected in ["DRIFT mobile:", "24.16.0", "24.22.1", "farm main"]:
            self.assertIn(expected, text)
        self.assertEqual(text.count("DRIFT "), 1)
        self.assertEqual(len(calls), 5)

    def test_old_slot_and_dirty_working_pin_do_not_create_false_drift(self):
        pack, _ = self.build()
        (pack / "fixtures/.tool-versions").write_text("nodejs 18.0.0\n")
        (pack / "project.json").write_text("{}")
        result, text, calls = self.run_check()
        self.assertEqual(result, 0, text)
        self.assertIn("(1 projects)", text)

    def test_committed_symlink_reads_committed_target(self):
        pack, _ = self.build(linked=True)
        (pack / "setup/tool-versions").write_text("nodejs 18.0.0\n")
        self.assertEqual(self.run_check()[0], 0)

    def test_numeric_major_minor_and_lts_compatibility(self):
        self.build()
        for required in ["24", "v24.22", "lts/*"]:
            self.assertEqual(self.run_check(required=required)[0], 0)
        for required in ["2", "v24.2", "26.12.1"]:
            self.assertEqual(self.run_check(required=required)[0], 1)

    def test_missing_node_pin_cannot_pass_lts(self):
        self.build(pin=None)
        self.assertEqual(self.run_check(required="lts/*")[0], 1)

    def test_no_declared_node_fixture_skips_product_and_slot_reads(self):
        self.build(declared=False)
        result, text, calls = self.run_check()
        self.assertEqual(result, 0, text)
        self.assertEqual(len(calls), 2)
        self.assertFalse(any("repos/example/product/" in x[-1] for x in calls))

    def test_unavailable_product_fails_loudly_without_traceback(self):
        self.build()
        result, text, _ = self.run_check(failure=True)
        self.assertEqual(result, 1)
        self.assertIn("UNVERIFIED mobile:", text)
        self.assertIn("repos/example/product/git/ref/heads/main", text)
        self.assertIn("HTTP 401", text)

    def test_project_embedded_in_a_parent_repository_reads_relative_git_path(self):
        pack, git = self.build()
        nested = pack / "nested"
        (nested / "fixtures").mkdir(parents=True)
        (nested / "project.json").write_bytes((pack / "project.json").read_bytes())
        (nested / "fixtures/.tool-versions").write_text("nodejs 24.22.1\n")
        git("add", ".")
        git("-c", "commit.gpgsign=false", "commit", "-qm", "test: add embedded project")
        git("update-ref", "refs/remotes/origin/main", "HEAD")
        pool = self.root / "pool/test.json"
        config = json.loads(pool.read_text())
        for slot in config["slots"]:
            slot["project"] = "mobile/nested"
        pool.write_text(json.dumps(config))
        result, text, _ = self.run_check()
        self.assertEqual(result, 0, text)

    def test_stale_farm_tracking_ref_does_not_override_upstream_main(self):
        pack, git = self.build(pin="24.16.0")
        (pack / "fixtures/.tool-versions").write_text("nodejs 24.22.1\n")
        git("add", ".")
        git("-c", "commit.gpgsign=false", "commit", "-qm", "test: update upstream pin")
        result, text, _ = self.run_check()
        self.assertEqual(result, 0, text)

    def test_projects_shared_across_node_pools_are_checked_once(self):
        self.build()
        (self.root / "pool/other-node.json").write_bytes(
            (self.root / "pool/test.json").read_bytes()
        )
        result, text, calls = self.run_check()
        self.assertEqual(result, 0, text)
        self.assertEqual(len(calls), 5)

    def test_example_pool_does_not_add_an_unconfigured_project(self):
        self.build()
        (self.root / "pool/example.json").write_text(
            json.dumps({"project": "my-app-farm", "slots": [{"id": "sample"}]})
        )
        result, text, calls = self.run_check()
        self.assertEqual(result, 0, text)
        self.assertEqual(len(calls), 5)

    def test_workspace_parent_is_refused_instead_of_false_success(self):
        self.build()
        checkout = self.root / "farmslot"
        checkout.mkdir()
        (self.root / "pool").rename(checkout / "pool")
        (self.root / "projects").rename(checkout / "projects")
        result, text, calls = self.run_check()
        self.assertEqual(result, 1)
        self.assertIn("UNVERIFIED", text)
        self.assertIn("Farmslot checkout root", text)
        self.assertEqual(calls, [])

    def test_check_does_not_change_files_or_refs(self):
        self.build()

        def snapshot():
            return {
                str(p.relative_to(self.root)): hashlib.sha256(
                    p.read_bytes()
                ).hexdigest()
                for p in self.root.rglob("*")
                if p.is_file()
            }

        before = snapshot()
        self.assertEqual(self.run_check()[0], 0)
        self.assertEqual(snapshot(), before)


if __name__ == "__main__":
    unittest.main(verbosity=2)
