---
title: Recipe Protocol v1
description: RFC-style specification for Farmslot Recipe Protocol v1 recipes, actions, flow catalogs, traces, artifact manifests, and runner contracts.
---

# Recipe Protocol v1

**Status:** Accepted — source of truth
**Owner:** Farmslot
**Last updated:** 2026-05-30
**Related decision:** [ADR-034: Recipe Protocol v1](https://github.com/deeeed/farmslot/blob/main/docs/adr/034-recipe-protocol-v1.md)

## 1. Purpose

Recipe Protocol v1 defines the shared Farmslot contract for executable validation recipes. It standardizes the recipe graph, runner boundary, flow composition, trace, and artifact package while allowing each project to keep its native implementation details behind actions and domain flow catalogs.

A recipe should be easy to author at the simple end and fully configurable at the advanced end:

- a backend or CLI project can use one command node plus assertions;
- a UI project can capture screenshots/videos around proof nodes;
- a domain team can publish reusable start-state flows so task recipes stay concise;
- Farmslot can validate, render, replay, and compare artifacts without project-specific UI code.

## 2. Design principles

1. **Graph first.** A recipe is a directed graph, not a linear script. Branching, reusable subgraphs, assertions, setup, proof, and teardown remain one graph execution model.
2. **Simple by default.** Flat `entry` + `nodes` recipes are valid v1 recipes. Composition fields are optional.
3. **Protocol owns orchestration and evidence.** Farmslot defines graph execution, flow calls, phases, trace, summary, artifact manifests, and validation rules.
4. **Projects own domain behavior.** Project runners define custom actions and flow catalogs such as wallet, checkout, backend seed, or CLI login flows.
5. **Parameterize before multiplying.** Domains should prefer one parameterized action/flow over many near-duplicate variants. A smaller vocabulary is easier for agents to discover, learn, validate, and maintain.
6. **Proof is reviewer-oriented.** Visual evidence should focus on the smallest user-visible interaction that proves the claim, while trace keeps full setup reproducibility.
7. **No fabricated proof.** Setup may prepare fixtures before proof. Proof-phase nodes must not directly mutate UI/app state to manufacture outcomes.

Companion documents such as `reference/recipe-runner-protocol.md`, `reference/recipe-composition-quality.md`, and skill-local references are explanatory. They must link back to this document and must not redefine field names, schema, or validation rules differently. Field casing is intentional in v1: recipe envelope and graph keys use snake_case for inherited/runtime fields (`schema_version`, `pre_conditions`) and camelCase for composition additions (`proofTargets`, `startState`, `proofTarget`); flow catalogs use camelCase (`paramsSchema`, `defaultPhase`, `requiresActions`); action manifests and runner hook/config fields use snake_case (`runner_protocol_version`, `supported_official_actions`); artifact manifests use camelCase for artifact metadata (`runStatus`, `nodeId`, `proofTarget`, `mimeType`).

## 3. Terminology

| Term           | Meaning                                                                            |
| -------------- | ---------------------------------------------------------------------------------- |
| Recipe         | JSON document conforming to this protocol.                                         |
| Workflow graph | `validate.workflow.entry` plus `validate.workflow.nodes`.                          |
| Node           | One executable graph step with an `action`.                                        |
| Action         | Operation implemented by Farmslot core or a project runner.                        |
| Flow           | Reusable named subgraph published in a flow catalog.                               |
| Flow catalog   | Project/domain-owned JSON document containing reusable flows.                      |
| Flow budget    | Domain-owned limit/review gate that keeps flow catalogs small and non-duplicative. |
| Start state    | A named convergence flow that prepares the baseline before proof.                  |
| Proof target   | Acceptance criterion or claim the recipe proves.                                   |
| Phase          | Node/flow lifecycle role: `setup`, `start_state`, `proof`, `assert`, `teardown`.   |
| Record policy  | Evidence media policy: `none`, `trace_only`, `proof_window`, `failure_only`.       |

## 4. Recipe document schema

Minimum valid flat recipe:

```json
{
  "schema_version": 1,
  "validate": {
    "workflow": {
      "entry": "run-smoke",
      "nodes": {
        "run-smoke": {
          "action": "command",
          "intent": "Run the API smoke tests and record the result",
          "cmd": "npm test -- api-smoke",
          "timeout_ms": 120000,
          "next": "done"
        },
        "done": { "action": "end", "status": "pass" }
      }
    }
  }
}
```

Top-level fields:

| Field               | Required | Description                                                                                                                                                                                                                                                |
| ------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema_version`    | yes      | Numeric protocol version. v1 uses `1`.                                                                                                                                                                                                                     |
| `title`             | no       | Optional recipe-level metadata. It is not the step/HUD explanation.                                                                                                                                                                                        |
| `description`       | no       | Optional recipe-level metadata describing the overall proof. It is not the step/HUD explanation.                                                                                                                                                           |
| `inputs`            | no       | Typed inputs or literal defaults.                                                                                                                                                                                                                          |
| `uses`              | no       | Flow catalog references as repo-relative paths, package specifiers, or runner-resolved aliases. `call.ref` uses the dotted flow id inside those catalogs.                                                                                                  |
| `proofTargets`      | no       | Claims/ACs the recipe proves. Required for production AC proof recipes.                                                                                                                                                                                    |
| `startState`        | no       | Optional single pre-proof `call` node that converges the baseline before proof. Use a flow workflow or `setup[]` for multiple setup steps; `startState` is not an array in v1. It has reserved implicit node id `startState` for trace/output namespacing. |
| `validate.workflow` | yes      | Workflow graph and optional lifecycle arrays.                                                                                                                                                                                                              |

### 4.1 Inputs and template references

`inputs` may contain literal defaults or typed descriptors. Supported descriptor types are `string`, `number`, `boolean`, `json`, and `secret-ref`. Runners may allow CLI overrides, but resolved inputs must be recorded with secrets redacted.

Template references in v1 are scoped to flow parameters: `{{params.name}}` and nested `{{params.object.field}}` may be used inside reusable flow nodes. Recipe-level inputs are metadata for runners and skills; a runner may map them into flow `params`, but the v1 harness does not expose node-output template references. `secret-ref` values must never be expanded into screenshots, logs, trace text, artifact paths, or unredacted outputs.

## 5. Workflow graph model

`validate.workflow` fields:

| Field            | Required | Description                                                                       |
| ---------------- | -------- | --------------------------------------------------------------------------------- |
| `entry`          | yes      | Node id where proof graph execution begins.                                       |
| `nodes`          | yes      | Object keyed by node id.                                                          |
| `pre_conditions` | no       | Named runner gates checked before execution.                                      |
| `setup`          | no       | Ordered action nodes before `startState` and graph entry.                         |
| `teardown`       | no       | Ordered action nodes after graph completion/failure according to teardown policy. |
| `playback`       | no       | UI replay metadata.                                                               |

`pre_conditions` is an ordered list of manifest-declared gate ids, either as a
string (`"wallet.unlocked"`) or as `{ "id": "...", "params": { ... } }`. Gates
run before `setup`, `startState`, and proof graph nodes. Runners must fail
closed when a recipe references an undeclared precondition or when no checker is
registered for that id; silently skipping a precondition is invalid Recipe v1
behavior.

Node fields:

| Field               | Required                                           | Description                                                                                           |
| ------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `action`            | yes                                                | Official or runner-declared action.                                                                   |
| `intent`            | yes for every non-terminal executable node         | Human-facing sentence explaining what the agent is trying to do now; default HUD/trace progress text. |
| `description`       | no                                                 | Optional legacy/detail text; do not author it instead of `intent`.                                    |
| `next`              | required for non-terminal non-`switch` graph nodes | Direct transition.                                                                                    |
| `cases` / `default` | required/optional for `switch`                     | Branch transition rules.                                                                              |
| `status`            | required for `end`                                 | Terminal `pass`, `fail`, or `unknown`.                                                                |
| `params`            | no                                                 | Flow parameters for `call` nodes.                                                                     |
| `assert`            | no                                                 | Inline assertion over output/state.                                                                   |
| `phase`             | no                                                 | Lifecycle phase.                                                                                      |
| `proofTarget`       | no                                                 | `proofTargets[].id` covered by this node.                                                             |
| `record`            | no                                                 | Evidence media policy.                                                                                |

Official and custom actions declare action-specific fields at the node top level, for example `cmd`, `target`, `market`, `timeout_ms`, or selector fields. `params` is reserved for `call` flow parameters.

Every non-terminal recipe node must include `intent`: a short human-facing sentence explaining what the agent is trying to do now. This is the agent-to-human communication line. UI-capable runners show `intent` in the HUD during live replay/recording; headless runners record it in trace/status/review artifacts. Do not use generic text, action names, node IDs, selectors, test IDs, recipe titles, recipe descriptions, or screenshot notes as intent.

### 5.1 Assertion model

Nodes and flow postconditions may use `assert` objects. Atomic assertions select a value with `source` and/or `path`, apply an `operator`, and compare against either a literal `value` or a named flow/input `param`. `param` means “use the current flow/input parameter with this name as the expected value.”

Official atomic operators: `exists`, `not_null`, `truthy`, `falsy`, `eq`, `neq`, `deep_eq`, `gt`, `gte`, `lt`, `lte`, `contains`, `not_contains`, `matches`, `one_of`, `length_eq`, `length_gt`, `length_gte`, `length_lt`, and `length_lte`. Compound assertions use object keys, not an `operator` value: `{ "all": [<assertion>] }`, `{ "any": [<assertion>] }`, and `{ "none": [<assertion>] }`. Custom atomic operators must be namespaced and declared in the action manifest.

### 5.2 Conditional execution

A **predicate** is an assertion object from section 5.1 evaluated as a boolean. Predicates may read prior outputs, saved values, inputs, or declared state refs. The same predicate grammar applies to `when`, `unless`, `switch.cases[].when`, and flow `postcondition`.

Graph nodes may use `when` or `unless` as execution gates:

- `when` runs the node only when the predicate is true.
- `unless` skips the node when the predicate is true.
- A skipped non-terminal node follows its declared `next`; skip reason should be recorded in trace when practical.

Branching is separate from gating. The only v1 branching action is `action: "switch"`; `when` and `unless` do not choose alternate routes by themselves.

Graph rules:

- `entry` must reference an existing node.
- Non-terminal non-`switch` nodes transition through `next`. Branching uses `action: "switch"`; `cases` is an ordered array of `{ "when": <predicate>, "next": <nodeId> }` with optional `default`.
- Transition targets must exist.
- At least one terminal `end` node must be reachable.
- Unreachable nodes are validation findings.
- `setup` and `teardown` are ordered arrays, not transition graphs.

## 6. Official actions

Official actions are stable protocol vocabulary. A recipe may only use the actions
advertised by the runner's action manifest for that run.

Core/headless:

```text
command, wait, assert_file, assert_json, assert_exit_code, assert_output,
state_read, watch_logs, index_artifacts, call, switch, manual, end
```

UI/app/CDP classes:

```text
ui.navigate, ui.press, ui.key_press, ui.set_input, ui.scroll, ui.gesture,
ui.wait_for, ui.screenshot, app.status, app.lifecycle, app.hud, app.trace,
cdp.target, cdp.storage, cdp.network, cdp.emulation, cdp.metrics, cdp.trace
```

`ui.scroll` supports viewport/container deltas (`delta_x`, `delta_y`) and may
set `scroll_into_view: true` with a selector/test id when the proof requires a
specific validated element to be visible before `ui.screenshot`.

UI nodes may include `observe`. `observe: false` disables passive post-action
observations for that node. `observe: ["ui.visible"]` records only the named
observer. When omitted, each runner's action manifest controls defaults through
`observers[].default_for`; `ui.screenshot` should normally default off.
Observations are authoring/debug context only. They do not choose `next`, set
`status`, set `case`, select branches, or replace proof nodes.

State-changing UI actions settle before observation by default. Set
`settle: false` only for intentionally live surfaces that cannot become quiet;
the resulting observation is best-effort authoring context rather than settled
post-action state.

Project custom actions must be namespaced, for example `example.trade.place_order` or `checkout.ensure_cart`. This document owns the action vocabulary and cross-cutting recipe semantics. [Recipe Runner Protocol](recipe-runner-protocol.md#action-manifest) provides runner-facing action guidance, and its [artifact package section](recipe-runner-protocol.md#artifact-package) provides runner output examples; when documents differ, this spec wins.

## 7. Flow composition

`call` is the canonical graph-composition action. It invokes a named flow from a catalog referenced by `uses`.

```json
{
  "action": "call",
  "ref": "example.trade.start_state",
  "params": {
    "network": "testnet",
    "provider": "hyperliquid",
    "page": "positions",
    "market": "BTC",
    "position": "none"
  },
  "phase": "start_state",
  "record": "trace_only"
}
```

Execution semantics:

- A `call` node resolves `ref` from the recipe's `uses` catalogs or runner built-ins.
- The runner validates `params` against the flow's `paramsSchema` before executing child nodes.
- The flow executes as a child graph and returns a status/output to the caller.
- Flow child trace entries are namespaced under the call node id. Top-level `startState` uses reserved implicit node id `startState` for trace/output namespacing.
- Recursive calls are rejected when they create cycles or exceed the configured depth. The v1 default maximum call depth is 8.

Parameter names are domain-owned, but shared domains should keep them consistent. For Example App perps, `start_state` may accept a broad desired baseline such as `positions: { state: "none" }`, while focused `ensure_positions` and `assert_positions` should use `state: "open" | "none"` plus optional details such as `side` and `notional`.

## 8. Flow catalog schema

Flow catalog document:

```json
{
  "schema_version": 1,
  "kind": "recipe-flow-catalog",
  "owner": "example.trade",
  "flows": {
    "example.trade.start_state": {
      "version": 1,
      "description": "Converge Perps to a requested baseline.",
      "paramsSchema": { "type": "object" },
      "outputsSchema": { "type": "object" },
      "defaultPhase": "start_state",
      "defaultRecord": "trace_only",
      "requiresActions": ["example.wallet.ensure_unlocked", "example.trade.navigate"],
      "postcondition": { "operator": "truthy", "path": "$.ready" },
      "workflow": {
        "entry": "ensure-wallet",
        "nodes": {}
      },
      "examples": []
    }
  }
}
```

Flow fields:

| Field             | Required                | Description                                      |
| ----------------- | ----------------------- | ------------------------------------------------ |
| `version`         | yes                     | Flow contract version.                           |
| `description`     | yes                     | What baseline or behavior the flow provides.     |
| `paramsSchema`    | recommended             | JSON-schema-like params contract.                |
| `outputsSchema`   | recommended             | JSON-schema-like output contract.                |
| `defaultPhase`    | no                      | Default phase for flow calls.                    |
| `defaultRecord`   | no                      | Default record policy.                           |
| `requiresActions` | no                      | Actions/capabilities needed by the flow.         |
| `postcondition`   | required for `ensure_*` | Machine-checkable assertion proving convergence. |
| `workflow`        | yes                     | Child graph body.                                |
| `examples`        | no                      | Agent-facing examples.                           |

`ensure_*` flows are idempotent convergence contracts: inspect current state, do only required transitions, and prove `postcondition` before success.

### 8.1 Flow catalog maintenance rules

Flow catalogs are agent-facing APIs. They must stay small and parameterized. Domains should avoid pairs or families that differ only by a boolean, state, route, market, provider, or assertion polarity. Prefer one typed action/flow with parameters.

Examples:

| Avoid growing many names                                              | Prefer one parameterized contract                              |
| --------------------------------------------------------------------- | -------------------------------------------------------------- |
| `assert_position`, `assert_no_position`                               | `assert_positions({ market, state: "open" or "none", side? })` |
| `ensure_no_position`, `ensure_long_position`, `ensure_short_position` | `ensure_positions({ market, state, side?, notional? })`        |
| `navigate_home`, `navigate_market`, `navigate_trade_form`             | `navigate({ page, market?, side? })`                           |
| `select_mainnet`, `select_testnet`                                    | `ensure_network({ network })`                                  |

A new flow should be added only when it creates a new reusable domain concept, not when it is only a pre-filled parameter set. Presets may exist as examples or aliases in documentation, but the manifest/catalog should favor the parameterized primitive unless the alias materially improves safety or readability.

Recommended domain governance:

- each domain owns a small flow budget and reviews additions against existing parameterized flows;
- duplicate-flow lint should flag names that share the same verb/object with only polarity or route differences;
- recipe-quality should fail production recipes that inline setup or call duplicate flows when a parameterized flow exists;
- action/flow manifests should include descriptions and examples so agents can discover the right parameter values instead of inventing new actions.

## 9. Phases and execution order

Execution order:

1. validate recipe, manifests, and catalogs;
2. check `pre_conditions`;
3. execute ordered `setup` nodes;
4. execute `startState` if present;
5. execute graph from `validate.workflow.entry`;
6. execute `teardown` according to teardown policy;
7. write summary, trace, artifact manifest, and resolved recipe.

Phase defaults:

| Location/action | Default phase                                                | Default record                                   |
| --------------- | ------------------------------------------------------------ | ------------------------------------------------ |
| `setup[]`       | `setup`                                                      | `trace_only`                                     |
| `startState`    | `start_state`                                                | `trace_only`                                     |
| graph node      | inferred from action or `proof` when mapped to `proofTarget` | `proof_window` for proof, otherwise `trace_only` |
| assertion node  | `assert`                                                     | `trace_only`                                     |
| `teardown[]`    | `teardown`                                                   | `trace_only`                                     |

## 10. Proof targets

`proofTargets` declares ACs/claims:

```json
{
  "proofTargets": [{ "id": "AC1", "claim": "The close button closes an open BTC position." }]
}
```

Production proof recipes should map every proof/assert/evidence node to a `proofTarget`. Every visible UI proof target should have at least one assertion and one reviewer-visible artifact unless marked blocked.

Use `proofTarget` casing in recipe nodes and artifact manifests.

## 11. Evidence and recording policy

`record` values:

| Value          | Meaning                                        |
| -------------- | ---------------------------------------------- |
| `none`         | No media or extra evidence beyond trace.       |
| `trace_only`   | Trace/summary/artifact metadata only.          |
| `proof_window` | Capture proof-window media for this node/flow. |
| `failure_only` | Capture extra evidence only on failure.        |

Proof windows should start at the relevant user-visible proof interaction and exclude generic setup by default. Setup can use `proof_window` only when setup itself is the claim.

Video proof is a first-class Recipe v1 evidence type for UI-capable projects. A
runner that supports replay recording should capture the proof window into the
run artifact directory and index it in `artifact-manifest.json` with `type: "video"`, a reviewer-readable label, and the relevant `nodeId`/`proofTarget`.
On macOS slots, the preferred provider is Farmslot's installed `capture-helper`;
recipes and agents should not invent project-specific capture commands when the
slot recorder capability is available.

### 11.1 Visual proof HUD and overlay

For UI-capable projects, HUD/overlay support is a first-class Recipe v1 runtime capability exposed through the official `app.hud` action. The HUD is a reviewer aid for live playback and recorded proof media; it is not the proof source of truth. Trace, assertions, screenshots/videos, and artifact manifests remain authoritative. Headless projects are not required to support `app.hud`, but any runner that advertises it must implement the lifecycle semantics below.

HUD/overlay behavior:

The `intent` field is a human-facing sentence written for the reviewer watching the run. It must answer: “what is the agent trying to do right now?” It is not a bucket for implementation details, action names, domains, test ids, selectors, or logs. If a value would not help a human understand the current goal, it belongs in `trace.json`, debug metadata, or a detail/error field instead.

- default to a minimalist reviewer line: run status/progress plus one human intent, for example `RUN 12/19 Open a small ETH long position`;
- hide taxonomy/debug metadata (`flow`, `domain`, node id, action name, `proofTarget`) unless the runner opts into a debug display mode;
- keep the default HUD to one human intent line. When a runner executes a composed `call` flow, it may internally retain parent/child context for trace/debug views, but Recipe v1 authors still only write node `intent`;
- hide `detail` by default because it is trace/review metadata, not a second intent; render it only when a project explicitly opts into `display.showDetail: true`;
- use a secondary line only for explicit detail/debug display or failure error text; generic labels such as `ui`, `wallet`, or `perps setup` are not user-facing HUD text;
- update automatically from the harness lifecycle before and after each recipe node, including pass/fail/complete states, when `app.hud` is registered;
- use explicit recipe `app.hud` nodes only for extra reviewer annotations, not as the primary progress loop;
- never mutate product state, application stores, wallet state, backend state, or assertions;
- never obscure the UI element or visual state being proved; if an overlay could obscure the claim, the runner must capture a raw/non-obscured artifact as well;
- record HUD-visible proof artifacts in `artifact-manifest.json` with normal `proofTarget`/`nodeId` links when those artifacts are captured;
- make HUD support discoverable in the action manifest/capability profile instead of assuming every UI runner has it.

Overlay injection belongs to the runner/harness boundary. It may be installed at run time so fresh checkouts and historical commits can expose consistent visual proof controls, but it must stay separate from product-domain actions and from task-specific recipe assertions. A project runner should configure rendering policy such as overlay vs docked layout, position, title visibility, debug visibility, width, and detail-line budget; it should not reimplement graph progress, node lifecycle, or recipe-specific status text. UI runners should prefer a docked/reserved-space layout when an overlay can hide primary buttons or proof-critical content.

## 12. Trace schema

Trace entries may include `observations` and `observationWarnings`.
Observations are stored separately from action `output` so graph control flow
cannot implicitly depend on them. Observation failures should be warning-only
for otherwise successful actions.

Built-in UI observers:

- `ui.screen`: current screen, route, title, or URL digest.
- `ui.visible`: bounded visible actionable targets with stable handles such as
  `test_id`, selector, label, and role where available.

`trace.json` is the ordered execution record. It may be either a plain array of
trace entries or an object with optional `metadata` and an `entries` array. The
plain array form is valid for simple runners; the envelope form is used when a
runner needs run-level metadata such as provenance without repeating it on every
entry.

Each trace entry includes:

| Field                                  | Description                   |
| -------------------------------------- | ----------------------------- |
| `nodeId`                               | Node id or child path.        |
| `action`                               | Executed action.              |
| `startedAt` / `endedAt` / `durationMs` | Timing.                       |
| `ok`                                   | Boolean success.              |
| `next`                                 | Next node for graph entries.  |
| `status`                               | Terminal status when emitted. |
| `output`                               | Redacted output.              |
| `error`                                | Failure message.              |

For `call` nodes, the parent entry records the flow rollup output, and child nodes
are recorded as slash-delimited paths such as `validate/call-child/assert`. The
child path is the canonical v1 source of flow nesting/depth; richer call metadata
belongs in the node output or artifact manifest until a future schema version adds
first-class trace fields.

## 13. Artifact manifest schema

Every v1 run writes `artifact-manifest.json`:

```json
{
  "version": 1,
  "runStatus": "pass",
  "provenance": {
    "runner": {
      "name": "@example/recipe-runner",
      "source": "packages/example-runner",
      "git_ref": "0123456789abcdef"
    }
  },
  "artifacts": [
    {
      "path": "screenshots/AC1-position-closed.png",
      "type": "screenshot",
      "category": "evidence",
      "label": "AC1 position closed",
      "nodeId": "AC1-screenshot",
      "proofTarget": "AC1"
    }
  ]
}
```

`artifact-manifest.json` intentionally uses `version`, not `schema_version`, to match the shipped typed artifact-manifest validator. Top-level required fields: `version` (must equal `1`) and `artifacts`. Optional top-level fields: `runStatus` (`pass`, `fail`, or `unknown`) and `provenance.runner`; when `provenance.runner` is present, it requires `source` and `git_ref`, with optional `name` and `version`. Per-artifact required fields: `path`, `type`. Recommended fields: `category`, `label`, `nodeId`, `proofTarget`, `covers`, and `mimeType`. Use `proofTarget` for the primary single proof target; use `covers` when one artifact supports multiple targets.

The v1 package contract has a strict required core and an open extension space. Required fields stay strict, unknown artifact `type` values produce warnings rather than hard failures, and extra additive metadata may be included on the manifest or artifact entries when consumers can ignore it safely. Runners must not replace required core fields with extension-only metadata.

Consumer behavior is manifest-first for non-empty valid typed manifests: manifest entries are the source of truth for displayable artifacts, labels, types, proof-target links, and node associations. Filename inference is a legacy compatibility fallback when `artifact-manifest.json` is missing, invalid, or valid-but-empty while files are already present on disk. Consumers must surface malformed manifests rather than silently trusting them.

Package validation requires the core files (`summary.json`, `trace.json`, and `artifact-manifest.json`). `recipe.json` is recommended when practical, but remains optional for runners that execute a resolved recipe from outside the artifact directory. Manifest entries should include displayable/debuggable artifacts and are encouraged to index the core files as `summary`, `trace`, and `recipe`, but the package-level required-file check is separate from the per-entry artifact list so runners can add optional metadata without changing the required core.

Task closeout quality is represented by `RecipeQualityArtifact` when a run emits `artifacts/recipe-quality.json`. The shared validator is exported from `@farmslot/protocol`; task-local enforcement belongs to the agent runtime rather than `@farmslot/skills`. Workers should not hand-author the full object when `@farmslot/agent-runtime` is available: use `farmslot-agent recipe-quality build` or `buildRecipeQualityArtifact()` so verdict/reasons/findings/delta/proof metadata are expanded into a valid protocol artifact.

## 14. Runner contract

A v1 runner must:

- accept a recipe path or recipe document;
- accept an artifacts directory;
- validate recipe/action manifest/flow catalog compatibility;
- execute lifecycle order and graph transitions;
- write `summary.json`, `trace.json`, `artifact-manifest.json`, and resolved `recipe.json` when practical; runners may also emit normalized `workflow.json`;
- return a meaningful process exit code;
- fail explicitly on unsupported actions, missing flows, invalid params, or unproven required postconditions.

## 15. Action manifest contract

An action manifest declares runner capabilities:

```json
{
  "runner_protocol_version": 1,
  "action_registry_version": 1,
  "supported_official_actions": ["command", "call", "ui.press"],
  "action_metadata": {},
  "observers": [
    {
      "ref": "ui.screen",
      "description": "Current screen/route digest after UI actions.",
      "default_for": ["ui.press"],
      "cost": "cheap",
      "redaction": "none"
    }
  ],
  "custom_actions": [{ "name": "example.trade.place_order", "owner": "example.trade" }],
  "custom_assertion_operators": [],
  "state_refs": [],
  "pre_conditions": [],
  "native_bindings": []
}
```

Required fields: `runner_protocol_version`, `action_registry_version`, and `supported_official_actions`. Optional fields: `action_metadata`, `observers`, `custom_actions`, `custom_assertion_operators`, `state_refs`, `pre_conditions`, and `native_bindings`. Action manifests describe primitive operations. Flow catalogs describe reusable subgraphs built from those operations.

Action discovery is part of the protocol contract. Runners SHOULD expose the
active action manifest through a CLI or project hook so recipe-authoring agents
can discover supported action names, field schemas, examples, and custom action
descriptions before drafting a recipe. Recipe authors should not rely on prompt
lists of protocol actions; the manifest for the selected runner is the executable
catalog, and runner validation rejects unsupported actions.

## 16. Capability profiles and platform parity

Action manifests are executable contracts: if an action appears there, the runner must be able to execute it or fail explicitly for environment/runtime reasons. Do not advertise placeholder actions as supported.

Projects may additionally publish a **capability profile** or domain interface matrix. This matrix is for parity and planning, not direct execution. It can list common domain capabilities across platforms with status:

| Status        | Meaning                                                               | Callable?          |
| ------------- | --------------------------------------------------------------------- | ------------------ |
| `supported`   | Implemented and present in the action/flow manifest.                  | Yes                |
| `partial`     | Implemented with documented limitations.                              | Only within limits |
| `unsupported` | Known common interface capability but not available on this platform. | No                 |
| `planned`     | Intended future capability.                                           | No                 |

The purpose is to let agents write similar recipes across platforms while still seeing where a platform needs implementation. For example, an Example App runner can define a shared wallet/perps interface for Mobile and Extension, while Extension may mark account switching unsupported until validated.

Recommended minimal project-agnostic core for new runners:

```text
command, wait, assert_file, assert_json, assert_exit_code, assert_output,
watch_logs, index_artifacts, end
```

Recommended minimal UI-class core when applicable:

```text
app.status, ui.wait_for, ui.screenshot
```

Domain-specific interfaces should stay small and parameterized. For Example App wallet/perps, prefer shared names such as `example.wallet.ensure_unlocked`, `example.wallet.read_state`, `example.wallet.navigate`, `example.wallet.select_account`, `example.trade.start_state`, `example.trade.ensure_positions`, and `example.trade.assert_positions`, with per-platform support status rather than separate Mobile/Extension vocabularies.

## 17. Issue capture and gating

A runner may emit issue-capture artifacts for unexpected logs, screenshots, failed assertions, or product/runtime failures. These artifacts must be indexed in `artifact-manifest.json`. Gating policy such as `fail_on_unexpected` is runner/project-owned but must be visible in summary/trace so reviewers know whether an issue was blocking, diagnostic, or ignored.

## 18. Validation rules

A v1 validator should report errors for:

- missing required recipe fields;
- invalid graph entry/transitions/terminal nodes;
- unsupported actions according to the manifest;
- invalid inline flow graphs and inline flow transitions;
- unresolved inline `call.ref` values when no external `uses` catalogs are declared;
- missing/unreadable external `uses` catalogs at runner load time;
- invalid `call.ref`, params, or `param` bindings;
- inline flow recursion/cycles beyond configured depth;
- output namespace collisions or unresolved output references;
- invalid `phase` or `record` values;
- field-casing violations for v1-owned fields;
- production proof/assert/evidence nodes missing `proofTarget`;
- visible UI proof targets without assertion/evidence;
- `ensure_*` flows without machine-checkable postconditions;
- unproven required postconditions;
- artifact manifest paths that do not exist.

Warnings may cover unreachable nodes, weak descriptions, missing optional schemas, missing proof targets in non-production smoke recipes, or duplicate domain flows where one parameterized flow should cover the same concept. A duplicate-flow warning becomes an error only when a project defines a mechanical lint rule, such as same verb/object with only polarity, route, boolean, provider, market, or assertion-direction differences.

## 19. Extension model

Projects extend Recipe v1 through:

- custom namespaced actions;
- action manifests;
- flow catalogs;
- custom assertion operators declared by manifest;
- project-owned runner bindings.

Farmslot core must not encode project-specific domains such as Example App wallet/perps. It only defines how those domains declare and execute actions/flows.

## 20. Examples

### 20.1 Composed UI proof

```json
{
  "schema_version": 1,
  "title": "Close BTC position",
  "description": "Proves an open BTC position can be closed.",
  "uses": ["example-app/perps.flows.json"],
  "proofTargets": [{ "id": "AC1", "claim": "BTC position can be closed." }],
  "startState": {
    "action": "call",
    "intent": "Converge the wallet to an open BTC long position before proof",
    "ref": "example.trade.ensure_positions",
    "phase": "start_state",
    "record": "trace_only",
    "params": {
      "network": "testnet",
      "market": "BTC",
      "state": "open",
      "side": "long",
      "notional": "10"
    }
  },
  "validate": {
    "workflow": {
      "entry": "close-position",
      "nodes": {
        "close-position": {
          "action": "call",
          "intent": "Close the open BTC position through the reusable trade flow",
          "ref": "example.trade.close_positions",
          "phase": "proof",
          "proofTarget": "AC1",
          "record": "proof_window",
          "next": "assert-closed"
        },
        "assert-closed": {
          "action": "example.trade.assert_positions",
          "intent": "Verify that no BTC position remains open",
          "market": "BTC",
          "state": "none",
          "phase": "assert",
          "proofTarget": "AC1",
          "next": "done"
        },
        "done": { "action": "end", "status": "pass" }
      }
    }
  }
}
```

### 20.2 Backend command proof

The minimum flat recipe in section 4 is sufficient. No flow catalog or visual proof is required when behavior is not visual.

## 21. Compatibility and versioning

- `schema_version: 1` remains the v1 compatibility marker.
- Composition fields are additive in v1.
- Existing flat v1 recipes remain valid when every non-terminal executable node declares `intent`.
- Future incompatible envelope changes require a new schema version.
- Historical/pre-v1 recipes may be rendered or migrated, but should not be labeled fully v1-compatible unless they satisfy this spec.

## 22. Non-goals

- Rewriting project-native test tools as primitive Farmslot actions.
- Requiring UI screenshots/videos for non-visual jobs.
- Encoding project-specific behavior in Farmslot core.
- Creating a separate replay taxonomy outside run-family/result-package models.
- Making every recipe use flow catalogs.
