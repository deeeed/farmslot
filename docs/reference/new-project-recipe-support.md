# New Project Recipe Support

This guide shows the smallest useful path for adding v1 Farmslot recipe support
to a new project. It complements the canonical [Recipe Runner Protocol](../reference/recipe-runner-protocol.md)
and project config overview in [`projects/README.md`](../../projects/README.md).

## Minimal integration

A project needs three things:

1. A project config hook that runs recipes.
2. A runner that understands the shared `validate.workflow` graph envelope.
3. An artifact package that Farmslot can render generically.

Example `project.json` excerpt:

```json
{
  "name": "my-service-farm",
  "hooks": {
    "recipe_run": "bash scripts/agentic/validate-recipe.sh --recipe {{recipe_path}} --artifacts-dir {{artifacts_dir}}"
  },
  "recipe_run_supports_playback_slow": false,
  "recipe_run_supports_video_recording": false
}
```

Set `recipe_run_supports_playback_slow` to `true` only when the runner supports a
slow/live replay option that Command Center may append. Set
`recipe_run_supports_video_recording` to `true` only when the runner supports the
gateway-appended `--record-video=full-run` flag and the harness video artifact
contract (`videos/recipe-run.mp4` + `artifact-manifest.json` registration).

Canonical replay contract:
[Recipe Runner Protocol — Command Center replay options](recipe-runner-protocol.md#command-center-replay-options).

## Backend/API recipe example

A backend project can still use the shared graph envelope while delegating real
validation to native tools:

```json
{
  "$schema": "https://farmslot.io/schemas/recipe-v1.schema.json",
  "schema_version": 1,
  "inputs": {},
  "validate": {
    "workflow": {
      "entry": "run-pytest",
      "nodes": {
        "run-pytest": {
          "action": "command",
          "intent": "Run the checkout API smoke suite and write its report",
          "cmd": "pytest tests/api/test_checkout.py --json-report --json-report-file=reports/pytest.json",
          "next": "collect-artifacts"
        },
        "collect-artifacts": {
          "action": "index_artifacts",
          "intent": "Publish the pytest report and stdout log for review",
          "artifacts": ["reports/pytest.json", "logs/stdout.log"],
          "next": "done"
        },
        "done": { "action": "end", "status": "pass" }
      },
      "playback": { "mode": "off", "slow_ms": 2000 }
    }
  }
}
```

The project runner owns `command` and `index_artifacts` behavior. Farmslot owns the
shape of the graph and the artifact package.

## UI recipe example

A UI project can expose adapter actions and slow playback:

```json
{
  "$schema": "https://farmslot.io/schemas/recipe-v1.schema.json",
  "schema_version": 1,
  "title": "Settings page renders account controls",
  "description": "Navigates to settings, verifies controls, and captures evidence.",
  "validate": {
    "workflow": {
      "entry": "open-settings",
      "nodes": {
        "open-settings": {
          "action": "ui.navigate",
          "target": "settings",
          "intent": "Open the Settings page",
          "next": "assert-controls"
        },
        "assert-controls": {
          "action": "ui.wait_for",
          "test_id": "account-controls",
          "intent": "Verify account controls are visible",
          "next": "screenshot-settings"
        },
        "screenshot-settings": {
          "action": "ui.screenshot",
          "intent": "Capture proof that Settings account controls are visible",
          "path": "screenshots/settings-controls.png",
          "note": "Settings page with account controls visible",
          "next": "done"
        },
        "done": { "action": "end", "status": "pass" }
      },
      "playback": { "mode": "auto", "slow_ms": 2000 }
    }
  }
}
```

Every non-terminal recipe node must include `intent`: a short human-facing
sentence explaining what the agent is trying to do now. This is the
agent-to-human communication line. UI-capable runners show `intent` in the HUD
during live replay/recording; headless runners record it in trace/status/review
artifacts. Do not use generic text, action names, node IDs, selectors, test IDs,
recipe titles, recipe descriptions, or screenshot notes as intent.

`note` is optional artifact caption text for screenshots/videos. It is not the
HUD text. If no `note` is provided, evidence captions may fall back to the node
`intent`.

## Required outputs

Write outputs under the `{{artifacts_dir}}` supplied by Farmslot:

```text
artifacts-dir/
  summary.json
  trace.json
  artifact-manifest.json
  recipe.json or workflow.json
  logs/
  reports/
  screenshots/        # UI projects when visual evidence exists
  videos/             # UI projects when recording is available
```

`artifact-manifest.json` should index artifacts by stable type:

```json
{
  "version": 1,
  "runStatus": "pass",
  "artifacts": [
    {
      "path": "reports/pytest.json",
      "type": "json",
      "label": "pytest report",
      "nodeId": "run-pytest",
      "mimeType": "application/json"
    }
  ]
}
```

`artifact-manifest.json` is the v1 output target. Extension, Mobile, and Audiolab runners should emit this manifest directly so Command Center and Mobile Companion can consume typed artifacts without filename inference.

## Validate the shared contract

Use the Farmslot v1 contract validator before wiring a new project into live
slots:

```bash
cd apps/command-center
yarn farmslot recipe validate ../../docs/examples/recipes/backend-command-v1.recipe.json
yarn farmslot recipe validate ../../docs/examples/recipes/ui-live-v1.recipe.json
```

When you have a real artifact directory, include it so the validator can verify
`summary.json`, `trace.json`, `artifact-manifest.json`, manifest paths, and
optional `nodeId` links:

```bash
yarn farmslot recipe validate path/to/recipe.json --artifact-dir path/to/artifacts
```

The validator is intentionally generic. It proves the `validate.workflow` graph
and typed artifact package are compatible with Farmslot, then leaves
adapter/action-specific semantics to the project runner. See
`docs/examples/recipes/` for copyable backend/API and UI-class sample recipes.
The `docs/examples/recipes/farmslot/` directory contains repo-local
self-validation fixtures that demonstrate the same package shape for Command
Center, Gateway, Mobile Companion, live replay, and onboarding surfaces.

## Validator split

Use two validator layers:

- **Farmslot compatibility validation:** graph envelope, transitions, terminal
  nodes, playback metadata, and artifact package shape.
- **Project action validation:** action-specific fields, native tool availability,
  registered flow references, device/browser requirements, and project safety
  rules.

This split lets Command Center and Mobile Companion render recipe evidence
consistently while each project keeps native execution details in its own repo.

## Reference implementations

Use existing farms as patterns:

- Example Browser App: CDP/browser UI runner and graph validator under
  `projects/example-browser-farm/fixtures/agentic/recipes/`.
- Example Mobile App: worker templates reference the app-local
  `scripts/perps/agentic/validate-recipe.sh` runner and mobile flow library.
- Audiolab: templates reference app-local `scripts/agentic/validate-flow-schema.sh`
  and `validate-recipe.sh` for non-Example App project validation.

Do not copy project-specific actions into Farmslot core scripts. Add actions to
the project runner or adapter and keep Farmslot core focused on the shared graph
and artifact contracts.
