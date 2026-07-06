# Changelog

## Unreleased

- Active-development baseline; add user-facing changes here before release or package publication.

## 0.1.1 - 2026-07-06

### Added

- Add `checklist-target.json` resolution to `mark-checklist-step.cjs` task-dir mode so `./mark` retargets to nested-loop checklists without per-role wrapper scripts.
- Add `--checklist` / `--signal` overrides on task-dir invocations; signal defaults from checklist basename when omitted.
- Add centralized nested-loop checklist/signal registry (`DEFAULT_CHECKLIST_TARGET_REGISTRY`, `CHECKLIST_TARGET_BY_AGENT_ROLE`) and path helpers in `checklist-target.cjs`.

### Changed

- Task-dir `./mark` now requires a valid `checklist-target.json`; missing or invalid manifests fail with a teaching error instead of silently falling back to worker `TASK.md`/`SIGNAL.json`.

## 0.1.0 - 2026-07-06

### Added

- Add `buildRecipeQualityArtifact()` and `farmslot-agent recipe-quality build` so agents can generate validator-compliant `recipe-quality.json` artifacts from compact verdict/reason/finding inputs.
- Introduce `@farmslot/agent-runtime` for task-local `mark`, `SIGNAL.json`, worker terminal contract, and task artifact checks.
- Add `farmslot-agent` CLI with `mark`, `artifact-check`, `install-mark`, and `contract resolve` commands.
