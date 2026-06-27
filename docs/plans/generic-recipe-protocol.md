# Farmslot — Generic Recipe Protocol v1 PRD

**Status:** Active rollout checklist (ADR-034 **Accepted**; protocol **core shipped** on `main`).
**Implementation map:** [adr-implementation-status.md](../reference/adr-implementation-status.md#adr-034--recipe-protocol-v1-accepted)
**Last updated:** 2026-06-27

> This PRD captures the remaining product slice after the core contract landed. The canonical field-level protocol source of truth is [Recipe Protocol v1](../reference/recipe-protocol-v1.md). Do not treat this file as a greenfield proposal — use it to track adoption gaps (manifest emission, UI, hooks, live self-validation, docs).

This PRD proposes a Generic Farmslot Recipe Protocol v1 product slice. It sits under the whole-product authority of [PRD-product.md](../PRD-product.md) and the canonical roadmap surfaces, and it should be treated as a cross-chunk planning artifact until promoted into the relevant canonical chunk PRDs.

## Source Inputs

- Canonical protocol spec: [reference/recipe-protocol-v1.md](../reference/recipe-protocol-v1.md)
- Runner-focused protocol reference: [reference/recipe-runner-protocol.md](../reference/recipe-runner-protocol.md)
- Current project onboarding: [`projects/README.md`](../../projects/README.md)
- Core project-agnostic constraints: [PRD-core-farmslot-canonical.md](../PRD-core-farmslot-canonical.md)
- Eval/replay roadmap context: [ROADMAP-next.md](../ROADMAP-next.md)

## Problem

Farmslot already has useful recipe machinery, but the contract is not expressed as a simple product protocol that can be reused by new projects or by Farmslot itself:

- Example Browser App, Example Mobile App, and Audiolab already have project-specific recipe runners and validators.
- Command Center can render recipe graphs and artifact packages, but artifact typing still depends partly on filename inference and project-specific conventions.
- Existing recipe documentation is useful but lighter than the current implementation: it describes the runner hook and recommended artifacts, but not the shared graph envelope, adapter boundary, or self-validation strategy.
- New projects need a clear answer to: “What must I implement to plug into Farmslot recipes without rewriting my whole test ecosystem?”
- Farmslot itself needs dogfood recipes so protocol, replay, artifact-viewer, gateway, Command Center, and Mobile Companion changes can be validated through the same feedback loop expected from integrated projects.

## User Outcome

An operator or project maintainer should be able to add recipe support to a project by implementing one shared graph envelope, one runner hook, and one artifact package contract while keeping project-native validation tools inside adapter actions. Farmslot should then render, replay, and review the result without project-specific UI code.

## Product Decision

Farmslot Recipe Protocol v1 standardizes **orchestration and evidence**, not every internal assertion implementation.

### Mandatory for new v1 Farmslot recipes

New v1-compatible Farmslot recipes use the shared `validate.workflow` graph
envelope:

- `schema_version`
- `title`
- `description`
- optional `inputs`
- `validate.workflow.entry`
- `validate.workflow.nodes`
- optional `validate.workflow.pre_conditions`
- optional `validate.workflow.setup`
- optional `validate.workflow.teardown`
- optional playback metadata such as `validate.workflow.playback.mode` and `validate.workflow.playback.slow_ms`

### Flexible by project or adapter

Node execution stays extensible. A node may be a portable Farmslot action or may delegate to a project-native tool such as:

- existing Example Browser App CDP actions
- existing Example Mobile App agentic actions
- Audiolab agentic actions
- Playwright
- Maestro
- Detox
- pytest
- XCTest
- shell commands
- backend/API test runners
- macOS/native UI automation
- custom project-owned adapters

The non-goal is not “no DSL.” The non-goal is forcing every project’s internal validation logic to be rewritten as primitive Farmslot UI actions.

## Scope

### In scope for v1

1. Formalize the existing `validate.workflow` graph as the mandatory Farmslot recipe envelope.
2. Preserve existing project runners/validators as reference implementations rather than replacing them.
3. Define a Farmslot-level compatibility validator for the generic graph envelope and artifact package.
4. Define a typed artifact manifest/index that lets Command Center and Mobile Companion render outputs without runner-specific knowledge.
5. Define the live replay/slow-playback contract for UI-class projects.
6. Define backend/batch expectations where completed-run artifacts are required but visual replay is not.
7. Add a Farmslot self-validation recipe suite plan covering Command Center, Gateway, Mobile Companion, artifact viewing, recipe replay, and ready/review workspaces.
8. Consolidate onboarding docs so a new project can implement minimal recipe support without reading Example App-specific templates first.

### Out of scope for v1

- Rewriting Example Browser App, Example Mobile App, or Audiolab runners from scratch.
- Replacing project-specific action validators with one universal action validator.
- Forcing all projects to abandon native test tools.
- Requiring backend/batch projects to provide visual replay or screenshots when the task is not visual.
- Encoding Example App-specific assumptions into the core protocol.
- Adding a new top-level replay taxonomy outside the existing run-family/lane/run and artifact-package models.

## Existing Reference Implementations

The first v1 pass should mine and preserve the current implementations:

| Area                        | Current evidence                                                                                                                                | Role in v1                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Example Browser App         | `projects/example-browser-farm/fixtures/agentic/recipes/validate-flow-schema.js`, `validate-recipe.js`, `validate-recipe.sh`, `lib/workflow.js` | Reference graph validator/runner and UI-class adapter implementation |
| Example Mobile App          | `projects/example-mobile-farm/templates/worker/*` references to app-local `scripts/perps/agentic/validate-recipe.sh`                            | Reference mobile UI adapter contract and runner invocation pattern   |
| Audiolab                    | `projects/audiolab-farm/templates/worker/*` references to app-local `scripts/agentic/validate-flow-schema.sh` and `validate-recipe.sh`          | Reference non-Example App/multi-surface adapter pattern              |
| Command Center graph viewer | `apps/command-center/ui/src/components/recipe-graph/recipe-graph-data.ts`                                                                       | Existing consumer of `validate.workflow.entry/nodes`                 |
| Recipe quality              | `services/gateway/src/recipe-quality.ts`                                                                                                        | Existing structural evaluator for graph and non-v1 recipe shapes     |
| Artifact purpose inference  | `services/gateway/src/core/recipe-artifacts.ts` and slot-view recipe helpers                                                                    | Current fallback to preserve while adding typed manifests            |

Mobile and Audiolab currently invoke validators through worker templates rather
than a `hooks.recipe_run` project hook. They remain reference implementations for
runner invocation and adapter semantics, while the v1 hook contract is the
standardized integration target for follow-up alignment. Example Browser App has a
`recipe_run` hook today, but its hook still relies on Command Center's compatibility
artifact-dir append fallback until follow-up work makes `{{artifacts_dir}}`
explicit.

## Requirements

### 1. Shared graph envelope

A new v1-compatible recipe must contain a valid graph envelope. The v1
compatibility value is `schema_version: 1`; future incompatible envelopes should
increment this value rather than overloading v1 semantics. Flat recipes remain
valid v1 recipes; composition fields are additive for recipes that need reusable
setup, domain start states, proof-target mapping, or proof-window media. Existing reference
recipes that omit `schema_version` or top-level `description` are
**non-v1 compatible** recipes: they should continue to run and render, but
the compatibility validator should label them as pre-v1 rather than treating them
as fully v1-compliant.

```json
{
  "schema_version": 1,
  "title": "Human-readable validation title",
  "description": "What this recipe proves",
  "inputs": {},
  "validate": {
    "workflow": {
      "pre_conditions": [],
      "setup": [],
      "entry": "run-check",
      "nodes": {
        "run-check": { "action": "command", "next": "done" },
        "done": { "action": "end", "status": "pass" }
      },
      "teardown": [],
      "playback": { "mode": "off", "slow_ms": 2000 }
    }
  }
}
```

The compatibility validator should check graph structure, not every project-specific action contract.

Minimum graph checks for v1-compatible recipes:

- `schema_version` is present and equals the supported v1 value, `1`.
- `title` is present.
- `description` is present.
- `validate.workflow.entry` exists.
- `validate.workflow.nodes` is a non-empty object.
- optional `uses`, `proofTargets`, `startState`, `phase`, `proofTarget`, and `record` fields follow the v1 composition contract when present.
- `entry` points to an existing node.
- Each node has an `action` string.
- Non-terminal nodes transition via `next`, `cases`, or `default` according to action shape.
- Referenced target nodes exist.
- At least one terminal `end` node exists.
- Unreachable nodes are reported.
- Playback metadata is well-formed when present.

V1 graph checks should preserve replay and rendering for reference recipes while surfacing advisory findings for missing required fields.

### 1.1 Composition and proof-boundary semantics

Recipe v1 includes optional composition semantics from [ADR-034](../adr/034-recipe-protocol-v1.md):

- `call` is the canonical official action for invoking cataloged flows;
- `uses` declares flow catalog refs;
- `startState` declares a pre-proof convergence flow;
- `proofTargets` declares AC/proof claims;
- `phase` separates `setup`, `start_state`, `proof`, `assert`, and `teardown`;
- `proofTarget` maps nodes/artifacts to proof claims;
- `record` controls evidence media policy with `none`, `trace_only`, `proof_window`, and `failure_only`.

The validator should treat these as protocol fields, not skill-only conventions.

### 2. Adapter-owned action contracts

The generic validator must allow project-specific actions while giving adapters a place to register stricter checks.

Recommended action taxonomy:

- **Portable core actions:** `command`, `wait`, `assert_json`, `assert_file`, `assert_exit_code`, `assert_output`, `state_read`, `watch_logs`, `index_artifacts`, `call`, `switch`, `manual`, `end`.
- **UI adapter actions:** `ui.navigate`, `ui.press`, `ui.key_press`, `ui.set_input`, `ui.scroll`, `ui.gesture`, `ui.wait_for`, `ui.screenshot`, `app.status`, `app.lifecycle`, `app.hud`, `app.trace`, `cdp.target`, `cdp.storage`, `cdp.network`, `cdp.emulation`, `cdp.metrics`, `cdp.trace`.
- **Project adapter actions:** any namespaced or project-owned action validated by that project’s runner.

A project may expose stricter validation for its adapter actions without changing the Farmslot core protocol.

### 3. Runner hook and invocation contract

Project config continues to own the runner hook:

```json
{
  "hooks": {
    "recipe_run": "<project command> --recipe {{recipe_path}} --artifacts-dir {{artifacts_dir}}"
  }
}
```

The runner must:

- accept a recipe path or descriptor;
- accept an artifacts directory;
- execute the graph according to project/adapter semantics;
- return a meaningful process exit status;
- write the required artifact package;
- copy or resolve the executed `recipe.json` into the artifacts directory when practical; optionally emit normalized `workflow.json`.

Existing hook variables such as `{{recipe_path}}`, `{{artifacts_dir}}`, `{{repo}}`, `{{cdp_port}}`, and `{{port}}` remain the integration surface.
Command Center may append `--artifacts-dir <dir>` when a hook omits an
artifacts argument, but new v1 hooks should include `{{artifacts_dir}}`
explicitly so the runner contract is visible in project config.

### 4. Required artifact package

Each recipe run should emit a package with stable minimum files:

| Path                            | Requirement | Purpose                                                                                     |
| ------------------------------- | ----------- | ------------------------------------------------------------------------------------------- |
| `summary.json`                  | required    | run status, duration, pass/fail counts, top-level error                                     |
| `trace.json`                    | required    | ordered node/action trace with human-readable intent, durations, errors, and artifact links |
| `artifact-manifest.json`        | required v1 | index of all displayable/debuggable artifacts with explicit types                           |
| `recipe.json`                   | recommended | exact/resolved recipe that ran when practical                                               |
| `workflow.json`                 | optional    | normalized workflow view when the runner produces one                                       |
| `workflow.mmd`                  | optional    | human-readable graph diagram when graph renderer can emit it                                |
| `recipe-quality.json`           | optional    | structural/contextual recipe quality signal                                                 |
| screenshots/videos/logs/reports | as produced | visual and debug evidence                                                                   |

The typed artifact manifest should make filename inference a fallback, not the
primary contract. Because current reference runners predate this protocol and may
only write `summary.json`, `trace.json`, and a normalized workflow file, the compatibility
validator should distinguish **v1-compatible** packages from **non-v1**
packages until those runners add manifest emission.

Minimum manifest fields for this PRD slice are shown below. The canonical manifest schema, required fields, and optional metadata are defined in [Recipe Protocol v1](../reference/recipe-protocol-v1.md#13-artifact-manifest-schema).

```json
{
  "version": 1,
  "runStatus": "pass",
  "artifacts": [
    {
      "path": "screenshots/perps-home.png",
      "type": "screenshot",
      "label": "Perps home after replay",
      "nodeId": "screenshot-home",
      "mimeType": "image/png"
    }
  ]
}
```

Minimum artifact `type` vocabulary:

- `screenshot`
- `video`
- `log`
- `trace`
- `summary`
- `json`
- `report`
- `metric`
- `diff`
- `recipe`
- `other`

### 5. UI and evidence contract

Command Center and Mobile Companion should consume typed artifact packages without project-specific UI code.

Required product behavior:

- show recipe graph from `validate.workflow` when available;
- show completed-run artifacts by type;
- prefer typed artifact manifest metadata over filename heuristics;
- preserve filename/purpose inference as compatibility fallback;
- make logs, screenshots, videos, reports, and JSON summaries easy to inspect;
- associate artifacts with node IDs when manifest/trace data provides the relationship;
- keep PR feedback/review artifacts visually separate from recipe-run artifacts unless explicitly grouped by a higher-level review package.

### 6. Live replay and playback

UI-class projects should support live replay or explain why a given recipe is non-visual.

UI-class projects include:

- web UI
- browser extension UI
- mobile UI
- macOS/native UI when visual review is expected

Expected behavior for UI-class runners:

- support slow playback where feasible;
- prefer a default human-readable delay around 2 seconds for live visualization;
- accept slow-playback values in the same bounded range as the gateway (`100` to
  `60_000` milliseconds) when the runner opts into
  `recipe_run_supports_playback_slow`;
- emit trace descriptions or node notes that describe human intent, not only implementation action names;
- use HUD/overlay text for reviewer-meaningful intent such as “Open Perps market detail” rather than opaque action names such as `eval_async`;
- do background setup/API/controller checks without forcing every step into the live visual stream.

Backend/batch/non-visual projects are not required to provide live visual replay, but they must still emit trace, summary, and typed artifacts.

### 7. Farmslot self-validation recipes

Farmslot should dogfood the protocol through a repo-local self-validation suite. The suite should validate Farmslot changes with the same recipe package shape expected from integrated projects.

Initial suite areas:

- Command Center web UI recipe: artifact viewer, recipe graph, replay controls, ready/review workspace basics.
- Gateway RPC/API recipe: recipe-run RPC, artifact index ingestion, run/family projection, manifest validation.
- Mobile Companion recipe: run detail, decision/evidence review, artifact viewing on mobile.
- End-to-end recipe player recipe: replay a UI-class recipe, inspect live stream, inspect output artifacts.
- Documentation/onboarding recipe: validate example project fixtures or sample recipes against the compatibility validator.

The self-validation suite should emit the same `summary.json`, `trace.json`, typed artifact manifest, resolved `recipe.json`, and optional normalized `workflow.json` artifacts as project runs.

The initial repo-local fixtures live under
[`docs/examples/recipes/farmslot/`](../examples/recipes/farmslot/). They are
runner-neutral protocol fixtures: each recipe describes the surface and adapter
actions to execute, and each paired artifact directory demonstrates the completed
v1 artifact package that a live runner should emit.

### 8. Documentation and onboarding

The documentation pass should consolidate the current onboarding surfaces rather than add another disconnected guide.

Required doc outcomes:

- Update [reference/recipe-runner-protocol.md](../reference/recipe-runner-protocol.md) with the mandatory graph envelope, typed artifact manifest, replay contract, and adapter boundary.
- Update [`projects/README.md`](../../projects/README.md) with the minimal recipe integration checklist.
- Add or link a small “new project recipe support” example showing a non-Example App project with `command`/native-test delegation.
- Explain how project-specific validators extend the generic graph compatibility validator.
- Document existing Extension/Mobile/Audiolab runners as reference implementations, not throwaway code to replace.

## Migration and Compatibility

V1 must be additive:

- Existing Extension and Mobile recipes should continue to run.
- Existing recipes without `schema_version` or top-level `description` are
  accepted as non-v1 inputs, not forced rewrites.
- Existing artifact purpose inference should remain as a fallback while typed manifests roll out.
- Existing `evidence-manifest.json` can coexist with the new typed artifact manifest; the PRD does not require removing it.
- Existing `validate.workflow` fields should be formalized, not renamed without a migration path.
- Existing project-specific validator scripts should be preserved and gradually aligned around the generic envelope where useful.

## Acceptance Criteria

1. A supporting-plan PRD and canonical roadmap entry exist for Generic Recipe Protocol v1.
2. The protocol definition requires the shared `validate.workflow` graph envelope.
3. The protocol explicitly allows project-native adapter actions and native test tools inside graph nodes.
4. Existing Extension, Mobile, and Audiolab recipe runners are documented as reference implementations to preserve, not rewrite.
5. A lightweight compatibility validator is specified for graph envelope and artifact package checks.
6. Required artifact package files are specified: `summary.json`, `trace.json`, `artifact-manifest.json`, and resolved/copy of executed `recipe.json` when practical; normalized `workflow.json` is optional.
7. Command Center and Mobile Companion artifact consumption requirements are specified without project-specific UI coupling.
8. UI-class replay/slow-playback expectations are specified separately from backend/batch expectations.
9. Farmslot self-validation recipes are specified for Command Center, Gateway, Mobile Companion, recipe replay, artifact viewer, and ready/review workspace flows.
10. Documentation consolidation targets are listed for `docs/reference/recipe-runner-protocol.md`, `projects/README.md`, and new-project examples.

## Phased Delivery Proposal

### Phase 1 — Protocol and docs consolidation

- Update `docs/reference/recipe-runner-protocol.md` around graph envelope + artifact package + adapter boundary.
- Update `projects/README.md` with a minimal integration checklist.
- Document Extension/Mobile/Audiolab as reference implementations.

### Phase 2 — Compatibility validator and examples

- Add a Farmslot-level validator for the generic graph envelope and artifact package.
- Add sample recipes for one UI-class flow and one non-UI/backend-style command-delegating flow.
- Report non-v1 reference recipes without forcing immediate rewrites.
- Keep project-specific validators in place.

### Phase 3 — Typed artifact manifest consumption

- Teach gateway/Command Center to prefer the typed artifact manifest when present.
- Preserve filename/purpose inference as fallback.
- Separate recipe-run artifacts from PR feedback/review artifacts in the UI.
- Add `artifact-manifest.json` emission/backfill guidance for Extension, Mobile,
  and Audiolab runners without breaking existing non-v1 artifact packages.

### Phase 4 — Farmslot self-validation suite

- Add repo-local Farmslot recipes for Command Center web UI, Gateway RPC/API, Mobile Companion, artifact viewer, recipe replay, and ready/review workspace flows.
- Ensure these recipes emit the same artifact package as project recipe runs.

### Phase 5 — Evaluation-loop hardening

- Use eval packages to compare recipe protocol, template, runner, and artifact-viewer changes against known-good references.
- Promote stable self-validation suites into the normal pre-PR or release validation path only after real-run evidence shows they are reliable.

## Success Condition

A new project can implement one shared graph envelope, one runner hook, and one typed artifact package while keeping its native test tooling. Farmslot can then replay, render, and review the run on desktop and mobile without project-specific artifact UI code, and Farmslot can validate its own recipe/replay/artifact surfaces with dogfood recipes that emit the same package format.
