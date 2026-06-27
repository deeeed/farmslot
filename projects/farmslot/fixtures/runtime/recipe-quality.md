# Farmslot recipe quality — Command Center / gateway tasks

Read this before authoring `{{TASK_DIR}}/artifacts/recipe.json`.

## Contract

- Graph envelope: `schema_version: 1`, `validate.workflow.entry`, `validate.workflow.nodes`, `intent` on every executable node.
- Runner: `{{recipe_validate_wrapper}}` with `{{recipe_manifest_path}}`.
- Doctor: `cd {{REPO}} && node apps/command-center/scripts/agentic/recipe-doctor.mjs --cdp-port {{CDP_PORT}} --gateway-port {{WATCHER_PORT}} --json`
- Live run:
  ```bash
  cd {{REPO}}
  bash {{recipe_validate_wrapper}} \
    --recipe {{TASK_DIR}}/artifacts/recipe.json \
    --artifacts-dir {{TASK_DIR}}/artifacts/recipe-run \
    --runtime-dir {{RUNTIME_DIR}} \
    --platform {{PLATFORM}} \
    --cdp-port {{CDP_PORT}} \
    --gateway-port {{WATCHER_PORT}} \
    --slot-id {{SLOT}}
  ```
- Gateway replay uses the same hook via `hooks.recipe_run` in `projects/farmslot/project.json`.

## Proof rules

1. Cover every acceptance criterion in `recipe-coverage.md` with `state`, `visual`, or `mixed` proof mode.
2. UI changes require real navigation via `ui.navigate` / `ui.press` / `ui.set_input` — never inject store/DOM state to fake proof.
3. Assert the actual feature: if you remove the code, the recipe must fail.
4. Use `ui.wait_for` with `expected: "absent"` for negative cases; use `ui.screenshot` for visual ACs after the assertion passes.
5. Backend-only work may use `command` + `assert_output` nodes; skip screenshots when there is no visual surface.

## Artifact package

Write under `{{TASK_DIR}}/artifacts/recipe-run/`:

- `summary.json`, `trace.json`, `artifact-manifest.json`, resolved `recipe.json`

Also write:

- `{{TASK_DIR}}/artifacts/recipe-coverage.md` — one row per AC with verdict
- `{{TASK_DIR}}/artifacts/recipe-quality.json` — compact verdict (`PASS` / `FAIL`) referencing coverage

Validate the contract before signaling done:

```bash
node {{farmslot_dir}}/scripts/quality/check-task-artifact-contract.mjs {{TASK_DIR}} --require-recipe-quality-if-recipe --require-recipe-coverage-if-recipe
```

## Examples

- Workspace smoke: `{{farmslot_dir}}/docs/examples/recipes/farmslot/command-center-ui.recipe.json`
- Demo banner: `{{recipe_example_banner}}`