---
title: Recipe Runner Protocol
---

# Recipe Runner Protocol

The runner connects [Recipe Protocol v1](./recipe-protocol-v1.md) to a project's real runtime.

## Contract

| Piece            | Responsibility                                                       |
| ---------------- | -------------------------------------------------------------------- |
| Recipe           | Parameters, executable workflow, optional proof targets and teardown |
| Action manifest  | Strict action schemas, examples, result cases, capabilities          |
| Adapter          | Runtime implementation for one declared action                       |
| Library          | Named and adapter-specific recipes                                   |
| Runner           | Validation, static resolution, trust preflight, execution            |
| Artifact package | Exact recipes, provenance, trace, verdict, and proof                 |

Projects own namespaced actions and recipe libraries. Farmslot owns the graph, trust, trace, and artifact contracts.
Action manifests use `https://farmslot.io/schemas/action-manifest-v1.schema.json` for editor validation.

## Discovery

```sh
farmslot-recipe run --list --adapter <adapter> --json
farmslot-recipe run <recipe> --describe --adapter <adapter> --json
```

List output stays compact and exact recipe detail expands only when requested. Action discovery belongs to the project runner because manifests and adapters are project-owned.

## Execution

Before side effects, the runner validates the root, resolves the complete static call graph, applies and validates parameters, checks manifests and capabilities, and binds trust approval to the exact plan.

Adapters return `case`, `output`, `artifacts`, and `observations`. Recipes own routing and status. Declared teardown runs after main success or failure.

## Evidence

Every run retains:

```text
recipe.json
recipe-resolution.json
resolved-recipes/<sha256>.recipe.json
summary.json
trace.json
artifact-manifest.json
```

Package validation revalidates every recipe, digest, call edge, and artifact. Missing evidence never becomes a passing claim.

Failed trace entries carry one explicit `cause_class`: `subject`, `harness`,
`environment`, or `unknown`. Successful entries omit it. `summary.json` retains
all four cause counts, and package validation requires them to reconcile with
the trace.

## Suite evidence

Multi-run coverage uses standalone Recipe Suite Scope v1 and Recipe Suite
Result v1 documents. A scope freezes a non-empty set of opaque case IDs before
execution. Its result must resolve every ID exactly once with either a retained
run-summary verdict or an explicit non-execution reason.

Suite validation checks the canonical scope digest, summary digests and
statuses, exact totals, safe paths, ordering dependencies, and completeness.
`oversight` keeps an omission machine-readable but makes the suite invalid. The
harness finalizer aggregates completed runs; it does not schedule or retry them.

## Command Center replay options

Command Center renders the same live trace and artifact package as the CLI. It is not a second executor. Optional video capture is capability-bound, stored under the artifact root, and indexed in the manifest.

For onboarding, see [Headless Recipe integration](../guides/headless-recipe.md) or [Expo / React Native project integration](../guides/expo-project-integration.md).
