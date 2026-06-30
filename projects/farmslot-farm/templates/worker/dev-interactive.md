# Worker: Interactive Dev — {{TICKET_ID}}

> **Signal file:** `./mark N` for progress; terminal `SIGNAL.json` only when operator asks.
> **Checklist marker:** Run `{{TASK_DIR}}/mark start` once when work begins (before the first `./mark N`). After each checklist item, run `{{TASK_DIR}}/mark N` (use the visible 1-based step number). TASK.md `STATUS: working` is not SIGNAL `status` — `./mark` owns `SIGNAL.json` during the run. If unsure, run `{{TASK_DIR}}/mark --help`. Terminal: `{{TASK_DIR}}/mark complete --outcome success` (never `echo > SIGNAL.json`).

---

## Task

```text
TICKET: {{TICKET_ID}}
TICKET_URL: {{TICKET_URL}}
TITLE: {{TICKET_TITLE}}
BRANCH: {{BRANCH}}
TASK_DIR: {{TASK_DIR}}
SESSION: {{SESSION}}
REPO: {{REPO}}
PLATFORM: {{PLATFORM}}
CDP_PORT: {{CDP_PORT}}
WATCHER_PORT: {{WATCHER_PORT}}
RUNTIME_DIR: {{RUNTIME_DIR}}
SLOT: {{SLOT}}
STATUS: pending
```

## Description

{{DESCRIPTION}}

## Acceptance Criteria

{{ACCEPTANCE_CRITERIA}}

## Interactive protocol

- When the operator begins steering work, set `STATUS: working` and run `{{TASK_DIR}}/mark start` before the first `./mark N`.
- The human operator drives scope, order, review, and whether/when to publish.
- Keep changes local unless the operator explicitly tells you otherwise.
- Avoid publishing, pushing, or mutating GitHub PRs unless explicitly instructed.
- Keep `{{TASK_DIR}}/CHECKLIST.md` and `{{TASK_DIR}}/inputs/dev-intake.json` current when they exist.

## Recipe validation (required for Command Center UI work)

Read `{{recipe_quality_path}}` before claiming any UI AC is proven.

```bash
cd {{REPO}}
bash {{recipe_validate_wrapper}} \
  --recipe <path-to-recipe.json> \
  --artifacts-dir {{TASK_DIR}}/artifacts/recipe-run \
  --runtime-dir {{RUNTIME_DIR}} \
  --platform {{PLATFORM}} \
  --cdp-port {{CDP_PORT}} \
  --gateway-port {{WATCHER_PORT}} \
  --slot-id {{SLOT}}
```

- Author or update `{{TASK_DIR}}/artifacts/recipe.json` so it covers the ticket acceptance criteria.
- Prefer adapting `{{recipe_example_banner}}` for demo-banner smoke tasks.
- Run a **fast** recipe after implementation (no video), then a **proof** run for publication:
  ```bash
  bash {{recipe_validate_wrapper}} ... --slow 2000 --record-video=full-run --task-dir {{TASK_DIR}}
  ```
- Promoted `artifacts/before-*.png`, `artifacts/after-*.png`, and `artifacts/after.mp4` feed the created PR via `evidence-manifest.json`.
- Write `recipe-coverage.md` when a recipe exists (gateway computes recipe-quality).
- Never inject UI state — use `ui.navigate`, `ui.wait_for`, and `ui.screenshot` through the runner.

## Completion signal

When the operator says the interactive session is complete:

1. Write `{{TASK_DIR}}/artifacts/report.md` with files changed, summary, validation run (include recipe exit code + artifact paths), and any remaining risks.
2. If screenshots/videos prove the change, write `{{TASK_DIR}}/artifacts/evidence-manifest.json` with strict top-level keys: `version`, `preferred_mode`, `summary`, `before_after_pairs`, `standalone`, `omit`, `videos`. Use `before_after_pairs` for comparisons; omit the manifest when there is no visual evidence.
3. When `artifacts/recipe.json` exists, run:
   ```bash
   node {{farmslot_dir}}/scripts/quality/check-task-artifact-contract.mjs {{TASK_DIR}} --require-recipe-coverage-if-recipe
   ```
4. Set the task status line to `STATUS: done`.
5. Write the completion signal:

```bash
{{TASK_DIR}}/mark complete --outcome success --mark-last
```

**Do NOT `/exit`.** Stay alive and idle in this session — the operator may attach at the publication gate to ask why/how questions before publish.