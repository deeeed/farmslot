# Changelog

All notable changes to `@farmslot/skills` are tracked here.

## Unreleased

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
