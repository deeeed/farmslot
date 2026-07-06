# Changelog

## Unreleased

- Active-development baseline; add user-facing changes here before release or package publication.
- Require `checklist-target.json` for task-dir `./mark`; remove the legacy explicit-args invocation surface.

## 0.1.1 - 2026-07-06

### Added

- Add `checklist-target.json` resolution to `mark-checklist-step.cjs` task-dir mode so `./mark` retargets to nested-loop checklists without per-role wrapper scripts.
- Add `--checklist` / `--signal` overrides on task-dir invocations; signal defaults from checklist basename when omitted.
- Add centralized nested-loop checklist/signal registry (`DEFAULT_CHECKLIST_TARGET_REGISTRY`, `CHECKLIST_TARGET_BY_AGENT_ROLE`) and path helpers in `checklist-target.cjs`.
- Add sync test ensuring `checklist-target.cjs` constants stay aligned with `@farmslot/protocol/checklist-target`.

### Changed

- Task-dir `./mark` now requires a valid `checklist-target.json`; missing or invalid manifests fail with a teaching error instead of silently falling back to worker `TASK.md`/`SIGNAL.json`.
- Remove the legacy explicit-args mark surface (`mark <task.md> <signal.json> <step>`); task-dir mode is the only supported invocation.

## 0.1.0 - 2026-07-06
