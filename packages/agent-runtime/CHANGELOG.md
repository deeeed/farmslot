# Changelog

## Unreleased

- Active-development baseline; add user-facing changes here before release or package publication.

## 0.1.1 - 2026-07-06

### Added

- Add `checklist-target.json` resolution to `mark-checklist-step.cjs` task-dir mode so `./mark` retargets to nested-loop checklists without per-role wrapper scripts.
- Add `--checklist` / `--signal` overrides on task-dir invocations; signal defaults from checklist basename when omitted.

## 0.1.0 - 2026-07-06

### Added

- Add `buildRecipeQualityArtifact()` and `farmslot-agent recipe-quality build` so agents can generate validator-compliant `recipe-quality.json` artifacts from compact verdict/reason/finding inputs.
- Introduce `@farmslot/agent-runtime` for task-local `mark`, `SIGNAL.json`, worker terminal contract, and task artifact checks.
- Add `farmslot-agent` CLI with `mark`, `artifact-check`, `install-mark`, and `contract resolve` commands.
