# Worker: Self-Review Fix Pass

> Self-review found issues. Fix them, verify, update artifacts, commit and push.

> **Signal file:** `{{TASK_DIR}}/mark N` for progress; `SELF-REVIEW-FIX-SIGNAL.json` when done. TASK `STATUS` ≠ SIGNAL `status`.
> **Checklist marker:** Run `{{TASK_DIR}}/mark start` once when work begins. After each checklist item, run `{{TASK_DIR}}/mark N` (use the visible 1-based step number). If unsure, run `{{TASK_DIR}}/mark --help`. Terminal: `{{TASK_DIR}}/mark complete | {{TASK_DIR}}/mark no-change --reason "…" | {{TASK_DIR}}/mark blocked --reason "…"` (never hand-write `SIGNAL.json`).

**CRITICAL: Never pause or wait for user input. Complete ALL steps. After each step, run `{{TASK_DIR}}/mark N` (or mark `[x]` manually).**

---

## Task

```
TASK_DIR: {{TASK_DIR}}
REPO: {{REPO}}
TICKET: {{TICKET}}
STATUS: pending
```

## Issues Found by Self-Review

{{ISSUES}}

---

## Scope Discipline — READ FIRST

**Smallest diff that fixes the real cause.** No bandages, no refactors.

- Diagnose first: state the root cause to yourself in one sentence BEFORE editing. If you can't, re-read until you can.
- Fix the cause, not the symptom. Null-checks hiding the bug, try/catch swallowing errors, one-call special-cases = bandages, not fixes.
- Touch ONLY flagged files/lines. No drive-by cleanups, renames, reformatting, or new abstractions.
- Don't apply a change just to silence the reviewer. If the prescription is wrong, write the correct fix and note why in `report.md`.
- Each iteration shrinks the issue list, not the diff. Scope creep gets rejected.
- If the real fix needs broader changes, write `status: blocked` in `SELF-REVIEW-FIX-SIGNAL.json` with a one-line reason — don't ship a regression to close the loop.

---

### Recipe tooling

Resolve once, then reuse:

```bash
cd {{REPO}}
RUNNER_CMD="$({{recipe_runner_resolve_cmd}})"
HARNESS_CMD="$({{recipe_harness_resolve_cmd}})"
```

## Checklist

### Fix (steps 1-3)

- [ ] **1. Update Status** — `STATUS: working` in Task block, then `{{TASK_DIR}}/mark start`, then `{{TASK_DIR}}/mark 1`.
- [ ] **2. Read the review feedback** — `{{TASK_DIR}}/artifacts/review-feedback.md` has the full analysis. Understand each issue.
- [ ] **3. Fix each issue:**
      For each issue above:
  - Open the file, make the smallest possible fix
  - Diff discipline: only the lines required by the issue. Nothing more.

### Verify (steps 4-6)

- [ ] **4. Run affected tests:**
  ```bash
  yarn jest <test-files-you-changed> --no-coverage 2>&1 | tail -20
  ```
  All tests must pass. If a test fails, fix it before proceeding.
- [ ] **5. Auto-fix + bounded local CI gate:**

  ```bash
  cd {{REPO}}
  changed_js=$(git diff --name-only HEAD -- '*.ts' '*.tsx' '*.js' '*.jsx' \
    | grep -Ev '^(app/core/AgenticService/|temp/(recipe/harness|agentic/recipe-harness)/|\.skills-cache/)' || true)

  # Auto-fix (best-effort, NOT a gate) — scoped to changed files only:
  if [ -n "$changed_js" ]; then
    printf '%s\n' "$changed_js" | xargs yarn prettier --write 2>/dev/null || true
    printf '%s\n' "$changed_js" | xargs yarn eslint --fix 2>/dev/null || true
  fi

  # BOUNDED LOCAL CI GATE (strict - must pass before committing):
  # DO NOT run `yarn lint` in worker slots. In metamask-mobile it expands to
  # `eslint **/*.{js,ts,tsx} --cache` and can scan the whole repo/node_modules.
  if [ -n "$changed_js" ]; then
    printf '%s\n' "$changed_js" | xargs yarn eslint --max-warnings=0
  fi
  ```

  STOP if any command exits non-zero. Do **not** run `yarn lint:tsc`, raw
  `tsc`, `yarn lint`, `yarn lint:fix`, or repo-wide `yarn format:check` in
  self-review-fix loops unless the self-review issue is specifically a
  TypeScript/format gate failure or the operator explicitly asks. These broad
  gates make worker slots unusable and can surface unrelated stale issues.

- [ ] **6. Re-run recipe regression gate** (if `{{TASK_DIR}}/artifacts/recipe.json` exists):
  ```bash
  "$RUNNER_CMD" run {{TASK_DIR}}/artifacts/recipe.json --adapter mobile --artifacts-dir {{TASK_DIR}}/artifacts/recipe-run --project-root {{REPO}} --slot {{SLOT_ID}} --json 2>&1 | tail -20
  ```
  Recipe must still pass after every code-changing self-review fix. If it fails, investigate — your fix may have broken something.
  Then run the deterministic artifact contract gate; fix any failure before signaling completion:
  ```bash
  node {{farmslot_dir}}/scripts/quality/check-task-artifact-contract.mjs {{TASK_DIR}} --require-recipe-quality-if-recipe --require-recipe-coverage-if-recipe
  ```

### Update artifacts (steps 7-9)

- [ ] **7. Append to report.md** — add a "Self-Review Fixes" section to `{{TASK_DIR}}/artifacts/report.md`:

  ```markdown
  ## Self-Review Fixes

  - <file:line> — <what you fixed>
  - <file:line> — <what you fixed>
  ```

- [ ] **8. Keep PR description local-only** if the fixes changed behavior or test coverage:
  ```bash
  # Only if substantive changes (new test assertions, logic changes). Skip for trivial cleanups.
  Do not run `gh pr view`, `gh pr edit`, `gh pr comment`, or any other PR mutation command. If fixes are substantive, update the local PR description artifact only; the gateway publishes it after human approval.
  ```
- [ ] **9. Commit locally only:**
  ```bash
  # Only stage files YOU intentionally changed. Do NOT use `git add -A` — auto-fixers may have modified unrelated files.
  git add <file1> <file2> ...
  git commit -m "fix: address self-review feedback ({{TICKET}})"
  # Stop here: do not run `git push`. The gateway publishes after human approval.
  ```

### Signal (step 10)

- [ ] **10. Finalize** — checkbox first, then signal, in this order so the orchestrator never sees a complete signal next to an unchecked final step:
  1. Edit this file to set the checkbox above to `[x]`.
  2. Write the signal: `{{TASK_DIR}}/mark complete --mark-last`
