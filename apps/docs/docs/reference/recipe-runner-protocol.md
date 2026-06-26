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

## Command Center replay options

Command Center may re-run a bound recipe against a warm slot through
`hooks.recipe_run`. Optional replay flags are **capability-gated** in
`project.json` and appended by the gateway only when the project opts in.

### Project capability flags

| Field | When `true` | Gateway may append |
| ----- | ----------- | ------------------ |
| `recipe_run_supports_playback_slow` | Runner honors slowed live playback | `--slow <ms>` (`100`–`60000`) |
| `recipe_run_supports_video_recording` | Runner honors harness video recording | `--record-video=full-run` |

When a flag is absent or `false`, the gateway strips the corresponding UI
request and may emit a warning instead of failing the replay.

### Canonical video contract (Farmslot harness)

Video replay uses the **`@farmslot/recipe-harness`** contract — not ad-hoc
platform recorders (`simctl recordVideo`, `adb screenrecord`, etc.) as the
primary path.

**Gateway → hook command suffix:**

```bash
--record-video=full-run
```

**Harness CLI** (direct runner invocation):

```bash
recipe-harness run recipe.json \
  --artifacts-dir artifacts/run \
  --action-manifest path/to/manifest.json \
  --record-video            # means full-run
# or explicitly:
  --record-video=full-run
```

**Harness API:**

```ts
runner.run({
  artifactsDir: 'artifacts/run',
  recordVideo: 'full-run', // or false / omitted
});
```

**Behavior when enabled:**

1. Resolve one recording target (CLI flags or project `RecordingTargetProvider`).
2. Run `capture-helper doctor --json` on macOS; fail with actionable diagnostics when unavailable.
3. Record one whole-recipe MP4 for the run duration.
4. Write `videos/recipe-run.mp4` under `{{artifacts_dir}}`.
5. Register the video in `artifact-manifest.json` with `type: "video"`.

### Project runner compatibility layer

Farmslot-compatible project runners sit **on top of** the harness contract and
should accept the gateway-appended flags their `recipe_run` hook receives.

Rules:

1. **Shell hooks** must forward unknown trailing replay flags to the underlying
   runner (do not parse-and-drop gateway suffixes).
2. **Project CLIs** should accept `--record-video=full-run` and may accept
   `--record` as a legacy alias mapping to `full-run`.
3. **Target resolution** is project-owned via `RecordingTargetProvider` (browser
   PID, simulator window, etc.); capture itself stays in harness/capture-helper.

### Slow playback

When `recipe_run_supports_playback_slow: true`, Command Center may append
`--slow <ms>` for human-readable live playback. The gateway accepts
`100`–`60000` milliseconds. Projects that do not opt in keep replay commands
free of playback flags.

### macOS capture-helper requirements

On macOS slots, harness recording uses the Farmslot-installed `capture-helper`
provider:

- `capture-helper doctor --json` for setup/permission checks
- stable target resolution for the slot browser or simulator window
- MP4 artifacts under `{{artifacts_dir}}/videos/`

Non-macOS runners may use a native recorder only when they still emit the same
Recipe v1 artifact package contract (`artifact-manifest.json` entry for the
video, non-empty MP4, positive duration when `ffprobe` is available).
