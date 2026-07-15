# Scripts

Root-level scripts are the public Farmslot command surface. Keep them framework-level and project-agnostic; project behavior belongs in `projects/<name>/project.json` hooks and project-local scripts.

The decision logic that used to live here has moved to the CLI/gateway (see `docs/reference/bash-decision-core-inventory.md`, Retirement section). What remains is the intentional residue: genuinely-shell edges (ssh/tmux/launchd/interactive terminals), bootstrap paths that must work before any Node install, and CI/test harness drivers. **Current count: 23** (down from 35 at the start of the shrink; slices: fixture-plan PR #325, slot verbs PR #327, bug family PR #328).

## Keep-list (every survivor justified)

| Script                             | Why it stays a script                                                                                                                                                      |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setup-slot.sh`                    | Onboarding bootstrap — must run on a bare machine before any Node/Yarn install exists.                                                                                     |
| `teardown-slot.sh`                 | Gateway-free teardown contract — must work when the gateway is down or being removed.                                                                                      |
| `dev.sh`                           | Dev-stack launcher (env loading, port guard, concurrently exec) — the thing that starts the CLI's own runtime.                                                             |
| `completions.sh`                   | Shell-native: sourced into bash/zsh for the `farm` wrapper + tab completion.                                                                                               |
| `farm-status.sh`                   | Display wrapper teammates alias; delegates to the CLI for data.                                                                                                            |
| `preflight-slot.sh`                | Edge probes (device/simulator/ssh) run before a stack exists on the slot.                                                                                                  |
| `deploy-node.sh`                   | Deploys the node agent TO a remote machine — cannot depend on the target's farmslot install.                                                                               |
| `record-window.sh`                 | ScreenCaptureKit/window-capture edge; pure macOS tooling shell-out.                                                                                                        |
| `gh-upload-asset.sh`               | Thin `gh` upload edge used by evidence publication.                                                                                                                        |
| `post-fix.sh` / `post-review.sh`   | `gh` comment/review posting edges used by worker templates.                                                                                                                |
| `pr-monitor.sh`                    | Interactive terminal formatter (watch-mode PR board); data comes from the CLI.                                                                                             |
| `session-usage.sh`                 | Wrapper over the `@farmslot/slot-config` core for shell callers (worker templates).                                                                                        |
| `e2e-tmux-runner-validate.sh`      | Test harness: drives real tmux sessions end-to-end in CI.                                                                                                                  |
| `run-runner-observability-gate.sh` | Test harness: observability agreement gate over live runner sessions.                                                                                                      |
| `write-runtime-context.sh`         | Writes slot runtime context files from hooks — runs inside prepare's shell environment.                                                                                    |
| `run-project-hook.sh`              | The hook execution edge itself — expands and runs `project.json` hooks.                                                                                                    |
| `audit-remote-path.sh`             | ssh path auditor for remote machines (no farmslot install assumed remotely).                                                                                               |
| `backup-runs.sh`                   | Cron-safe run-state backup; must not depend on a live gateway.                                                                                                             |
| `validate-config.sh`               | Pool/project JSON-schema validation usable pre-install and in CI.                                                                                                          |
| `sync-fixtures.sh`                 | Thin edge driver since PR #325: one `farmslot internal fixture-plan` call + the remote copy (ssh/scp), skip-worktree marking, and directory rsync.                         |
| `check-slot.sh`                    | Shim → `farmslot slot check`. Kept 2026-07-15: metamask-mobile/extension pack READMEs and core-farm docs still print it; delete after those packs repoint (team-repo PRs). |
| `prepare-slot.sh`                  | Shim → `farmslot slot prepare`. Same 2026-07-15 pack-repoint condition as `check-slot.sh`.                                                                                 |

Retired surfaces are CLI-first: slot helpers (`farmslot slot monitor|show|soft-refresh|reopen|auto-refresh`), bug pipeline (`farmslot bug triage|score|grade|validate|batch`, image download folded into `triage`/`batch`), dispatch/PR status (`farmslot run create`, `farmslot pr status|list`), slot picking (`farmslot fleet find-slot`).

## Internal Areas

- `lib/` contains shared implementation helpers used by public scripts.
- `quality/` contains repository/package quality gates used by package scripts and CI.
- `scoring/` contains generic scoring utilities.

Do not add compatibility wrappers for unpublished internal paths. If a script path changes, update checked-in package scripts, CI, tests, and docs that invoke it. Retired names are enforced deleted by `scripts/quality/check-retired-scripts.mjs`.
