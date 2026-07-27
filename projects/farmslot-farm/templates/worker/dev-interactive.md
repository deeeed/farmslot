# Worker: Interactive Dev — {{TICKET_ID}}

> **Signal file:** `./mark N` records progress. After the operator explicitly approves publication and the worker has created/pushed the PR, `./mark complete --mark-last` hands the run back to Farmslot for the operator-owned completion action.
> **Checklist marker:** Run `{{TASK_DIR}}/mark start` once when work begins (before the first `./mark N`). After each checklist item in `## Checklist`, run `{{TASK_DIR}}/mark N` with the number shown. TASK.md `STATUS: working` is not SIGNAL `status` — `./mark` owns `SIGNAL.json` during the run. If unsure, run `{{TASK_DIR}}/mark --help`. Never hand-write `SIGNAL.json`, and never signal completion while approved work is still local or unpublished.

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

## Checklist

These steps are common to every interactive run, and are the same list as `{{TASK_DIR}}/CHECKLIST.md`. The work specific to *this* task is not listed here — you write it into `{{TASK_DIR}}/artifacts/approach.md` and the operator approves it at the gate that follows. After each step, run `{{TASK_DIR}}/mark N` with the number shown below.

{{INTERACTIVE_CHECKLIST}}

## Interactive protocol

- When the operator begins steering work, set `STATUS: working` and run `{{TASK_DIR}}/mark start` before the first `./mark N`.
- The human operator drives scope, order, review, and whether/when to publish.
- Keep changes local unless the operator explicitly tells you otherwise.
- Avoid publishing, pushing, or mutating GitHub PRs unless explicitly instructed.
- Keep `{{TASK_DIR}}/CHECKLIST.md` and `{{TASK_DIR}}/inputs/dev-intake.json` current when they exist.

## Recipe validation (default proof contract)

Read `{{recipe_quality_path}}` before authoring recipe proof. Recipe v1 is the
reproducible evidence bundle for backend, CLI, gateway, protocol, and UI work;
it is not limited to visual changes.

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

- Author or update `{{TASK_DIR}}/artifacts/recipe.json` so it covers the ticket acceptance criteria and includes the required `$schema: "https://farmslot.io/schemas/recipe-v1.schema.json"`, `description`, and `workflow`.
- Use state/command actions for backend and CLI acceptance criteria. A recipe may be omitted only when no declared project action can exercise the changed behavior; record the exact limitation and the replacement deterministic validation in `artifacts/report.md`.
- Prefer adapting `{{recipe_example_banner}}` for demo-banner smoke tasks.
- Run a **fast** recipe after implementation (no video). For visual work, also run a **proof** publication replay:
  ```bash
  bash {{recipe_validate_wrapper}} ... --slow 2000 --record-video=full-run --task-dir {{TASK_DIR}}
  ```
- For visual work, promoted `artifacts/before-*.png`, `artifacts/after-*.png`, and `artifacts/after.mp4` feed the created PR via `evidence-manifest.json`.
- Write `recipe-coverage.md` when a recipe exists (gateway computes recipe-quality).
- Never inject UI state — use `ui.navigate`, `ui.wait_for`, and `ui.screenshot` through the runner.

## Completion signal

When the operator says the interactive session is complete:

1. Write `{{TASK_DIR}}/artifacts/pr-description.md` with files changed, summary, validation run (include recipe exit code + artifact paths), and any remaining risks — or update the draft from mid-run if already started.
2. If screenshots/videos prove the change, write `{{TASK_DIR}}/artifacts/evidence-manifest.json` with strict top-level keys: `version`, `preferred_mode`, `summary`, `before_after_pairs`, `standalone`, `omit`, `videos`. Use `before_after_pairs` for comparisons; omit the manifest when there is no visual evidence.
3. When `artifacts/recipe.json` exists, run:
   ```bash
   node {{farmslot_dir}}/scripts/quality/check-task-artifact-contract.mjs {{TASK_DIR}} --require-recipe-coverage-if-recipe --require-learnings
   ```
4. Write `{{TASK_DIR}}/artifacts/learnings.md` — required packaged evidence. Use 3–5 bullets on key learnings or struggles during the session; if nothing relevant: `- Nothing relevant — straightforward run; no blockers or surprises.`
5. Set the task status line to `STATUS: done`.
6. If the operator explicitly approved publication, create/push the PR, then run `{{TASK_DIR}}/mark complete --mark-last`. Farmslot holds that signal and presents the operator-owned completion actions.
7. If the operator chose a no-PR, blocked, failed, or abort outcome in Farmslot, do not manufacture a worker terminal signal; report what you did and **stop**.

**Publication may be worker-owned; final disposition remains operator-owned.** In an interactive session the worker may commit, push, and create the PR only after explicit operator approval. Once that PR exists, `mark complete --mark-last` is a handoff signal, not permission to publish: the monitor pauses the run and Farmslot presents actions such as "PR Complete" or "Detect PR + CI". Never use it with uncommitted or unpublished approved work—the unsafe failure mode from run `32909fa2`.

**Do NOT `/exit`.** Stay alive and idle in this session — the operator may attach at the publication gate to ask why/how questions before publish.
