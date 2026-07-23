# Farmslot recipe quality — Command Center / gateway tasks

Read this before authoring `{{TASK_DIR}}/artifacts/recipe.json`.

## Contract

- Graph envelope: canonical `$schema`, required `description`, `workflow.entry`, `workflow.nodes`, and `intent` on every non-terminal executable node.
- Runner: `{{recipe_validate_wrapper}}` with `{{recipe_manifest_path}}`.
- Discovery: before authoring, inspect action names in `{{recipe_manifest_path}}`, then read only the relevant metadata/examples and existing recipes under `{{farmslot_dir}}/docs/examples/recipes/farmslot/`; reuse declared capabilities instead of guessing action names.
- Doctor: `cd {{REPO}} && node apps/command-center/scripts/agentic/recipe-doctor.mjs --cdp-port {{CDP_PORT}} --gateway-port {{WATCHER_PORT}} --json`
- Fast validation run (no video):
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
- **PR-grade proof run** (slow + full-run MP4 — required for Command Center UI changes):
  ```bash
  cd {{REPO}}
  bash apps/command-center/scripts/debug-chrome.sh
  bash {{recipe_validate_wrapper}} \
    --recipe {{TASK_DIR}}/artifacts/recipe.json \
    --artifacts-dir {{TASK_DIR}}/artifacts/recipe-run \
    --runtime-dir {{RUNTIME_DIR}} \
    --platform {{PLATFORM}} \
    --cdp-port {{CDP_PORT}} \
    --gateway-port {{WATCHER_PORT}} \
    --slot-id {{SLOT}} \
    --slow 2000 \
    --record-video=full-run \
    --task-dir {{TASK_DIR}}
  ```
  (`validate-recipe.sh` auto-promotes screenshots + `after.mp4` when `--task-dir` is set; or run `{{recipe_sync_evidence_cmd}} --task-dir {{TASK_DIR}} --require-video` manually.)
- Gateway replay uses the same hook via `hooks.recipe_run` in `projects/farmslot-farm/project.json`. The hook routes `cli`/web runs to Command Center and `ios`/`android` runs to Companion, but both routes must emit the same Recipe v1 package under `--artifacts-dir`: `summary.json`, `trace.json`, and `artifact-manifest.json`; copy the resolved `recipe.json` when practical.
- If you need to inspect the package directly, run `cd {{REPO}} && yarn --cwd apps/command-center farmslot recipe artifacts validate {{TASK_DIR}}/artifacts/recipe-run` (append `--recipe {{TASK_DIR}}/artifacts/recipe-run/recipe.json` only when that file was copied).

## Proof rules

1. Cover every acceptance criterion in `recipe-coverage.md` with `state`, `visual`, or `mixed` proof mode.
2. UI changes require real navigation via `ui.navigate` / `ui.wait_for` / `ui.screenshot` — never inject store/DOM state.
3. Visual ACs need **viewport-visible** assertions (`expected: "visible"` or absent/hidden negatives) before screenshots.
4. Screenshot filenames should encode proof: `before-<claim>.png`, `after-<claim>.png`.
5. Assert the actual feature: if you remove the code, the recipe must fail.

## PR evidence package (gateway embeds this in created PRs)

After the proof run, `artifacts/` must contain promotable media the gateway can upload:

| File | Source |
|------|--------|
| `artifacts/before-*.png` | recipe `screenshots/before-*` |
| `artifacts/after-*.png` | recipe `screenshots/after-*` or `demo-*` |
| `artifacts/after.mp4` | `recipe-run/videos/recipe-run.mp4` via `sync-recipe-evidence.sh` |

Write `{{TASK_DIR}}/artifacts/evidence-manifest.json`:

```json
{
  "version": 1,
  "preferred_mode": "screenshots",
  "summary": "One line describing what reviewers should see.",
  "before_after_pairs": [
    {
      "label": "Demo banner absent vs present",
      "covers": ["ac1", "ac2"],
      "before": "artifacts/before-demo-banner.png",
      "after": "artifacts/after-demo-banner.png"
    }
  ],
  "videos": {
    "after": "artifacts/after.mp4",
    "preferred": true,
    "note": "Full recipe replay with HUD at 2s slow playback"
  }
}
```

Rules:
- Paths must resolve under `artifacts/` (gateway normalizes `artifacts/foo.png`).
- Do not reference files that `sync-recipe-evidence.sh` did not promote.
- For UI features, `videos.after` is **required** unless capture-helper doctor fails (document the doctor error in `videos.note` and keep screenshots).
- `pr-description.md` **Screenshots/Recordings** section stays a placeholder — gateway replaces it from this manifest.

Also write `{{TASK_DIR}}/artifacts/recipe-coverage.md`. Do **not** author `recipe-quality.json` — the gateway computes recipe quality from your `recipe.json` + coverage.

Validate before done:

```bash
node {{farmslot_dir}}/scripts/quality/check-task-artifact-contract.mjs {{TASK_DIR}} --require-recipe-coverage-if-recipe
```

## Examples

- Workspace smoke: `{{farmslot_dir}}/docs/examples/recipes/farmslot/command-center-ui.recipe.json`
- Demo banner: `{{recipe_example_banner}}`
