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

- `TASK.md` or `CHECKLIST.md` with `- [ ]` checklist items;
- `artifacts/` for reports, learnings, recipe outputs, and evidence;
- `SIGNAL.json`, written by `mark` only;
- `checklist-target.json`, written by the gateway at task creation or role switch, naming the checklist and signal file the task-local `mark` resolves to;
- optional `inputs/worker-terminal-contract.json` for project-specific terminal requirements;
- `mark`, a task-local executable shim installed by the gateway or `farmslot-agent install-mark`.

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
farmslot-agent install-mark <task-dir>
farmslot-agent mark <task-dir> complete --mark-last
farmslot-agent mark <task-dir> --checklist TASK.md complete --mark-last
farmslot-agent artifact-check <task-dir> --require-recipe-quality-if-recipe
farmslot-agent recipe-quality build --input recipe-quality-input.json --output artifacts/recipe-quality.json
farmslot-agent contract resolve --flow fix-bug
farmslot-agent execution-template <list|materialize|lint|new> [options]
```

`mark` takes a **task directory**, not individual file paths — its first argument must be an existing directory or the command exits with the usage error. In task-dir mode it resolves which checklist and signal file to use from `checklist-target.json`, which the gateway writes at task creation or role switch. Outside a gateway-managed task, pass `--checklist` to select the checklist explicitly; the signal filename is then derived from it (`TASK.md` yields `SIGNAL.json`, other checklists get a role-scoped signal), and no `checklist-target.json` is needed.

`install-mark` writes only the task-local `mark` shim into the directory, so the shim can be invoked as `./mark <step>` from inside the task. It does not write `checklist-target.json` and does not accept checklist or signal overrides, so a directory bootstrapped this way needs either a gateway-written manifest or an explicit `--checklist` on each call.

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
