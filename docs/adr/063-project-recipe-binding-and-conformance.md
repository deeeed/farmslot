# ADR-063: Project recipe binding and conformance

**Status:** Proposed
**Date:** 2026-10-11
**Owner:** Farmslot maintainers
**Scope:** One recipe CLI, project providers, composed libraries, lifecycle, conformance and selected-flow admission
**Normative specification:** [Project recipe contract](../reference/project-recipe-contract.md)
**Related:** [ADR-034](034-recipe-protocol-v1.md), [ADR-035](035-node-support-bundles.md), [ADR-037](037-prepare-profiles.md), [ADR-049](049-agent-execution-template-selection.md), [ADR-058](058-static-review-and-farm-owned-qa.md)

## Context

Project runtimes, recipe graphs and project configuration already have owners. Different command wrappers currently resolve their inputs and lifecycle differently. A generic command must preserve project authorization, target selection, cleanup and evidence rather than introduce another executor.

The approved single-CLI migration has delivered project binding, static conformance, checkout execution and hosted execution. The remaining lifecycle, live-report, admission and cutover work has a prototype. This Proposed decision and its specification require independent review and maintainer approval before further framework implementation. Existing prototype evidence does not establish completion of the migration.

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

HUD defaults on for targets that support it. Their live proof must retain a screenshot or recording of the proof step with its intent HUD visible, and live validation must check that evidence. The report records capture/HUD support explicitly; headless or opaque targets record unsupported with the reason. Handler availability alone cannot satisfy visual proof.

Only positive evidence establishes a capability. A missing, skipped, unsupported or failed required check never becomes success. A verified target does not certify another target or domain. Engine approval, project funding policy and gateway resource ownership remain separate from compatibility.

### Check the selected flow

Use ADR-049's selected execution-template entry and ADR-058's resolved QA preset. The template declares required smoke refs, action support and optional capture, HUD or resource providers. Parameter values use the existing CLI parameter grammar, with a template JSON object as data. The specification defines that proposed field before its implementation.

Static Review retains its independent template admission. Runtime requirements do not become a universal gate. Preview exposes missing requirements; execution rechecks after prepare against the frozen selected template before worker launch. A new static check must not overwrite retained live proof.

### Share capability decisions

`@farmslot/protocol` owns the pure requirement validation and compatibility projection. The gateway supplies current reports and existing resource-catalog facts. Command Center renders the resulting data; a future Companion renderer consumes the same model.

The conformance view explains registration and checked recipe support for a selected flow. The existing resource-capabilities panel owns lease acquisition, health and release. Keep that resource controller; reuse the conformance renderer wherever the same conformance job is shown. Clients must not duplicate badge or admission derivation.

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

MetaMask retains funding authorization, device targeting, collector cleanup, fixture repairs, plugin policy and closeout in its provider/engine/actions. Other harnesses inherit the same command mechanics and add only their project behavior. Provider command metadata extends strict parsing before factory effects; configured or operator-authorized sources remain required before executable imports.

Published schema-v1 artifacts remain schema-v1 only for additive changes. Semantic incompatibility requires an explicit schema/version transition. Pre-1.0 SDK additions and the coordinated type rename require minor releases, updated exact consumer pins and registry-only package checks. Each release set requires its own approval and exact reviewed release commit. Proposed surfaces are not stable published APIs until that release completes.

## Alternatives considered

- A new generic engine or fourth integration contract would duplicate the existing runner/SDK and split authorization.
- Keeping per-project command glue would preserve divergent defaults and cleanup.
- A global compatibility level would combine unrelated claims and incorrectly block static work or authorize untested targets.
- Manifest-only admission would not establish executable handler coverage or complete dependency authorization.

## Validation and rollout

Retain baselines, then validate direct and hosted execution, lifecycle and live checks before deletion. The normative specification names the project/target matrix, signal/refusal checks, tutorial gate and source-to-package checks. UI fixture rendering is useful evidence for its renderer; it cannot stand in for a real farm dispatch.

Unresolved rollout gates remain explicit: target readiness, provider ownership transfers, real dispatch, release approval and installed fleet acceptance. Publication and deployment do not follow from this Proposed document or from a passing static report.
