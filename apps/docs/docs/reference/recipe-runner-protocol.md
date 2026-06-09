---
title: Recipe Runner Protocol
---

# Recipe Runner Protocol

The Recipe Runner Protocol is the project-facing side of Recipe Protocol v1. It
explains how a project exposes recipes to Farmslot without moving project logic
into Farmslot itself.

For the field-level recipe schema, see [Recipe Protocol v1](./recipe-protocol-v1.md).

## Contract layers

| Layer            | Required contract                                                                              | Owner             |
| ---------------- | ---------------------------------------------------------------------------------------------- | ----------------- |
| Recipe graph     | `schema_version`, `title`, `description`, `validate.workflow.entry`, `validate.workflow.nodes` | Farmslot protocol |
| Project hook     | A runner command receives a recipe path and artifact directory                                 | Project config    |
| Action manifest  | Official actions plus runner-declared custom actions                                           | Runner package    |
| Adapters         | Runtime implementation for each declared action                                                | Project runner    |
| Artifact package | `recipe.json`, `summary.json`, `trace.json`, `artifact-manifest.json`                          | Harness + runner  |
| Review surface   | Trace, screenshots, video, logs, and verdict rendering                                         | Farmslot UI       |

The protocol standardizes orchestration and evidence. It does not force every
project to rewrite native tests as primitive UI actions.

## Project hooks

A Farmslot project can expose recipe support through `project.json` hooks:

```json
{
  "hooks": {
    "recipe_run": "example-app-recipe run --recipe {{recipe_path}} --artifacts-dir {{artifacts_dir}}",
    "recipe_action_manifest": "example-app-recipe manifest --json",
    "recipe_doctor": "example-app-recipe doctor --json"
  }
}
```

Important hook variables:

| Variable                                                      | Meaning                                  |
| ------------------------------------------------------------- | ---------------------------------------- |
| `{{recipe_path}}`                                             | The selected recipe file.                |
| `{{artifacts_dir}}`                                           | Dedicated output directory for this run. |
| `{{slot_id}}`                                                 | Farmslot slot identifier.                |
| `{{runtime_dir}}`                                             | Slot runtime directory.                  |
| `{{artifact_dir}}`                                            | Slot artifact root.                      |
| `{{cdp_port}}`, `{{port}}`, `{{simulator}}`, `{{adb_serial}}` | Runtime-specific resources when present. |

A v1 `recipe_run` hook must make recipe input and artifact output explicit. Hidden
output paths make review and replay unreliable. UI-capable projects should treat
video proof as a normal recipe-run capability: install/doctor the recorder during
runtime setup, record into `{{artifacts_dir}}` when requested, and publish the
video through `artifact-manifest.json`.

## Action manifest

The action manifest is the runner's executable capability catalog. It tells the
agent and validator which actions are available before a recipe runs.

```json
{
  "runner_protocol_version": 1,
  "action_registry_version": 1,
  "supported_official_actions": ["ui.press", "ui.scroll", "app.hud", "end"],
  "action_metadata": {
    "ui.press": {
      "description": "Press a visible UI target using selector, test id, text, or coordinates.",
      "examples": [
        {
          "description": "Press a button by test id.",
          "node": { "action": "ui.press", "test_id": "submit-button" }
        }
      ]
    }
  },
  "custom_actions": [
    {
      "name": "checkout.ensure_cart",
      "owner": "checkout",
      "description": "Converge the cart to the requested item set.",
      "schema": { "type": "object" }
    }
  ],
  "pre_conditions": [
    {
      "id": "runtime.ready",
      "description": "The app runtime is reachable before recipe execution.",
      "failure_kind": "environment"
    }
  ]
}
```

Validation must fail when a recipe uses an undeclared action or precondition. A
manifest is not just documentation; it is the contract used to build and review
recipes.

## Adapter boundary

Adapters implement declared actions. Keep the boundary strict:

- official `ui.*`, `app.*`, `cdp.*`, and core actions stay generic;
- product/domain actions are namespaced, for example `example.trade.place_order`;
- task-specific assertions should stay in recipes, not become reusable custom actions;
- domain adapters should be parameterized before new action names are added.

For UI proof, prefer user-visible `ui.*` actions. For setup or teardown, a domain
adapter can converge state faster, but trace must still show what happened.

## Doctor/readiness hook

`recipe_doctor` reports whether the runner can execute recipes in the current
slot:

```json
{
  "runner_protocol_version": 1,
  "status": "pass",
  "checks": [
    {
      "id": "runtime.ready",
      "status": "pass",
      "category": "runtime",
      "message": "App control bridge is reachable."
    }
  ]
}
```

Recommended categories: `tools`, `harness`, `runtime`, `fixtures`, `isolation`,
and `secrets`. Failures should distinguish environment/setup problems from
product assertion failures.

## Artifact package

Every successful or failed run should emit the same portable package shape:

| File                     | Purpose                                                               |
| ------------------------ | --------------------------------------------------------------------- |
| `recipe.json`            | Resolved recipe used for the run.                                     |
| `summary.json`           | Top-level status, counts, duration, harness/runner metadata.          |
| `trace.json`             | Ordered execution trace with redacted outputs and errors.             |
| `artifact-manifest.json` | Typed index of screenshots, videos, logs, JSON, metrics, and reports. |

Farmslot review and replay tools consume this package without project-specific UI
code.
