# ADR-034: Recipe Protocol v1

- Status: Accepted
- Date: 2026-04-29
- Updated: 2026-10-19

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
scaffold re-exports. Project harnesses inherit runner/adapter policy
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

## Amendment 3 (2026-10-13): Shared HUD placement

**Status:** Accepted, authorized 2026-10-12.

### Decision

Honor existing `app.hud` `display.position` values `top` and `bottom` across
browser and native adapters. Placement persists through automatic progress,
screenshots and the final outcome within one execution. A later execution starts
with its configured defaults. Existing corner positions retain their vertical
edge on native targets. Omitted placement preserves each adapter's default.
HUD updates acknowledge after the caption paints, before capture or recorder
stop. One shared paint wait serves browser and native renderers; recording clocks
and marker contracts remain unchanged.

### Rationale and consequences

A required HUD can cover the application control being checked. Moving it to the
opposite edge preserves visible proof without clearing the HUD. Native rendering
clears the opposite anchor and respects safe areas; existing panel bounds,
isolation and required evidence rules remain. Harnesses forward placement to the
shared renderer and add no renderer of their own.

### Public surface

Recipes use `app.hud` with `display.position`; SDK runner callers use existing
`RecipeHudOptions.display.position`. The additive `hudPlacement` helper in
`@farmslot/protocol/recipe` normalizes the vertical edge for the shared native
bridge and web adapter. There is no new CLI flag or command. Supporting package
versions and consumers' action catalogs move together.
`waitForHudPaint` in the same package lets native bridges and thin browser
renderers acknowledge painted captions without a fixed sleep.
Native bridges use `useRecipeHudState` from `@farmslot/adapter-rn/recipe-hud`
to await the React commit before that paint wait. Companion and scaffold providers
consume the same hook; CLI users need no native peer.

### Verification

One recipe moves the HUD from bottom to top, checks that application footers
remain visible, captures both placements, and records the final HUD before stop.
Automatic updates preserve placement; a second execution restores its default.

## Amendment 4: enabled-state waits (2026-10-12)

**Status:** Accepted, approved 2026-10-13. **Shipping PR:** Pending.

### Decision

Add optional boolean `enabled` to the existing `ui.wait_for` contract. It combines an explicit presence/visibility expectation with one control's observed state. Missing controls cannot satisfy disabled; duplicate targets and unqualified native state refuse. Protocol validation rejects the `visible`/`hidden` aliases for this new predicate so all backends receive explicit `expected`. Existing calls without the field retain their behavior.

Extend existing shared CDP and native-accessibility wait paths. MetaMask Mobile selects its existing native transport for enabled waits, including on debuggable builds; Extension uses shared CDP. Native state requires qualified backend provenance because an upstream accessibility fallback may synthesize a true value. The [normative specification](../reference/recipe-protocol-v1.md#amendment-4-enabled-state-waits) defines inputs, refusal, cancellation and validation.

### Rationale

A refused press or screenshot alone does not provide an executable disabled-state assertion. Ranked locator discovery is bounded and may default unknown fields; it cannot supply durable state proof for a specific control. Reusing the existing action and transports avoids another provider-specific polling or fiber-walking implementation.

### Consequences

Providers advertise the optional field only after pinning supporting releases. Mobile and Extension are the first consumers; unsupported catalogs continue to reject it. No UI mutation or recovery is allowed to make the predicate pass. ADR-062 assertion eligibility and visual-review requirements remain unchanged. Live controls in both states, contrary-state failure, cleanup and HUD evidence are required before implementation acceptance.

### Public surface

`farmslot recipe run` and `farmslot recipe call ui.wait_for` consume the existing action with `enabled`; no action name or CLI flag is added. `@farmslot/protocol` owns validation, `@farmslot/recipe-runner` owns CDP execution and extends its existing exported wait options, and `@farmslot/adapter-rn` owns native execution. No new SDK callback or evidence format is introduced. MetaMask supplies product identity/native routing and manifest/dependency pins. This additive action extension requires supporting package releases before provider advertisement.

## Amendment 5 (2026-10-13): File-content proof assertions

**Status:** Accepted, approved 2026-10-13. **Shipping PR:** Pending.

### Decision

An executed `assert_file` with a non-empty resolved `contains` expectation may
prove a state claim about that file's contents. Its own file read is the
observation. An existence-only check remains ineligible for claim proof.

Reuse ADR-062's assertion, observation, occurrence and verdict contracts. Retain
the checked path, text expectation and match outcome from the executed read;
derive the verdict through the shared assertion reducer. A skipped node,
unreadable file or absent expectation cannot manufacture proven evidence.
Existing failure classification and visual-review requirements still apply.

### Rationale and consequences

Non-UI criteria need an executable check of the claimed behavior. Test-command
exit codes and captured log output already use `command` followed by
`assert_output`. File-content claims should also use the existing `assert_file`
action without a second ledger writer or evidence format. A file assertion
certifies its content check, not a visible UI outcome or a command's success.

### Public surface

The existing `farmslot recipe run` and `farmslot recipe call assert_file` consume
the existing `path` and `contains` fields. No action name or CLI flag is added.
`@farmslot/protocol` owns the shared assertion policy;
`@farmslot/recipe-runner` owns execution-bound eligibility and derived evidence.
SDK, hosted CLI and provider consumers inherit that path. Supporting packages
must ship together before adopters rely on file-content claim proof.

The [normative rule](../reference/recipe-protocol-v1.md#amendment-5-file-content-proof-assertions)
and the existing recipe guide define authoring and conformance. P2/P5 proof on
one UI and one non-UI ticket per pack precedes the normal-writer cutover.

## Amendment 6 (2026-10-19): Library action declarations

**Status:** Accepted, approved 2026-10-19. **Shipping PR:** [#1327](https://github.com/deeeed/farmslot/pull/1327).

### Decision

A runtime's action catalog takes official actions and observers only from
manifests the runtime owns: its own manifest, the bundled library's manifests
and an explicitly selected task action manifest. A library selected as a
source, and a parent runtime's manifest from such a library, may add namespaced
custom actions only.
The catalog refuses a library manifest that declares an official action or any
observer, instead of letting first-source precedence replace the runtime's
declaration or add an observer to every run.

A task action manifest keeps its implementations where a library does: in
`<root>/actions`, where `<root>` is the directory that holds the manifest, or
its parent when that directory is `manifests/`. An explicit task action root
still wins.

### Rationale and consequences

First-source precedence suits custom actions: a team library may override a
lower-priority custom action, and the shadow stays visible. It does not suit
official actions or observers. An official action's declaration is the
runtime's contract for a capability the protocol names, and a library that
redeclares it changes the schema the runner validates against. An observer
runs around every node it applies to, so a library observer would run library
code on nodes the library did not author. Libraries still call official actions;
they cannot redeclare them.

The task root follows the library layout, so a task laid out like a library
needs no extra setting and its action files are covered by its digest. Before,
a task manifest in `manifests/` resolved its actions inside `manifests/`, where
no action tree lives.

### Public surface

No action, flag or error code is added; a refused manifest reports
`ACTION_MANIFEST_INVALID` with the action or observer it declares. The shared
runtime catalog applies the rule for every provider that uses it; a provider
that resolves its own catalog applies the same rule. Discovery listings still
show every declaration. The [normative rule](../reference/recipe-protocol-v1.md#amendment-6-library-action-declarations)
defines the refusals and the task root.

## Amendment 7 (2026-10-20): HUD readability

**Status:** Accepted, approved 2026-10-20 (lead, for Arthur). **Shipping PR:** Pending.
**Specification:** [Intent and HUD policy](../reference/recipe-protocol-v1.md#intent).

### Decision

The current intent is the HUD's main line, with no status badge. Web and CDP
renderers draw it at 16px on a 20px line, weight 600, in a 500px card bounded by
the viewport. A 120-character intent fits in three lines. Web renderers never
clamp, ellipsize or clip the intent; the panel grows instead. A finished run's
main line reads `Recipe passed` or `Recipe failed` in the outcome colour.

Below it, one muted 11px line shows the step that just finished: `✓ intent`, or
`✗ intent` in red for a failure. A passed step that is still the main line is
not repeated. Only this line may ellipsize. Progress becomes small muted `N/M`
text; error and detail lines stay small and clamp at two lines.

Native panels keep their 360 by 88 bounds and the two-line intent limit. The
intent takes the full width at 13px on a 17px line. The finished line (10px) and
`N/M` share one row, drawn only while padding, two intent lines, that row and an
error line fit 88 points. A caller-supplied badge still renders.

### Rationale and consequences

In a TAT-4145 Terminal recording at step 53/62, the HUD text was small, the RUN
and PASS rows had equal weight, and the intent was cut with an ellipsis. A
reviewer needs the current intent first and whole; the previous step is context.
Mobile screens have little room, so native gains hierarchy, not size. Web panel
heights become nominal, not clips.

### Public surface

`@farmslot/protocol/recipe` adds the HUD font, line-height and colour constants
and `hudFinishedLine`. `HUD_INTENT_MAX_LINES` becomes a nominal 3 for web, and
`HUD_NATIVE_INTENT_MAX_LINES` keeps native at 2. The web-dapp HUD, the CDP
`app.hud` renderer and `@farmslot/adapter-rn/recipe-hud` follow the rule. No
action, flag or recipe schema changes.
