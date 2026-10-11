#!/usr/bin/env bash
# Shared lifecycle policy for Gateway/UI and Companion sandbox hooks.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../../scripts/lib/stack-credentials.sh"

sandbox_primary_repo() {
  local repo="$1" project_json="$1/projects/farmslot-farm/project.json"
  [[ -f "$project_json" ]] || return 1
  node -e '
    const fs = require("node:fs");
    const { execFileSync } = require("node:child_process");
    const project = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const configured = String(project.primary_repo || "").trim();
    const primary = configured || execFileSync("git",
      ["-C", process.argv[2], "worktree", "list", "--porcelain", "-z"],
      { encoding: "utf8" }).split("\0")[0].slice("worktree ".length);
    process.stdout.write(primary);
  ' "$project_json" "$repo"
}

sandbox_is_primary_checkout() {
  local primary_repo
  primary_repo="$(sandbox_primary_repo "$1")" || return 1
  [[ "$(cd "$1" && pwd -P)" == "$(cd "$primary_repo" && pwd -P)" ]]
}
