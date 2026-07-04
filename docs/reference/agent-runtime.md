# Agent Runtime

`@farmslot/agent-runtime` is the reusable task lifecycle layer for Farmslot-compatible agent runs. It can be used by full Farmslot dispatch, a project harness, or a skills-only workflow without Command Center, gateway, pools, or slots.

## Boundary

| Package                    | Owns                                                                                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@farmslot/protocol`       | Pure contracts, types, validators, and shared constants.                                                                                                  |
| `@farmslot/recipe-harness` | Recipe graph execution and recipe artifact package writing.                                                                                               |
| `@farmslot/agent-runtime`  | Task-local marking, `SIGNAL.json`, checklist timing, worker terminal contract resolution, closeout artifact checks, and recipe-quality artifact building. |
| `@farmslot/skills`         | Agent instructions and installer behavior; legacy runtime paths are shims.                                                                                |

## Task Directory

A runtime-compatible task directory contains:

- `TASK.md` or `CHECKLIST.md` with `- [ ]` checklist items;
- `artifacts/` for reports, learnings, recipe outputs, and evidence;
- `SIGNAL.json`, written by `mark` only;
- optional `inputs/worker-terminal-contract.json` for project-specific terminal requirements;
- `mark`, a task-local executable shim installed by the gateway or `farmslot-agent install-mark`.

Agents should use the task-local shim:

```bash
./mark start
./mark 1
./mark complete --mark-last
```

Do not hand-write `SIGNAL.json`. The runtime preserves pass-through fields, records checklist timing, verifies terminal artifacts, and writes the terminal status atomically.

## CLI

```bash
farmslot-agent install-mark <task-dir> --task TASK.md --signal SIGNAL.json
farmslot-agent mark <task-md> <signal-json> complete --mark-last
farmslot-agent artifact-check <task-dir> --require-recipe-quality-if-recipe
farmslot-agent recipe-quality build --input recipe-quality-input.json --output artifacts/recipe-quality.json
farmslot-agent contract resolve --flow fix-bug
```

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

The builder preserves additive metadata under `extra` while protecting the required protocol fields from being overwritten. Use `--input -` to read compact JSON from stdin.

## Compatibility

The previous script paths in `@farmslot/skills` and `scripts/quality/` remain compatibility shims for one migration window. New templates should point to `packages/agent-runtime/scripts/*` in the Farmslot monorepo or use `farmslot-agent` when installed as a package.
