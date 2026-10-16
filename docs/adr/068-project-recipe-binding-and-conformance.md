# ADR-068: Project recipe binding and conformance

**Status:** Accepted
**Date:** 2026-10-11
**Owner:** Farmslot maintainers
**Scope:** One recipe CLI, project providers, composed libraries, lifecycle, conformance and selected-flow admission
**Normative specification:** [Project recipe contract](../reference/project-recipe-contract.md)
**Related:** [ADR-034](034-recipe-protocol-v1.md), [ADR-035](035-node-support-bundles.md), [ADR-037](037-prepare-profiles.md), [ADR-049](049-agent-execution-template-selection.md), [ADR-058](058-static-review-and-farm-owned-qa.md)

## Context

Project runtimes, recipe graphs and project configuration already have owners. Different command wrappers currently resolve their inputs and lifecycle differently. A generic command must preserve project authorization, target selection, cleanup and evidence rather than introduce another executor.

The approved single-CLI migration has delivered project binding, static conformance, checkout execution and hosted execution. The remaining lifecycle, live-report, admission and cutover work has a prototype. This decision and its specification are Accepted; the remaining migration gates require implementation and independent validation. Existing prototype evidence does not establish completion of the migration.

## Decision

### Reuse three contracts

1. Project declaration uses `pack.json`, `project.json` and pool bindings. Pack installation and project behavior stay separate; machine-specific paths and device identities stay in pool/slot configuration.
2. A provider exports `createProvider(context)` and returns a project runtime, optional engine and owned cancellation/finalization callbacks. The shared engine remains the default.
3. Recipe libraries retain the existing manifest, ordered composition, dependency resolution and trust contracts.

The added data consists of one resolved binding and one revision-bound check report. Requirements and compatibility views are projections of those contracts. Existing gateway resource admission remains the authority for leases.

### One command and execution path

`farmslot recipe` owns checkout recipe operations. Root `farmslot doctor` owns installation, project readiness and conformance, with explicit switches separating repair from checks. The gateway invokes this CLI on the selected slot through existing transport, pool environment and closeout tracking.

Shared lifecycle handlers use provider options and runtime hooks. Project code supplies domain checks, presentation and owned companions. It does not copy doctor, process cancellation, graph execution or artifact validation.

### Scope proof to its inputs

The check report binds project, app, domain, runtime/target selection, checkout revision and dirty digest, executable provider/library/configuration identities, shared implementation identities and invocation parameters. Static evidence proves preflight. Live evidence adds an observed effect, an authored teardown assertion and verified artifact bytes.

HUD defaults on for targets that support it. Live proof retains observed behavior through a screenshot, recording or supported non-visual observation. HUD intent is recommended where supported; missing HUD alone MUST NOT invalidate evidence or require a rerun. The report records capture/HUD support explicitly; headless or opaque targets record unsupported with the reason. Handler availability alone cannot satisfy visual proof.

Only positive evidence establishes a capability. A missing, skipped, unsupported or failed required check never becomes success. A verified target does not certify another target or domain. Engine approval, project funding policy and gateway resource ownership remain separate from compatibility.

### Declare default static checks

A project may declare default conformance invocations in its existing recipe binding as `recipe.checks`. They name concrete recipe refs and optional parameter values. With no explicit recipe selection, doctor checks those invocations through the same complete preflight used by an explicit invocation. It does not treat the entire callable library catalog as a list of runnable default invocations.

Explicit recipe selection replaces these defaults. An absent default declaration requires an explicit selection; missing inputs, unavailable handlers and authorization failures remain failures. The report identifies only the invocations it checked. This default applies to direct static conformance, not selected-flow dispatch requirements or automatic resource acquisition. Live consent and proof-target selection remain explicit.

### Check the selected flow

Use ADR-049's selected execution-template entry and ADR-058's resolved QA preset. The template declares required smoke refs, action support and optional capture, HUD or resource providers. Parameter values use the existing CLI parameter grammar, with a template JSON object as data. The specification defines that proposed field before its implementation.

Static Review retains its independent template admission. Runtime requirements do not become a universal gate. Preview exposes missing requirements; execution rechecks after prepare against the frozen selected template before worker launch. A new static check must not overwrite retained live proof.

### Share capability decisions

`@farmslot/protocol` owns the pure requirement validation and compatibility projection. The gateway supplies current reports and existing resource-catalog facts. Command Center renders the resulting data; a future Companion renderer consumes the same model.

The conformance view explains registration and checked recipe support for a selected flow. The existing resource-capabilities panel owns lease acquisition, health and release. Keep that resource controller; reuse the conformance renderer wherever the same conformance job is shown. Clients must not duplicate badge or admission derivation.

### Preserve project log views during lifecycle migration

The shared logs handler owns target/source selection, argument validation, raw output, JSON envelopes and cancellation. Optional `ProjectProvider.commandOptions.logs` callbacks supply the existing project compact view and owned-window recovery. A project provider reuses its existing log viewer and session resolver through asynchronous helpers; it does not dispatch to its old CLI or copy the handler into the framework.

This restores compact follow, event-count/environment precedence and window recovery without changing launch/watch consumers of the same provider helper. The final Phase 3 cutover must still move generic viewer/session mechanics to shared packages, migrate every launcher/injected consumer, and delete the old command glue. These callbacks do not exempt provider code from that deletion gate.

### Cut over only after equivalence

Use the approved plain names in documentation: ProjectRuntime, ActionCatalog, ActionHandler and RecipeEngine. Rename the current SDK types and all consumers together during cutover, without compatibility aliases or unrelated wire/action-ID renames.

Every removed command, flag, export, check, environment variable and script needs a new home with argument mapping, or evidence that it is unused. Compare the old invocation with its replacement on the same project and target. Golden changes alone cannot establish runtime equivalence.

## Public surface

The [specification's Public surface](../reference/project-recipe-contract.md#public-surface) inventories flags, exports, stability and named consumers. The command families are:

| CLI                                                          | Consumer                                              |
| ------------------------------------------------------------ | ----------------------------------------------------- |
| `farmslot recipe status`, `launch`, `reload`, `stop`, `logs` | Operators, pack lifecycle hooks and workflow skills   |
| `farmslot recipe actions`, `call`, `run`                     | Operators, project libraries and gateway execution    |
| `farmslot recipe artifacts`                                  | Review/evidence consumers                             |
| `farmslot doctor` with readiness, conformance and live modes | Operators, project health hooks and gateway admission |

| SDK/package                    | Surface and consumer                                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@farmslot/adapter-sdk`        | Runtime lifecycle, ActionCatalog, readiness and optional recorder hooks, implemented by project providers                                         |
| `@farmslot/recipe-cli/harness` | Binding/provider host, shared lifecycle handlers, report checking and journal readers, consumed by the public CLI and project harness composition |
| `@farmslot/recipe-runner`      | Existing graph/library/authorization contracts, ActionHandler and contained artifact digest helper, consumed by the engine and evidence validator |
| `@farmslot/protocol`           | Report, selected requirements, compatibility model and positive-evidence predicate, consumed by the gateway and thin clients                      |

Project providers retain funding authorization, device targeting, collector cleanup, fixture repairs, plugin policy and closeout in its provider/engine/actions. Other harnesses inherit the same command mechanics and add only their project behavior. Provider command metadata extends strict parsing before factory effects; configured or operator-authorized sources remain required before executable imports.

Published schema-v1 artifacts remain schema-v1 only for additive changes. Semantic incompatibility requires an explicit schema/version transition. Pre-1.0 SDK additions and the coordinated type rename require minor releases, updated exact consumer pins and registry-only package checks. Each release set requires its own approval and exact reviewed release commit. Proposed surfaces are not stable published APIs until that release completes.

## Alternatives considered

- A new generic engine or fourth integration contract would duplicate the existing runner/SDK and split authorization.
- Keeping per-project command glue would preserve divergent defaults and cleanup.
- A global compatibility level would combine unrelated claims and incorrectly block static work or authorize untested targets.
- Manifest-only admission would not establish executable handler coverage or complete dependency authorization.

## Validation and rollout

Retain baselines, then validate direct and hosted execution, lifecycle and live checks before deletion. The normative specification names the project/target matrix, signal/refusal checks, tutorial gate and source-to-package checks. UI fixture rendering is useful evidence for its renderer; it cannot stand in for a real farm dispatch.

Unresolved rollout gates remain explicit: target readiness, provider ownership transfers, real dispatch, release approval and installed fleet acceptance. Publication and deployment do not follow from this Proposed document or from a passing static report.

## Amendment 1: Initial resource proof requirements, 2026-10-13

**Status:** Accepted, approved 2026-10-13. The accepted base decision remains unchanged. Implementation and shipping PR are pending.

### Decision

The selected execution template may carry `runtime_capability_requirements`, a quoted JSON array of the existing `RuntimeCapabilityProofRequirement` from `@farmslot/protocol`. The canonical `recipeFlowRequirements` accessor exposes it as `RecipeFlowRequirements.proofRequirements`. `runtime_capabilities` remains the list of required provider IDs; the new metadata supplies their authored reason, state/visual/mixed mode and optional acquire parameters. It does not reuse smoke inputs from `recipe_params`.

Read-only admission validates the declaration and explains missing initial proof modes. When a run owner exists, admission must consult its valid stored plan before reporting a mode as missing, including warm/nudge reuse of an IDs-only declaration. After prepare, ADR-065's existing consumer supplies these requirements to the existing posture/registry path. For an already authored run plan, retain its validated requirement and explicit retarget parameters instead of replacing them with template defaults. A conflicting mode or malformed plan refuses; defaults do not weaken an authored requirement. The normative [initial resource requirements](../reference/project-recipe-contract.md#initial-resource-proof-requirements-amendment-1) section defines coverage, validation and precedence.

### Rationale

A first dispatch has no stored proof plan. Provider IDs alone cannot tell enforcement whether the task needs state, visual or mixed proof. Reusing the existing requirement type supplies that missing input without guessing from capture flags, resource names or smoke parameters.

### Consequences and public surface

ADR-068 owns template metadata, the protocol accessor, read-only admission and capability display. ADR-065's owner consumes that contract for acquisition, health, cleanup and recovery. Provider schemas, slot/device-target validation, authority and ownership remain in the existing catalog/registry path. No second proof-plan store, allocator, parser for acquire semantics, CLI flag or SDK host callback is added.

The public addition is `RecipeFlowRequirements.proofRequirements` and the extended `recipeFlowRequirements`, owned by `@farmslot/protocol` and consumed by gateway admission and ADR-065 enforcement. Pack templates consume the metadata; thin clients consume the shared compatibility result. Project harnesses keep declaring provider schemas/actions and inherit dispatch mechanics. The pre-1.0 protocol addition requires a minor release and coordinated consumer pins under the existing release gates. IDs-only retained runs remain recoverable through their valid stored plans; IDs-only first dispatch without an authored mode refuses explicitly. Declaration availability is not acquired ownership or live proof.

## Amendment 2: Built-in bridges, 2026-10-14

**Status:** Proposed. The accepted base decision and Amendment 1 remain unchanged.

### Decision

Extend the existing SDK runtime's `harness` declaration with an explicit `kind: 'built-in'` for a bridge shipped in the application. It retains real bridge verification and has no checkout-overlay installer or cleanup leaf. The existing overlay contract retains its install, cleanup and verify requirements; an omitted kind still denotes that contract, never a built-in bridge inferred from missing fields.

The SDK validates the declaration through its existing adapter registration path. Shared default healing skips overlay installation only for an explicit built-in bridge or the existing headless exemption. It does not claim that the app is ready. The normative [bridge installation contract](../reference/project-recipe-contract.md#bridge-installation-proposed-amendment-2) defines commands, validation and rollout.

### Rationale

A bridge compiled into an app needs no generated overlay, delegate stamp or installation script. Treating every UI runtime as an overlay makes default run/call dereference nonexistent installer fields. Dummy installers, marking a UI runtime headless, or silently disabling healing would conceal the missing distinction.

### Consequences and public surface

`@farmslot/adapter-sdk` owns the additive `AdapterHarness` declaration and validation through existing `defineAdapter` and registry registration. Audiolab's provider consumes the built-in form; existing overlay providers retain their behavior. `@farmslot/recipe-cli/harness` consumes it in healing and existing install/cleanup helpers. Public `farmslot recipe run`, `call`, `launch --verify` and doctor use the same provider; no command, flag, recorder or evidence model is added.

Built-in install/cleanup reporting means no overlay operation is needed, not that verification passed. App lifecycle, resource ownership, cancellation, HUD, capture and evidence requirements remain unchanged. Existing overlay files are not deleted by selecting built-in mode.

This is a pre-1.0 SDK/CLI addition requiring a coordinated minor release, exact provider dependency pins and installed-host qualification. The SDK ABI and artifact schema versions do not change; older hosts are not qualified to consume the new declaration. Implementation and publication are separate gates after amendment approval.

## Amendment 3: Shared task, review and quality commands, 2026-10-15

**Status:** Accepted by the lead under delegated amendment authority, 2026-10-15. Design: [#1130](https://github.com/deeeed/farmslot/pull/1130). Implementation: [#1136](https://github.com/deeeed/farmslot/pull/1136). The base decision and Amendments 1–2 remain unchanged.

### Decision

Move the remaining referenced helpers onto `farmslot`: task initialization, identity verification, marking and closeout share `task`; review checklists and domain selection share `review`; recipe quality uses `recipe quality`. Reuse the existing task producer, checklist marker, quality builder and template/library resolution. Providers supply project gates and rule data through `ProjectProvider.commandOptions`.

The shared task producer owns the migrated pin operation and retains every frozen CLI, implementation, provider, library and configuration input. Task provenance records the CLI identity separately from its resolved provider and libraries. Marking and closeout verify that identity and preserve the selected task's gates. Moving a caller cannot weaken its completion requirements or replace retained provenance.

### Rationale

Deleting project command glue while these callers remain would remove working behavior or bypass project gates. Keeping generic mechanics in each provider would retain the duplication this migration removes.

### Consequences and public surface

The [helper cutover specification](../reference/project-recipe-contract.md#shared-helper-commands) defines the routes, package owners and equivalence checks. Existing bindings, artifacts, resource authority and engine behavior remain in force. Additive public APIs require reviewed minor releases and coordinated consumers. Each old route is removed only after its callers and behavior have a proven replacement.

## Amendment 4: Authored task Markdown, 2026-10-16

**Status:** Accepted by the lead under delegated amendment authority, 2026-10-16, at content snapshot `2a38e98a81bc8db246997ebb86b97cfe1e3517f6`. Implementation: [#1173](https://github.com/deeeed/farmslot/pull/1173). Earlier decisions retain their status.

### Decision and rationale

Complete Amendment 3's `pr-body render` mapping through `farmslot recipe artifacts <task> --format markdown`. Move the existing renderer into the shared recipe CLI. Preserve authored prose, checklists, generated validation sections and selected-attempt provenance, including static tasks without a run. A filename listing alone does not replace this behavior.

Rendering reads existing evidence. It does not execute recipes, validate publication policy, approve a report or create proof. Explicit output writing remains separate from artifact validation and must not overwrite authored inputs or retained evidence.

### Public surface and consequences

The [authored Markdown specification](../reference/project-recipe-contract.md#authored-task-markdown) defines `--command`, `--out`, JSON metadata and the shared `@farmslot/recipe-cli/harness` renderer. Named consumers are the root CLI, gateway publication renderer, project pack commands and recipe PR-description skills. Providers contribute project data rather than another renderer.

Publish the additive SDK export in a reviewed pre-1.0 minor release. Migrate callers with their argument mapping before deleting the old renderer and route. No compatibility shim, artifact schema, evidence writer, execution engine or resource authority is added. Content approval precedes implementation in the same caller-parity PR.

## Amendment 5: Hosted task initialization, 2026-10-16

**Status:** Accepted by lead amendment authority, 2026-10-16. Implementation: [#1186](https://github.com/deeeed/farmslot/pull/1186). Earlier decisions retain their status.

### Decision and rationale

Complete Amendment 3 on the hosted path. The execution node's immutable Farmslot CLI initializes the task through the existing shared producer, retaining its own implementation and the selected project tooling before emitting a marker. The gateway supplies task data and mirrors the result; it cannot pin its own installation for a different node or regenerate the marker from current pool defaults.

Retain the provider's owning tooling workspace and its declared installed dependencies separately from the recipe library root. Sibling imports and local dependency links must remain usable from the retained copy without changing bundled recipe discovery or freezing the product checkout.

Migrate every active consumer before enabling the hosted cutover, then delete the replaced producer. Every pack consuming that producer is included. There is no project opt-in, compatibility shim or fallback to an unfrozen task. Existing tasks retain their original tooling and evidence.

### Public surface and consequences

The [hosted task specification](../reference/project-recipe-contract.md#hosted-task-initialization) defines node-local initialization, private transport, static-task boundaries and retries. The root CLI and gateway consume the existing `@farmslot/agent-runtime` task producer and `@farmslot/recipe-cli/harness` binding/verifier APIs. No second installer, task store, engine, writer or recorder is introduced. Content approval precedes implementation in this same PR.

## Amendment 6: Provider operations without a provider binary, 2026-10-17

**Status:** Proposed. Acceptance follows paired review and lead approval under delegated amendment authority. Earlier decisions retain their status.

### Decision

Finish the Phase 3 disposition so a project provider ships no binary, public or internal. Every remaining operation reaches the provider through `farmslot`:

1. **Overlay verification.** Plain `farmslot doctor` runs the selected runtime's declared `harness.verify` as its `overlay` check. That verifier is read-only and non-launching. It may observe a runtime that already exists, but never navigates, repairs or executes actions.
2. **End-to-end proof.** A provider proves itself through the public host, not through an executable copied into the checkout. Live end-to-end checks that drove an installed runner use the shared paths instead: `recipe launch --verify` for readiness, the provider's action manifest, and `doctor --conformance --live` for the declared smoke. The overlay installs bridge files only.
3. **Overlay removal.** `doctor --remove-overlay` runs the runtime's existing cleanup leaf under the checkout lock. Root doctor already owns overlay installation and repair; removal joins them as one more explicit switch.
4. **Runtime-free actions.** An action manifest entry may declare `runtime: "none"`. When every action in a resolved call or graph declares it, the host executes without healing, attaching, launching or capturing a runtime. All other authorization and lifecycle contracts still apply. Fixtures, Runway provisioning, Extension target resolution, viewer stop, the diff check and setup steps become such provider actions.
5. **Template materialization.** Root `execution-template` gains the standalone selection that `mm-harness execution-template` provided: domain sources, exact id, JSON output and `materialize`. It delegates to the same ADR-049 selector. This replaces ADR-049's provider command boundary.
6. **Provider guidance.** `farmslot recipe --help` appends the resolved provider's versioned guidance, as `recipe quality` already does.

All other remaining commands map to existing surfaces, listed in the [specification](../reference/project-recipe-contract.md#provider-operations-without-a-binary-amendment-6). Pack runner hooks for projects with a `recipe` binding are already superseded: since #936 the gateway builds the `farmslot` commands itself. The `recipe_harness_*` hooks have no consumer. The eval-harness lifecycle that runs them needs a source containing `scripts/recipe-harness.sh`; the Core and Mobile catalogs name a path deleted from MetaMask/skills, and the provider ships no such script. Packs delete both kinds of hook.

### Rationale

ADR-068 already states that one CLI owns checkout operations, so no project keeps per-project command glue. Leaving one internal runner binary would keep a second entry point with its own argument parsing and version drift. It would also keep verification proving a copied runner instead of the provider that callers actually use. A runtime-free declaration is needed because setup and resolution actions currently require a launched app before they can run, which is the wrong order.

### Consequences and public surface

`@farmslot/protocol` owns the optional `runtime` action declaration and its validator. `@farmslot/adapter-sdk` carries it in `ActionCatalog`. `@farmslot/recipe-cli/harness` consumes it in call/run/conformance, owns overlay removal and adds the help guidance option. `@farmslot/agent-runtime` keeps the template selector. The named consumers are pack cleanup, setup and fixture scripts, the Extension and Mobile providers, and the Skills recipe-cook template scripts. No engine, recorder, evidence writer, resource allocator or compatibility alias is added.

These are pre-1.0 minor releases with coordinated pins. The provider adopts them and every caller moves before the binary and its glue are deleted, as in the base decision's equivalence rule. Implementation PRs follow content approval.
