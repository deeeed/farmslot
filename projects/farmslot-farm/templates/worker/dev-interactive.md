# Worker: Interactive Dev — {{TICKET_ID}}

> **Signal file:** `./mark N` for progress only. This flow has **no worker terminal signal** — the operator ends the run from Farmslot.
> **Checklist marker:** Run `{{TASK_DIR}}/mark start` once when work begins (before the first `./mark N`). After each checklist item in `## Checklist`, run `{{TASK_DIR}}/mark N` with the number shown. TASK.md `STATUS: working` is not SIGNAL `status` — `./mark` owns `SIGNAL.json` during the run. If unsure, run `{{TASK_DIR}}/mark --help`. Do **not** run `mark complete`, `mark no-change` or `mark blocked` here, and never hand-write `SIGNAL.json`.

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

These steps are common to every interactive run. The work specific to *this* task is not listed here — you write it into `{{TASK_DIR}}/artifacts/approach.md` at step 2 and the operator approves it at step 3. After each step, run `{{TASK_DIR}}/mark N` with the number shown.

- [ ] **1. Read the task and repository context** — the sections above, plus `CLAUDE.md` and `{{TASK_DIR}}/inputs/dev-intake.json` when present.
- [ ] **2. Write `{{TASK_DIR}}/artifacts/approach.md`** — affected files, implementation plan, validation plan, and anything you propose to leave out.
- [ ] **3. HUMAN GATE — present the approach.** State what you intend to change and how you will prove it. **STOP and wait for the operator.**
- [ ] **4. Implement the approved change** on `{{BRANCH}}`. Commit as you go — uncommitted work is lost when the slot is reclaimed.
- [ ] **5. Validate** — targeted tests, lint and typecheck for what you touched. If an acceptance criterion needs Command Center UI proof, run the recipe validation below. If you skip validation, record why in this TASK file.
- [ ] **6. HUMAN GATE — present the diff and validation.** **STOP and wait for the operator.**
- [ ] **7. Write `{{TASK_DIR}}/artifacts/report.md` and `{{TASK_DIR}}/artifacts/learnings.md`** — what changed, what was validated, what remains unproven.
- [ ] **8. Wait for the operator to choose a completion action in Farmslot.** Do not end the session yourself.

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

- Author or update `{{TASK_DIR}}/artifacts/recipe.json` so it covers the ticket acceptance criteria and includes the required `$schema: "https://farmslot.io/schemas/recipe-v1.schema.json"`, `description`, and `workflow`.
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

1. Write `{{TASK_DIR}}/artifacts/pr-description.md` with files changed, summary, validation run (include recipe exit code + artifact paths), and any remaining risks — or update the draft from mid-run if already started.
2. If screenshots/videos prove the change, write `{{TASK_DIR}}/artifacts/evidence-manifest.json` with strict top-level keys: `version`, `preferred_mode`, `summary`, `before_after_pairs`, `standalone`, `omit`, `videos`. Use `before_after_pairs` for comparisons; omit the manifest when there is no visual evidence.
3. When `artifacts/recipe.json` exists, run:
   ```bash
   node {{farmslot_dir}}/scripts/quality/check-task-artifact-contract.mjs {{TASK_DIR}} --require-recipe-coverage-if-recipe --require-learnings
   ```
4. Write `{{TASK_DIR}}/artifacts/learnings.md` — required packaged evidence. Use 3–5 bullets on key learnings or struggles during the session; if nothing relevant: `- Nothing relevant — straightforward run; no blockers or surprises.`
5. Set the task status line to `STATUS: done`.
6. Report what you did and **stop**.

**Completion is the operator's, not yours.** Do not run `mark complete`, `mark no-change` or `mark blocked` on this flow — the operator resolves the run from Farmslot ("Done no PR", "PR Complete", "Blocked", …). A worker-authored terminal signal here ends the run behind the operator's back: run `32909fa2` did exactly that and was marked done with 26 files uncommitted, no branch commits and no PR.

**Do NOT `/exit`.** Stay alive and idle in this session — the operator may attach at the publication gate to ask why/how questions before publish.
