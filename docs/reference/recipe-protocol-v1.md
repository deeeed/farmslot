# Recipe Protocol v1

Recipe Protocol v1 has two public concepts:

- **action** — one atomic capability implemented by a runner;
- **recipe** — one parameterized executable graph that can run directly or be called by another recipe.

The authoritative schema is `https://farmslot.io/schemas/recipe-v1.schema.json`.

## Minimal recipe

```json
{
  "$schema": "https://farmslot.io/schemas/recipe-v1.schema.json",
  "description": "Prove that the service is healthy.",
  "workflow": {
    "entry": "status",
    "nodes": {
      "status": {
        "action": "command",
        "cmd": "curl --fail http://127.0.0.1:3000/health",
        "intent": "Confirm the local service is healthy.",
        "next": "done"
      },
      "done": { "action": "end", "status": "pass" }
    }
  }
}
```

Required root fields are `$schema` and `workflow`. Optional root fields are `title`, `description`, `paramsSchema`, and `proofTargets`. Unknown fields are errors.

## Workflow

`workflow` contains:

- `entry` — first main-graph node;
- `nodes` — every executable node;
- `teardown` — optional cleanup-graph entry that runs after main success or failure.

Every non-terminal node requires:

- `action`;
- `intent` — one short sentence describing the human-visible goal;
- exactly `next`, or `cases` together with `default`.

`call` always uses `next`; result-based branching belongs to other actions with declared cases.

An action may return a declared `case`; the recipe maps that case to the next node:

```json
{
  "action": "switch",
  "value": "{{params.mode}}",
  "equals": "strict",
  "intent": "Choose the requested execution mode.",
  "cases": { "match": "ready" },
  "default": "not-ready"
}
```

Actions return observations and outputs, never graph destinations or final recipe status. `end.status` is `pass`, `fail`, or `unknown`.

The main and teardown graphs are acyclic, reachable, and disjoint. Bounded polling or repetition belongs inside an action. Setup is not a separate protocol phase: place preparation actions or recipe calls at the start of the main graph. Teardown is separate because the runner guarantees it after success or failure.

### Intent

`intent` is shown in HUD and trace evidence. It explains why the step matters to a human, not how the adapter implements it.

For UI actions, prefer `"Open the purchase path for the selected asset."` over `"Press buy"` or a selector name. Selectors, routes, keys, and test IDs stay in action parameters.

## Parameters and outputs

Recipes declare inputs with JSON-Schema-shaped `paramsSchema`. Defaults apply before validation; explicit values win, including `false`, `0`, and empty strings.

```json
{
  "paramsSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "market": { "type": "string", "enum": ["ETH", "BTC"], "default": "ETH" }
    }
  }
}
```

Use `{{params.market}}` for inputs and `{{outputs.nodeId.path}}` for a prior node's output. An exact template preserves its value type; an embedded template becomes a string. Data does not leak between parent and child recipes.

Action parameters are sibling fields on the node. The `params` object is reserved for a `call` boundary.

## Composition

`call` invokes another recipe from the resolved library:

```json
{
  "action": "call",
  "ref": "wallet.ensure_unlocked",
  "params": { "account": "{{params.account}}" },
  "intent": "Prepare the selected wallet account for proof.",
  "next": "proof"
}
```

`ref` is static. `params` is the only parent-to-child input boundary. The child applies its defaults, validates its parameters, runs its own teardown, and returns one output under the call node. Missing recipes, cycles, excessive depth, or invalid child parameters fail before side effects.

## Proof targets

Proof targets make claims explicit without changing execution:

```json
{
  "proofTargets": [
    { "id": "balance-visible", "claim": "The selected account balance is visible." }
  ],
  "workflow": {
    "entry": "capture",
    "nodes": {
      "capture": {
        "action": "ui.screenshot",
        "intent": "Capture the selected account balance.",
        "proves": ["balance-visible"],
        "next": "done"
      },
      "done": { "action": "end", "status": "pass" }
    }
  }
}
```

Every declared target must be covered by at least one node. Every `proves` id must be declared.

## Actions and manifests

The protocol owns graph execution, validation, trace, and evidence contracts. Runners own action implementations and platform behavior.

Every action is declared in a runner manifest with a strict parameter schema. Actions with result routing also declare their finite result cases. Project actions use namespaces such as `metamask.wallet.ensure_unlocked`; product behavior does not belong in the official action vocabulary.

Discover before authoring:

```bash
farmslot-recipe run --list --adapter mobile
farmslot-recipe run perps.smoke --describe --adapter mobile
```

Prefer an existing recipe, then an existing action. Add a shared recipe only when reuse removes repeated inference or enforces a safety invariant.

## Libraries

```text
recipes/
  wallet/ensure_unlocked.recipe.json
  extension/perps/smoke.recipe.json
  mobile/perps/smoke.recipe.json
```

Recipe identity comes from its path below `recipes/`. The configured source
alias, or directory name when no alias is provided, identifies provenance.
An initial `core`, `extension`, or `mobile` directory selects an adapter variant
without changing the id. Legacy filename suffixes remain readable during
migration, but a file cannot use both forms and duplicate adapter/id declarations
are rejected. Ordered library sources use first-match precedence; shadows are
reported, duplicates within one source are errors, and symlinks may not escape
the library root. The top-level `core`, `extension`, and `mobile` directory names
below `recipes/` are reserved for adapter selection. Existing generic domains
with one of those names must move to a different top-level domain before
adopting this layout.

## Trust and evidence

Before side effects, the runner resolves the complete call graph and binds approval to recipe and implementation digests, capabilities, environment, project root, and artifact destination.

Every run retains:

```text
recipe.json
recipe-resolution.json
resolved-recipes/<sha256>.recipe.json
summary.json
trace.json
artifact-manifest.json
```

`recipe-resolution.json` is execution provenance, not authored recipe syntax. It records the exact root and dependency digests, selected sources, adapter variants, artifact paths, and call edges. Artifact validation revalidates every recipe and rejects missing, extra, unreachable, or digest-mismatched dependencies.

## Validation order

Before side effects, a conforming runner validates the root document, manifest compatibility, library resolution, complete static call graph, parameters, and trust plan. It then executes the recipe and validates the resulting evidence package.

Simple recipes need no composition, proof targets, or teardown. Use only what the claim requires.
