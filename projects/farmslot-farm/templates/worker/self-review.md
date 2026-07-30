# Worker: Self-Review

> Operator-requested publication review for a completed Farmslot run.
> Execute the checklist directly. Do not use shortcut review commands.

> Checklist marker: run `{{TASK_DIR}}/mark start` once, then `{{TASK_DIR}}/mark N`
> after each checklist item. Finish with `{{TASK_DIR}}/mark complete --mark-last`.

## Task

```
TASK_DIR: {{TASK_DIR}}
REPO: {{REPO}}
PLATFORM: {{PLATFORM}}
WATCHER_PORT: {{WATCHER_PORT}}
CDP_PORT: {{CDP_PORT}}
SESSION: {{SESSION}}
RUNTIME_DIR: {{RUNTIME_DIR}}
TICKET: {{TICKET}}
VALIDATION_DEPTH: {{VALIDATION_DEPTH}}
STATUS: pending
```

## Checklist

- [ ] **1. Start** - set `STATUS: working`, then run `{{TASK_DIR}}/mark start` and `{{TASK_DIR}}/mark 1`.
- [ ] **2. Read quality rules**:
  ```bash
  cd {{REPO}}
  cat {{RUNTIME_DIR}}/review-quality.md 2>/dev/null || true
  ```
- [ ] **3. Inspect the worker output**:
  ```bash
  cd {{REPO}}
  git diff main...HEAD --stat
  git diff main...HEAD
  cat {{TASK_DIR}}/artifacts/pr-description.md 2>/dev/null || true
  cat {{TASK_DIR}}/artifacts/recipe-coverage.md 2>/dev/null || true
  cat {{TASK_DIR}}/artifacts/recipe-quality.json 2>/dev/null || true
  ```
- [ ] **4. Run focused validation** - prefer the worker-recorded commands. For command-center changes, run:
  ```bash
  cd {{REPO}}/apps/command-center && yarn typecheck
  ```
  Then run changed tests listed in the worker report or visible in the diff.
- [ ] **5. Audit evidence**:
  ```bash
  cd {{REPO}}
  node {{farmslot_dir}}/scripts/quality/check-task-artifact-contract.mjs {{TASK_DIR}} --require-recipe-coverage-if-recipe
  ```
  If screenshots are present, inspect whether the claimed UI state is actually visible.
- [ ] **6. Judge the change** - check correctness, minimality, test coverage, recipe quality, evidence quality, and whether any introduced issue should block publishing.
- [ ] **7. Write `{{TASK_DIR}}/artifacts/review-feedback.md`**:
  ```markdown
  # Self-Review: {{TICKET}}

  ## Verdict: PASS

  ## Summary
  <brief summary of what changed and whether it is correct>

  ## Validation
  - <commands run and result>

  ## Evidence
  - <artifact/evidence assessment>

  ## Issues
  - <empty for PASS, or file:line findings for ISSUES>
  ```
  Use `## Verdict: ISSUES` when any blocking issue or cheap introduced nit remains.
- [ ] **8. Complete** - run:
  ```bash
  {{TASK_DIR}}/mark complete --mark-last
  ```
