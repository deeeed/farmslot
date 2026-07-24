---
title: Recipe Protocol v1
description: Canonical contract for parameterized, composable Farmslot recipes.
---

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

`workflow` contains `entry`, `nodes`, and an optional `teardown` entry. Teardown runs after main success or failure.

Every non-terminal node requires `action`, a short human-facing `intent`, and exactly `next`, or `cases` together with `default`. `call` always uses `next`; other actions may return a declared case and the recipe owns the destination. Actions never return graph destinations or final recipe status. `end.status` is `pass`, `fail`, or `unknown`.

The main and teardown graphs are acyclic, reachable, and disjoint. Bounded repetition belongs inside an action. Setup is not a separate phase: put preparation actions or recipe calls at the start of the main graph.

### Intent

`intent` is shown in HUD and trace evidence. It explains why the step matters to a human, not how the adapter implements it.

For UI actions, prefer `"Open the purchase path for the selected asset."` over `"Press buy"` or a selector name. Selectors, routes, keys, and test IDs stay in action parameters.

## Parameters and outputs

Recipes declare inputs with `paramsSchema`. Defaults apply before validation; explicit values win, including falsy values.

Use `{{params.name}}` for inputs and `{{outputs.nodeId.path}}` for a prior node's output. An exact template preserves its type; an embedded template becomes a string. Data does not leak between parent and child recipes.

Action parameters are sibling fields on the node. The `params` object is reserved for the `call` boundary shown below.

## Composition

```json
{
  "action": "call",
  "ref": "wallet.ensure_unlocked",
  "params": { "account": "{{params.account}}" },
  "intent": "Prepare the selected wallet account for proof.",
  "next": "proof"
}
```

`call.ref` is static and `call.params` is the only parent-to-child input boundary. The child applies its defaults, validates its inputs, runs its own teardown, and returns one output under the call node. The complete call graph resolves before side effects.

## Proof targets

`proofTargets` declares semantic `{ id, claim }` pairs. Nodes link evidence with `proves: [id]`. Every target must be covered, and every referenced id must be declared.

## Actions and libraries

Every action is declared in a runner manifest with a strict parameter schema. Actions with result routing also declare their finite result cases. Product actions use namespaces; product behavior does not belong in the official action vocabulary.

Recipe identity comes from its path below a library's `recipes/` directory. Adapter suffixes select variants without changing the id. Ordered sources use first-match precedence; shadows are reported and same-source duplicates are errors.

```bash
farmslot-recipe run --list --adapter mobile
farmslot-recipe run perps.smoke --describe --adapter mobile
```

Prefer an existing recipe, then an existing action. Add a shared recipe only when reuse removes repeated inference or enforces a safety invariant.

## Trust and evidence

Before side effects, the runner resolves the complete call graph and binds approval to recipe and implementation digests, capabilities, environment, project root, and artifact destination.

Every run retains `recipe.json`, `recipe-resolution.json`, digest-keyed dependency recipes, `summary.json`, `trace.json`, and `artifact-manifest.json`. `recipe-resolution.json` is execution provenance, not authored recipe syntax.

Simple recipes need no composition, proof targets, or teardown. Use only what the claim requires.
