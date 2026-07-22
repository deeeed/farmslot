# Recipe harness: high-level map

The recipe system gives humans and agents one deterministic way to prepare a runtime, exercise behavior, and retain proof.

## Public concepts

- **Action:** one atomic capability supplied by a runner, such as `ui.navigate`, `command`, or `metamask.wallet.ensure_unlocked`.
- **Recipe:** one parameterized graph of actions. A recipe can run directly or be called by another recipe.

There is no separate reusable flow artifact. `workflow` is simply the graph inside a recipe.

## Fast discovery

Use progressive disclosure:

```sh
mm-harness run --list --json
mm-harness run <closest-recipe> --describe --json
mm-harness actions <task-term> --json
mm-harness actions --action <exact-name> --json
```

The list and search commands stay compact. They provide enough information to select a recipe or action. Exact detail adds schemas and runnable examples only when authoring needs them.

## Execution

```text
recipe + parameters
        │
        ▼
validate document and action manifest
        │
        ▼
resolve complete static call graph
        │
        ▼
bind trust approval to exact digests and context
        │
        ▼
execute main graph ──► guaranteed teardown
        │
        ▼
validate trace, provenance, and artifacts
```

Every non-terminal node carries a short human-facing `intent`. Actions return outputs, observations, artifacts, and an optional declared result case. The recipe alone owns routing and final status.

## Evidence

Every run retains the authored root, exact resolved dependencies, resolution provenance, summary, trace, and artifact manifest. Visual claims require visual evidence; runtime claims require live runtime evidence. Tests may corroborate but do not replace real-app proof.

## Ownership

| Layer              | Owns                                                                  |
| ------------------ | --------------------------------------------------------------------- |
| Farmslot protocol  | Recipe schema, graph semantics, validation, trust, evidence contracts |
| Recipe harness     | Resolution, execution, trace, artifacts, generic actions              |
| Project runner     | Platform adapters and namespaced product actions                      |
| Team library       | Reusable domain recipes and safe defaults                             |
| Product repository | Product behavior, fixtures, native tests, telemetry                   |

Keep domain knowledge in team libraries. Add a base action only when it is atomic, broadly useful, and materially reduces repeated inference.

## Canonical references

- [Recipe Protocol v1](recipe-protocol-v1.md) — authored document contract.
- [Recipe Runner Protocol](recipe-runner-protocol.md) — project integration contract.
- [Recipe harness architecture](recipe-harness-architecture.md) — component boundaries.
- [New project recipe support](new-project-recipe-support.md) — minimal onboarding checklist.
