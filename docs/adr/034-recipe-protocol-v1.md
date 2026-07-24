# ADR-034: Recipe Protocol v1

- Status: Accepted
- Date: 2026-04-29
- Updated: 2026-07-22

## Context

Farmslot needs one deterministic proof contract across backend, browser, mobile, native, and CLI projects. Project-specific scripts alone do not give reviewers a shared graph, trace, trust, or artifact model.

## Decision

Recipe Protocol v1 defines two public concepts:

1. **Action** — one atomic capability implemented by a runner.
2. **Recipe** — one parameterized executable graph that can run directly or be called by another recipe.

`workflow` is the recipe's graph field. It is not a separate reusable artifact.

The canonical specification is `docs/reference/recipe-protocol-v1.md`; the published JSON Schema is `https://farmslot.io/schemas/recipe-v1.schema.json`.

## D-034-01: One document and executor

Root and called recipes use the same schema, validator, parameter resolver, graph executor, observer behavior, HUD path, nested trace, and evidence rules.

Every recipe may declare `paramsSchema`. Defaults apply before validation and explicit values win. Direct runs accept `key=value`; nested calls pass `call.params`.

## D-034-02: Static composition

A `call` node references another recipe by a static id. The complete transitive graph resolves before side effects. The runner rejects missing or dynamic refs, duplicate ids, cycles, excessive depth, unsafe source paths, and invalid adapter variants.

Direct `run` and nested `call` use the same ordered recipe index. The first source wins and lower-priority matches remain visible as shadows.

## D-034-03: Projects extend through actions and recipes

Farmslot owns graph execution, static resolution, trust, trace, and artifact contracts. Projects own namespaced action implementations and libraries of parameterized recipes.

Libraries contain `recipes/` and may add runner-owned manifests/actions. Recipe
identity derives from the path; provenance names come from the configured alias
or directory. Adapter suffixes `.core`, `.extension`, and `.mobile` select
variants without changing the id.

Prefer parameters over near-duplicate recipes. Add reusable recipes only when they reduce repeated inference or enforce a safety invariant.

## D-034-04: Exact evidence

Each run retains:

- the authored root as `recipe.json`;
- every reachable dependency as `resolved-recipes/<sha256>.recipe.json`;
- `recipe-resolution.json` with root/dependency digests, selected sources, adapter variants, and call edges;
- summary, trace, and typed artifact manifest.

Artifact validation applies the same Recipe v1 validator to every document and verifies exact digests, edges, reachability, and file presence.

## D-034-05: Transitive trust

The execution approval binds the root and every reachable recipe digest/source, action implementations, environment, project root, and artifact destination before any side effect. A caller cannot gain capabilities through a dependency.

## D-034-06: Proof semantics

Recipes are directed graphs, not linear scripts. Setup, start state, branching, assertions, proof media, and teardown remain in one trace and artifact package. An idempotent `ensure_*` recipe proves convergence with ordinary read/assert nodes.

## Consequences

- Agents learn one reusable executable artifact.
- Teams can share parameterized libraries without growing the base harness indefinitely.
- Evidence remains reviewable without access to the original library.
- Project runners stay thin and domain-owned.
- Simple recipes remain valid without composition or visual evidence.
