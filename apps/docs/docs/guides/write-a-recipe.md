---
title: Write a recipe
---

# Write a recipe

Start from working code instead of recalling the schema.

```sh
farmslot-recipe run --list --adapter <adapter> --json
farmslot-recipe run <closest-recipe> --describe --adapter <adapter> --json
```

Call the closest recipe when its graph already fits. Copy it only when the workflow itself must change, then edit only the nodes required by the claim. Use the project's runner to search its strict action manifest and inspect exact action schemas; action discovery is project-owned.

## Minimal recipe

```json
{
  "$schema": "https://farmslot.io/schemas/recipe-v1.schema.json",
  "description": "Prove the selected runtime is ready.",
  "workflow": {
    "entry": "status",
    "nodes": {
      "status": {
        "action": "app.status",
        "intent": "Confirm the selected runtime is ready.",
        "next": "done"
      },
      "done": { "action": "end", "status": "pass" }
    }
  }
}
```

Required root fields are `$schema`, `description`, and `workflow`. Use `paramsSchema` for reusable inputs, `call` for composition, `proofTargets` for explicit claims, and `workflow.teardown` only when cleanup must be guaranteed.

Every non-terminal node needs a short human-facing `intent`. UI intent describes the visible outcome; selectors, routes, keys, and action names remain in parameters.

Action parameters are sibling fields beside `action`, `intent`, and the transition. Only a `call` node uses `params` to pass values into another recipe.

## Validate

```sh
farmslot-recipe validate ./proof.recipe.json --action-manifest <manifest.json>
farmslot-recipe run ./proof.recipe.json --action-manifest <manifest.json> --adapter <adapter>
```

Read the trace and actual evidence. A passing command is not sufficient when the claim is visual or runtime-specific.

See [Recipe Protocol v1](../reference/recipe-protocol-v1.md) for the complete contract.
