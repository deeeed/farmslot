---
title: Agent runtime
---

# Agent runtime

`@farmslot/agent-runtime` is the reusable task lifecycle layer for Farmslot-compatible agent runs. It can be used by full Farmslot dispatch, a project harness, or a skills-only workflow without Command Center, gateway, pools, or slots.

## Boundary

| Package                    | Owns                                                                                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@farmslot/protocol`       | Pure contracts, types, validators, and shared constants.                                                                                                  |
| `@farmslot/recipe-harness` | Recipe graph execution and recipe artifact package writing.                                                                                               |
| `@farmslot/agent-runtime`  | Task-local marking, `SIGNAL.json`, checklist timing, worker terminal contract resolution, closeout artifact checks, and recipe-quality artifact building. |
| `@farmslot/skills`         | Agent instructions and installer behavior; legacy runtime paths are shims.                                                                                |

See [Protocol boundaries](../architecture/protocol-boundaries.md) for the wider Farmslot-owns / project-owns split.

## Task directory

A runtime-compatible task directory contains:

- `CHECKLIST.md` with `- [ ]` checklist items (the execution checklist) beside `TASK.md`, the task document that holds the ticket and acceptance criteria and is never enumerated (see [Task directory contract](task-directory-contract.md));
- `artifacts/` for reports, learnings, recipe outputs, and evidence;
- `SIGNAL.json`, written by `mark` only;
- optionally `checklist-target.json`, written by a role switch to point `mark` at another checklist; absent means `CHECKLIST.md` + `SIGNAL.json`;
- optional `inputs/worker-terminal-contract.json` for project-specific terminal requirements;
- `mark`, a task-local executable shim written by `task init` (gateway or `farmslot-agent task init`).

Agents should use the task-local shim:

```bash
./mark start
./mark 1
./mark complete --mark-last
```

Do not hand-write `SIGNAL.json`. The runtime preserves pass-through fields, records checklist timing, verifies terminal artifacts, and writes the terminal status atomically.

For the terminal status shape see [Worker signal protocol](worker-signal-protocol.md), and for the per-flow artifact lists that `mark` enforces see [Worker artifacts by flow](worker-artifacts-by-flow.md).

## CLI

```bash
farmslot-agent task init <task-dir> --flow <flow> --run-mode <mode> --platform <p> --template <id> --package-templates <catalog> --title "…"
farmslot-agent mark <task-dir> complete --mark-last
farmslot-agent mark <task-dir> --checklist TASK.md complete --mark-last
farmslot-agent artifact-check <task-dir> --require-recipe-quality-if-recipe
farmslot-agent recipe-quality build --input recipe-quality-input.json --output artifacts/recipe-quality.json
farmslot-agent contract resolve --flow fix-bug
farmslot-agent execution-template <list|materialize|lint|new> [options]
```

`mark` takes a **task directory**, not individual file paths — its first argument must be an existing directory or the command exits with the usage error. In task-dir mode it marks `CHECKLIST.md` (or `TASK.md` when there is no `CHECKLIST.md`) and writes `SIGNAL.json`, unless a `checklist-target.json` written by a role switch points elsewhere. `--checklist` selects another checklist explicitly; the signal filename is then derived from it (other checklists get a role-scoped signal).

`task init` writes the whole task directory: `TASK.md`, `CHECKLIST.md`, the task-local `mark` shim, `inputs/handoff.json`, and `inputs/worker-terminal-contract.json`. It does not write `checklist-target.json`: absent means `CHECKLIST.md` + `SIGNAL.json`, and only a role switch writes the manifest to point elsewhere (the Farmslot gateway still writes the default-valued file for one release so slots on an older `mark` engine keep working). `./mark <step>` therefore works from inside the task without overrides.

`artifact-check` validates task closeout files. When recipe artifacts exist, `recipe-quality.json` must satisfy the shared `RecipeQualityArtifact` validator from `@farmslot/protocol`.

`recipe-quality build` lets an agent provide the fields it knows after review — verdict, reasons, findings, suggested deltas, and proof metadata — and receive a complete `artifacts/recipe-quality.json` that passes the protocol validator. Use an input JSON file for nested findings/dimensions and repeated CLI flags for simple cases:

```bash
farmslot-agent recipe-quality build \
  --verdict warn \
  --reason 'Main claim is covered, teardown proof is missing.' \
  --delta 'Add a teardown assertion node.' \
  --proof-mode mixed \
  --output artifacts/recipe-quality.json
```

The builder preserves additive metadata under `extra` while protecting the required protocol fields from being overwritten. Use `--input -` to read compact JSON from stdin. CLI flags override file-provided scalar and array fields; `trainingFields` merge field-by-field so flags can refine proof metadata without dropping project or flow metadata.

## Compatibility

The previous script paths in `@farmslot/skills` and `scripts/quality/` remain compatibility shims for one migration window. New templates should point to `packages/agent-runtime/scripts/*` in the Farmslot monorepo or use `farmslot-agent` when installed as a package.
