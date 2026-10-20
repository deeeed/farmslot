# Changelog

All notable changes to `@farmslot/skills` are tracked here.

## Unreleased

- Active-development baseline; add user-facing changes here before release or package publication.

## 0.13.0 - 2026-10-20

- Align with `@farmslot/agent-runtime` 0.36.0.

## 0.12.0 - 2026-10-19

- Align with `@farmslot/agent-runtime` 0.35.0.

## 0.11.0 - 2026-10-19

- Align with `@farmslot/agent-runtime` 0.34.0.

## 0.10.0 - 2026-10-19

- Align with `@farmslot/agent-runtime` 0.33.0.

## 0.9.0 - 2026-10-19

- Align with `@farmslot/agent-runtime` 0.32.0.

## 0.8.0 - 2026-10-19

- Align with `@farmslot/agent-runtime` 0.31.0.

## 0.7.0 - 2026-10-19

- Align with `@farmslot/agent-runtime` 0.30.0.
- The `recipe-harness` skill inspects recipes with `farmslot recipe run --list` and `--describe` (allowed tool `Bash(farmslot recipe:*)`), since `farmslot-recipe` is removed.

## 0.6.27 - 2026-10-18

- Align with `@farmslot/agent-runtime` 0.29.5.

## 0.6.26 - 2026-10-18

- Align with `@farmslot/agent-runtime` 0.29.4.

## 0.6.25 - 2026-10-18

- Align with `@farmslot/agent-runtime` 0.29.3.

## 0.6.24 - 2026-10-18

- Align with `@farmslot/agent-runtime` 0.29.2, which merges a QA task's case packages into one acceptance ledger.

## 0.6.23 - 2026-10-17

- Align with `@farmslot/agent-runtime` 0.29.1, which moves to `@farmslot/adapter-sdk` 0.18.1 and `@farmslot/recipe-runner` 0.39.1.

## 0.6.22 - 2026-10-17

- Submit lane handoffs with Enter only and prove delivery from native transcripts or the exact next-tool-call steering block; a retry presses Enter for owned text left in the composer without retyping.

## 0.6.21 - 2026-10-16

- Align the worker dependency set with parent acceptance inheritance and Protocol 0.53.0.

## 0.6.20 - 2026-10-16

- Align the worker dependency set with Protocol 0.52.0 and default pipeline visual review.

## 0.6.19 - 2026-10-16

- Align the worker dependency set with Protocol 0.51.0.

## 0.6.18 - 2026-10-16

- Consume the recipe-runner 0.38.1 still-filename fix throughout the worker dependency set.

## 0.6.17 - 2026-10-16

- Align the worker dependency set with Protocol 0.50.0 and the qualified one-tap visual review readers.

## 0.6.16 - 2026-10-16

- Align the worker dependency set with Protocol 0.49.0 person-device sessions.

## 0.6.15 - 2026-10-15

- Use runtime 0.25.1 for retained task input lookup.

## 0.6.14 - 2026-10-15

- Use the retained task-tooling runtime dependency set.

## 0.6.13 - 2026-10-15

- Use the operator-wait runtime and protocol dependency set.

## 0.6.12 - 2026-10-15

- Align the published dependency set with the plain runtime and action contract names.

## 0.6.11 - 2026-10-15

- Align the published dependency set with protocol 0.47.0 initial resource proof modes.

## 0.6.10 - 2026-10-15

- Use agent-runtime 0.23.1 for native review account preflight and isolated account hooks.

## 0.6.9 - 2026-10-15

- Keep source and review diff identities stable across user Git settings; disable external diff and text conversion.

## 0.6.8 - 2026-10-15

- Align the installed dependency closure with protocol 0.45.0 and retained-run stack attachment.

## 0.6.7 - 2026-10-15

- Use agent-runtime 0.22.1 for verified stopped-host recovery while preserving native session journals.

## 0.6.6 - 2026-10-15

- Align the installed worker dependency closure with protocol 0.44.0 and provenance-bound branch maintenance.
- Keep lane terminals after runner exit, show retained session IDs and support guarded resume with skip-only startup updates.

## 0.6.5 - 2026-10-14

- Use agent-runtime 0.21.3 for guarded farm review startup.

## 0.6.4 - 2026-10-10

- Publish with agent-runtime 0.17.4 so consumers share one dependency copy. No code change.

## 0.6.3 - 2026-10-10

- Publish with agent-runtime 0.17.3 so consumers share one agent-runtime and one protocol copy. No code change.

## 0.6.2 - 2026-10-09

- Publish with agent-runtime 0.17.2 so consumers share one agent-runtime and one protocol copy. No code change.

## 0.6.1 - 2026-10-09

- Publish with agent-runtime 0.17.1 so consumers share one agent-runtime and one protocol copy. No code change.

## 0.6.0 - 2026-10-04

- `import` of `@farmslot/skills/scripts/worker-terminal-contract.cjs` exposes its names: it re-exports `@farmslot/agent-runtime/scripts/worker-terminal-contract.cjs` with a literal `require`, which ESM can follow, instead of a computed path with a repo-relative fallback.
- Skills refer to the recipe runner package as `@farmslot/recipe-runner` (renamed from `@farmslot/recipe-harness`).
- Publish with agent-runtime 0.17.0.

## 0.5.0 - 2026-09-20

- README documents the checklist-shaped skill rule: a skill invoked as a child checklist unit (ADR-060) needs `##` sections and `- [ ]` rows the shared parser can enumerate, informational sections named so the skip list drops them, and numbered labels matching their positions. A prose-only skill cannot be a child unit.

## 0.4.0 - 2026-09-17

- Recipe Cook lane: the runner envelope reports `terminal_status` (`done|blocked|failed`) and `terminal_reason`; the lane no longer reads or rewrites a `STATUS:` line in the run-local TASK.md, and `meta.json` records `terminal_reason`. Templates and skill text drop the field. An envelope without a valid `terminal_status`, or a blocked/failed one without `terminal_reason`, fails the run; the model output stays in `runner-output.txt`. The `tmux-model-driver` launcher and watcher stop mentioning or parsing the field.

## 0.3.0 - 2026-08-03

- Teach recipe authors to start from existing parameterized recipes and compose them node by node before adding new capabilities.
- Active-development baseline; add user-facing changes here before release or package publication.

## 0.2.0 - 2026-07-19

- Teach recipe authors to inspect declared actions and reusable flows before creating new capabilities

## 0.1.3 - 2026-07-08

- Update recipe-quality skill guidance to delegate runtime artifact generation to `@farmslot/agent-runtime`
- `packet`, a skill for packet-shaped operator communication aligned with ADR-048
- Convert task lifecycle scripts to compatibility shims over `@farmslot/agent-runtime`

## 0.1.2 - 2026-07-03

- Colocate finish-contract scripts in `packages/skills/scripts/` (`mark-checklist-step.cjs`, `worker-terminal-contract.cjs`, `check-task-artifact-contract.mjs`) for the initial `@farmslot/skills` and consensys-skills delegation path
- **dev / fix-bug:** terminal `./mark complete` requires `artifacts/learnings.md` + `artifacts/pr-description.md` (not `report.md`)
- `./mark` infers dev/fix-bug flow from embedded checklist `Skill:` header (standalone recipe skills)
- Export `./scripts/worker-terminal-contract.cjs` and `./scripts/check-task-artifact-contract.mjs` from the package

## 0.1.1 - 2026-06-30

- Single-path mark CLI for worker terminal signals.

## 0.1.0 - 2026-06-28

- Add the generic recipe-first skills package and migrate the former top-level recipe cooking kit into `skills/recipe-cook`.
