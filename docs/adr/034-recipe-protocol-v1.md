# ADR-034: Recipe Protocol v1

**Status:** Accepted
**Owner:** Arthur / Farmslot
**Last updated:** 2026-05-30
**Stale by:** 2026-08-30
**Relates to:** [ADR-019](019-recipe-graph-visualization.md), [ADR-026](026-self-improvement-recursive-loop.md), [ADR-030](030-replay-provenance-and-reference-evals.md), [Recipe Protocol v1 Spec](../reference/recipe-protocol-v1.md), [Generic Recipe Protocol v1 PRD](../plans/generic-recipe-protocol.md)

## Context

Farmslot has converged on recipe-driven validation as the evidence substrate for project work, replay, self-validation, and run-family comparison. Several docs and project implementations already use the `validate.workflow.entry` + `nodes` graph shape, but the architecture has not had one decision that names Recipe Protocol v1 as the shared product-level contract.

ADR-019 accepted recipe graph visualization: Farmslot can render a recipe graph for reviewers. That decision intentionally stayed UI-only. It did not decide the full protocol boundary: graph schema, runner contract, action manifests, flow catalogs, start-state convergence, proof-target mapping, trace, artifact manifests, or proof-window evidence.

This ADR establishes Recipe Protocol v1 as that architecture. The detailed field-level contract lives in [Recipe Protocol v1](../reference/recipe-protocol-v1.md).

## Decision

Recipe Protocol v1 is the shared Farmslot contract for executable validation recipes. It standardizes graph orchestration, runner boundaries, action/flow extension, trace, artifact manifests, and evidence phases while preserving the original recipe intent: recipes are directed graphs, not linear scripts. Branching, setup convergence, reusable subflows, assertions, proof media, and teardown all remain part of one graph model and one final trace/artifact package.

The simple default is a flat `validate.workflow.entry` + `nodes` graph. A project can start there. When a recipe needs reusable setup, domain start state, or AC-specific proof boundaries, it uses the same v1 schema with these additive fields:

- `uses` — optional flow catalog references;
- `proofTargets` — optional AC/proof-target declarations;
- `startState` — optional named flow call that converges the app/project before proof begins;
- `call` — the canonical Farmslot action for invoking a named flow from a catalog;
- `phase` — optional node/flow phase: `setup`, `start_state`, `proof`, `assert`, or `teardown`;
- `proofTarget` — optional node/artifact mapping to one `proofTargets[].id`;
- `record` — optional recording/evidence policy: `none`, `trace_only`, `proof_window`, or `failure_only`.

The protocol owns graph execution, flow expansion, validation, nested trace shape, artifact indexing, and generic evidence policy. Project runners own domain flow catalogs. For example, Farmslot defines how to call a start-state flow; the Example App runner defines flows such as `example.wallet.ensure_unlocked` and `example.trade.start_state`.

## D-034-01: Adopt Recipe Protocol v1 as the canonical contract

Recipe Protocol v1 is the canonical contract for new Farmslot recipes. `docs/reference/recipe-protocol-v1.md` is the source of truth for schema, validation, trace, artifact package, runner, action manifest, and flow catalog details.

The protocol is progressive:

1. flat graph;
2. graph with `proofTargets`;
3. graph with setup/teardown phases;
4. graph with `uses` + `call` flow composition;
5. graph with `startState` and proof-window evidence.

## D-034-02: Keep the default easy

Flat recipes remain valid v1 recipes. Flow catalogs are optional. Backend/CLI recipes that only need one `command` and assertions do not need `startState`, `phase`, proof video, or domain flows.

When composition is needed, Recipe v1 uses the official `call` action. A `call` node composes another graph into the current graph by invoking a cataloged flow through `ref` and optional `params`:

```json
{
  "action": "call",
  "ref": "example.trade.start_state",
  "params": { "network": "testnet", "provider": "hyperliquid", "page": "positions" }
}
```

## D-034-03: Project extension uses actions and flow catalogs

Projects extend the protocol through namespaced actions and flow catalogs. Farmslot core must not encode project domains. Domain catalogs should stay small: prefer parameterized actions/flows over duplicate positive/negative, route-specific, or provider-specific variants.

An `ensure_*` flow is a recommended convergence contract for reusable setup: it inspects current state, performs only required transitions, and must prove a machine-checkable postcondition before returning success. Domain flows should avoid becoming opaque scripts; they should compose smaller contracts when practical.

## D-034-04: Evidence phases separate setup from proof

Setup and start-state work is always visible in `trace.json` and `summary.json`. Proof media defaults to the smallest user-visible interaction that proves the acceptance criterion.

Default record policy by phase:

| Phase         | Default `record` | Purpose                      |
| ------------- | ---------------- | ---------------------------- |
| `setup`       | `trace_only`     | Deterministic preparation.   |
| `start_state` | `trace_only`     | Converge to domain baseline. |
| `proof`       | `proof_window`   | User-visible AC interaction. |
| `assert`      | `trace_only`     | Settled-state verification.  |
| `teardown`    | `trace_only`     | Cleanup.                     |

A recipe may override `record` when setup itself is the claim.

## D-034-05: Validation is part of the protocol

A v1 validator must reject or warn on unresolved flow refs, missing catalogs, invalid params, recursive/cyclic calls beyond the allowed depth, output namespace collisions, invalid phases/record values, missing proof-target mapping for proof/assert/evidence nodes, missing evidence for visible proof targets, unproven `ensure_*` postconditions, and malformed nested trace/artifact links.

## Consequences

- `/recipe-cook` and `/recipe-quality` become authoring/review helpers over the protocol, not the protocol source of truth.
- Example App and other project runners can migrate task-specific validation into reusable domain start-state flows and concise AC proof flows.
- Command Center, eval packages, and replay tooling can reason about proof windows and setup trace consistently.
- Implementation should update the canonical spec, schema/types, validator, harness behavior, and examples before adding large project-specific flow catalogs.

## Non-goals

- Encoding Example App-specific flows into Farmslot core.
- Requiring flow catalogs for simple backend/CLI recipes.
- Requiring visual proof for non-visual jobs.
- Creating a new replay taxonomy outside ADR-030's result-package model.
