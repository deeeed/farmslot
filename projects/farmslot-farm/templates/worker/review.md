# Worker: Review

> Operator-requested publication review for a completed Farmslot run.
> Execute the checklist directly. Do not use shortcut review commands.

> Checklist marker: run `{{TASK_DIR}}/mark --checklist {{REVIEW_CHECKLIST}} --signal {{REVIEW_SIGNAL}} start` once, then `{{TASK_DIR}}/mark --checklist {{REVIEW_CHECKLIST}} --signal {{REVIEW_SIGNAL}} N`
> after each checklist item. Finish with `{{TASK_DIR}}/mark --checklist {{REVIEW_CHECKLIST}} --signal {{REVIEW_SIGNAL}} complete --mark-last`.

Static review reads source, the diff, recorded evidence, existing CI results and deterministic receipts only. Tests and code validation belong to CI. Do not run tests, builds, recipes, installs, probes or ad hoc validation scripts. A claim without evidence is a finding or marked unverified.

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
```

## Checklist

- [ ] **1. Start** — run `{{TASK_DIR}}/mark --checklist {{REVIEW_CHECKLIST}} --signal {{REVIEW_SIGNAL}} start` and `{{TASK_DIR}}/mark --checklist {{REVIEW_CHECKLIST}} --signal {{REVIEW_SIGNAL}} 1`.
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
- [ ] **4. Inspect recorded validation** - read existing CI results and `artifacts/deterministic-checks/` receipts and logs. Do not execute validation. Missing evidence is a finding or marked unverified.
- [ ] **5. Audit recorded evidence** - read supplied artifact-contract results and inspect supplied screenshots for the claimed UI. Mark missing proof unverified; do not run artifact checkers or recipes.
- [ ] **6. Judge the change** - check correctness, minimality, test coverage, recipe quality, evidence quality, and whether any introduced issue should block publishing.
- [ ] **7. Write `{{TASK_DIR}}/{{REVIEW_FEEDBACK}}`**:
  ```markdown
  # Review: {{TICKET}}

  ## Verdict: PASS

  ## Summary
  <brief summary of what changed and whether it is correct>

  ## Validation
  - <recorded CI results, receipts and evidence limits>

  ## Evidence
  - <artifact/evidence assessment>

  ## Issues
  - <empty for PASS, or file:line findings for ISSUES>
  ```
  Use `## Verdict: ISSUES` when any blocking issue or cheap introduced nit remains.
- [ ] **8. Complete** - run:
  ```bash
  {{TASK_DIR}}/mark --checklist {{REVIEW_CHECKLIST}} --signal {{REVIEW_SIGNAL}} complete --mark-last
  ```

**Round 3 and later:** block only on blocker or major findings (a real defect in the delta, or an unmet AC). Minors and nits are listed as follow-ups and do not block; with no blocker or major, the verdict is APPROVE.
