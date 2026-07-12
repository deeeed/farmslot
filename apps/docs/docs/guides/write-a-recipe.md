---
title: Write a recipe
---

# Write a recipe

This page is a starter checklist for turning acceptance criteria into a validation recipe.

## Recipe checklist

A good recipe should answer:

- What behavior does this prove?
- What preconditions must be true?
- Which app/runtime action exercises the behavior?
- Which assertion proves success?
- Which screenshot, video, log, or JSON artifact helps a reviewer trust the result?
- How does the recipe clean up after itself?

## Skeleton

```json
{
  "schema_version": 1,
  "title": "Example recipe",
  "description": "Proves one acceptance criterion with reviewable evidence.",
  "validate": {
    "workflow": {
      "entry": "start",
      "nodes": {
        "start": {
          "action": "command",
          "command": "echo run project setup",
          "next": "verify"
        },
        "verify": {
          "action": "assert_json",
          "target": "./state.json",
          "assert": { "path": "$.ok", "equals": true },
          "next": "end"
        },
        "end": {
          "action": "end"
        }
      }
    }
  }
}
```

Project adapters can add richer actions such as `ui.navigate`, `ui.screenshot`, `cdp.evaluate`, or product-specific namespaced actions.

After supported UI actions, runners may record passive `observations` in
`trace.json`, including `ui.screen` and bounded `ui.visible.items`. Use these
items to author the next node from stable handles (`test_id`, selector, label,
role). Observations are not proof and never control graph transitions; keep
using `ui.wait_for`, assertions, screenshots, or explicit evidence nodes for
claims that must pass or fail the recipe.

## Full v1 contract

For composed recipes, reusable start-state flows, proof-target mapping, HUD/overlay visual proof, and artifact-package requirements, see [Recipe Protocol v1](../reference/recipe-protocol-v1.md).
