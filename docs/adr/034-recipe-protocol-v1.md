# ADR-034: Recipe Protocol v1

- Status: Accepted
- Date: 2026-04-29
- Updated: 2026-10-12

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
or directory. Canonical adapter variants live under
`recipes/<adapter>/<domain>/*.recipe.json` without changing the id. The older
`.core`, `.extension`, and `.mobile` filename suffixes remain readable only for
migration compatibility.

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

## Amendment 1 (2026-10-12): Bounded shared HUD intent

**Status:** Accepted
**Implementation:** Merged in [#944](https://github.com/deeeed/farmslot/pull/944).
**Specification:** [Intent and HUD policy](../reference/recipe-protocol-v1.md#intent).

### Decision

`@farmslot/protocol/recipe` owns one intent display model and authoring policy.
Native and thin DOM renderers consume that model, preserve the normalized intent,
and let platform layout wrap within two lines and bounded panels. One shared
native component lives in `@farmslot/adapter-rn/recipe-hud`, re-exported by
Companion and scaffold templates. The runner passes the complete normalized
intent to adapters. Existing placement, isolation, pointer pass-through,
status/progress and renderer extension points remain supported.

The existing CLI lint/conformance path opts into authoring checks: warn above
80 Unicode code points and fail above 120, counted after trimming. One plain
sentence is guidance, not a new grammar parser. Ordinary graph validation,
execution and retained-artifact verification retain their v1 behavior.

### Rationale

Different one-line and character-slicing policies cut useful intent and allow
HUD panels to obscure the checked application. One shared model and native
renderer prevent project-specific formatting drift.

### Consequences

Mandatory panel and line bounds apply after styling. Existing text/style,
overlay and custom `renderHud` options remain, with custom renderers adopting
the shared helper. CLI consumers need no native peers.
Framework examples adopt the authoring rule. Farm recipes are not rewritten;
copied project HUDs adopt the shared renderer through deliberate scaffold
updates rather than deployment overwrites. The specification retains exact
layout bounds, extension behavior and verification requirements.

### Public surface

Existing `farmslot recipe validate` and conformance validation consume the
explicit authoring option. `@farmslot/protocol/recipe` exports the shared display
helper/policy, consumed by the runner, web adapter and native renderer.
`@farmslot/adapter-rn/recipe-hud` supplies the native component to Companion and
scaffold re-exports. Harnesses including mm-harness inherit runner/adapter policy
and retain `app.hud` and custom rendering extension points. These are additive
package APIs; no command/flag or recipe wire/schema version changes.

## Amendment 2 (2026-10-12): Bounded log observations

**Status:** Accepted
**Implementation:** Merged in [#969](https://github.com/deeeed/farmslot/pull/969).
**Specification:** [Recipe log observations](../reference/recipe-log-observations.md).

### Decision

Extend the existing `watch_logs` action with optional `timeout_ms`. Omission or
zero keeps one immediate read. A positive bounded window polls read-only for the
authored condition; it never starts or repairs the producer. Preserve contained
reads, cancellation, run/file scope, output fields and failure classification.

The protocol owns input relationships. The shared runner owns resolved-invocation
preflight, pre-producer file offsets and polling. Run-scoped paths resolve from
inputs before producers execute; output-derived paths require explicit file
scope. Existing project lifecycle callbacks remain unchanged.

### Rationale

One immediate read misses asynchronous output that arrives just afterward.
Observing for a declared window proves the condition without confusing an
observation with a producer retry or accepting stale run content.

### Consequences

The optional window is a backward-compatible action extension that requires
supporting runtime dependencies. Refusing output-derived run-scoped paths is a
breaking correction to stale-content false passes. Project manifests and
protocol/runner dependency pins move together. MetaMask Core, Mobile, Extension
and web-dapp catalogs are the first consumers; Terminal inherits the web-dapp
catalog and adds domain actions. Recipes and `farmslot recipe call watch_logs`
use existing parameters. The specification owns timeout/poll bounds, preflight
and real-producer acceptance requirements. A merged implementation does not
record package publication or provider rollout.

### Public surface

`@farmslot/recipe-runner` owns action execution. Recipes and the existing
`farmslot recipe call watch_logs` consume the optional parameter through project
catalogs, whose provider/runner dependencies declare support. No SDK export,
CLI flag, new action or project lifecycle hook is added.
