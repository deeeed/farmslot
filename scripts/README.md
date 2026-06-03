# Scripts

Root-level scripts are the public Farmslot command surface. Keep them framework-level and project-agnostic; project behavior belongs in `projects/<name>/project.json` hooks and project-local scripts.

## Public Entrypoints

- Slot lifecycle: `setup-slot.sh`, `prepare-slot.sh`, `preflight-slot.sh`, `check-slot.sh`, `release-slot.sh`, `teardown-slot.sh`, refresh helpers.
- Fleet commands: `farm-status.sh`, `find-slot.sh`, `show-slot.sh`, `monitor-slot.sh`, `deploy-node.sh`.
- Dispatch and PR workflows: `dispatch.sh`, `post-fix.sh`, `post-review.sh`, `pr-status.sh`, `pr-monitor.sh`.
- Fixtures and config: `sync-fixtures.sh`, `validate-config.sh`, media download helpers.
- Triage and scoring: `triage-bug.sh`, `batch-triage.sh`, `score-bug.sh`, `grade-bug.sh`, `validate-bug.sh`.

## Internal Areas

- `lib/` contains shared implementation helpers used by public scripts.
- `quality/` contains repository/package quality gates used by package scripts and CI.
- `scoring/` contains generic scoring utilities.

Do not add compatibility wrappers for unpublished internal paths. If a script path changes, update checked-in package scripts, CI, tests, and docs that invoke it.
