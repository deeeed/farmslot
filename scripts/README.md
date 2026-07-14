# Scripts

Root-level scripts are the public Farmslot command surface. Keep them framework-level and project-agnostic; project behavior belongs in `projects/<name>/project.json` hooks and project-local scripts.

## Public Entrypoints

- Slot lifecycle: `setup-slot.sh`, `preflight-slot.sh`, `teardown-slot.sh`, refresh helpers. Prepare/check/release moved to the CLI: `farmslot slot prepare|check|release` (`prepare-slot.sh`/`check-slot.sh` remain as deprecated shims).
- Fleet commands: `farm-status.sh`, `deploy-node.sh`. Slot picking is `farmslot fleet find-slot`. Slot helpers moved to the CLI: `farmslot slot monitor|show|soft-refresh|reopen|auto-refresh`.
- Dispatch and PR workflows: `post-fix.sh`, `post-review.sh`, `pr-monitor.sh`. Dispatch and PR status are CLI-first: `farmslot run create`, `farmslot pr status|list`.
- Fixtures and config: `sync-fixtures.sh`, `validate-config.sh`, media download helpers. `sync-fixtures.sh` is now a thin edge driver: the template/compose variant/include selection + render loop lives in `@farmslot/slot-config` (`computeFixturePlan`), invoked once per sync via `farmslot internal fixture-plan`; the script only owns the remote copy (ssh/scp), skip-worktree marking, and directory rsync.
- Triage and scoring: CLI-first via `farmslot bug triage|score|grade|validate|batch` (the bug-pipeline scripts were ported to the CLI and retired in MANUAL-000034; image download is folded into `bug triage`/`bug batch --download-images`).

## Internal Areas

- `lib/` contains shared implementation helpers used by public scripts.
- `quality/` contains repository/package quality gates used by package scripts and CI.
- `scoring/` contains generic scoring utilities.

Do not add compatibility wrappers for unpublished internal paths. If a script path changes, update checked-in package scripts, CI, tests, and docs that invoke it.
