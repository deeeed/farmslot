# Changelog

## Unreleased

## 0.7.0 - 2026-08-03

- Publish against `@farmslot/protocol` 0.18.0 so downstream recipe tooling resolves one protocol version.

## 0.6.0 - 2026-08-03

- fix(mark): step enumeration now skips informational sections (Acceptance Criteria, pre-merge, `<details>`) exactly like the gateway parsers — checkbox-formatted ACs no longer shift `mark N` onto the wrong box. Also tightens checkbox matching to `- [ ]` (no `* [ ]`), matching gateway behavior.

## 0.5.1 - 2026-08-02

- Align the published protocol dependency with 0.16.0 so downstream installs use one Recipe Protocol version.

## 0.5.0 - 2026-08-01

- **BREAKING:** Require structured run summaries when validating recipe artifact packages.
- fix(workers): resolve terminal artifact contracts by checklist so simultaneous worker, reviewer, review-fix, and CI-fix contexts cannot overwrite one shared contract.
- fix(workers): validate terminal artifact dispositions and keep nested review checklist progress scoped to the active worker context.
- feat(execution-templates): surface optional descriptions for selection guidance.

## 0.4.0 - 2026-07-26

- Add the shared execution-template catalog, selection, snapshot, and CLI boundary.

## 0.3.1 - 2026-07-24

- Validate retained recipe traces against their recipes and artifact attribution.

## 0.3.0 - 2026-07-24

- Fail artifact validation when the installed protocol rejects the canonical Recipe v1 envelope.

- **BREAKING:** Task artifact checks require Recipe v1 resolution metadata and exact reachable dependency documents.
- security: resolved dependency reads use digest-derived paths only.
- Validate authored recipes separately from their executed `artifacts/recipe-run` package.

- fix: worker-template lint now fails templates that omit `./mark` entirely when the resolved contract requires a terminal signal — previously such templates were skipped and produced no author-time issue (mark-less templates stay valid for `requireSignal: false` flows such as interactive pr-complete).
- fix: builtin `self-review` / `self-review-fix` contracts require the reviewer artifacts the templates actually produce (`artifacts/review-feedback.md` / `artifacts/report.md`) instead of `artifacts/learnings.md`, and the runtime flow-report mapping + heading inference cover both flows — unbreaks `yarn quality:worker-templates`, which was failing on main.
- fix: recognize CI-fix worker headings as the `ci-fix` flow and lint task-dir `mark --checklist ...` terminal commands, so `CI-FIX-SIGNAL.json` uses the intended report contract.
- build: declare `tsx` as a devDependency — the execution-template tests run through the workspace-scoped `run-tsx-tests.mjs` runner (`yarn exec tsx`), which cannot resolve an undeclared binary on a clean CI install.
- feat: add shared Markdown execution-template resolver/lint/new (ADR-049) with `farmslot-agent execution-template` CLI.
- refactor: rename the branch-maintenance flow `merge-main` → `update-branch` in the worker terminal contract, checklist marker, and task artifact contract.
- Active-development baseline; add user-facing changes here before release or package publication.

## 0.2.0 - 2026-07-12

- fix: use workspace-linked `@farmslot/protocol` during local development so package builds cannot resolve a stale published sibling package.
- feat: the task-artifact contract check validates `artifacts/recipe.json` (envelope-only) and, when present, `artifacts/resolved-recipe.json` (in full, including flow-call resolution) against the shared Recipe Protocol v1 validator, with a local minimum-envelope fallback when `@farmslot/protocol` dist is not yet built.

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
