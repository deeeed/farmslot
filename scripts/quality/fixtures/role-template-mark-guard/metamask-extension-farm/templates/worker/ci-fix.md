# Worker: CI Fix Pass

> CI-watch detected issues on your PR. Fix them, verify, commit and push.
> **Signal file:** `{{TASK_DIR}}/mark N` for progress; `CI-FIX-SIGNAL.json` when done. TASK `STATUS` ≠ SIGNAL `status`.
> **Checklist marker:** Run `{{TASK_DIR}}/mark start` once when work begins. After each checklist item, run `{{TASK_DIR}}/mark N` (use the visible 1-based step number). If unsure, run `{{TASK_DIR}}/mark --help`. Terminal: `{{TASK_DIR}}/mark complete | {{TASK_DIR}}/mark no-change --reason "…" | {{TASK_DIR}}/mark blocked --reason "…"` (never hand-write `SIGNAL.json`).

**CRITICAL: Never pause or wait for user input. Complete ALL steps. After each step, run `{{TASK_DIR}}/mark N` (or mark `[x]` manually).**

---

## Task

```
TASK_DIR: {{TASK_DIR}}
PR: #{{PR_NUMBER}}
REPO: {{GH_REPO}}
BRANCH: {{BRANCH}}
ISSUE_TYPE: {{CI_ISSUE_TYPE}}
STATUS: pending
```

## Issues Detected

{{CI_ISSUES}}

---

### Recipe tooling

Resolve once, then reuse:

```bash
cd {{REPO}}
RUNNER_CMD="$({{recipe_runner_resolve_cmd}})"
HARNESS_CMD="$({{recipe_harness_resolve_cmd}})"
```

## Checklist

### Triage (steps 1-2)

- [ ] **1. Update Status** — `STATUS: working` in Task block, then `{{TASK_DIR}}/mark start`, then `{{TASK_DIR}}/mark 1`.
- [ ] **2. Fetch full context:**
  - If review comments: `unset GH_TOKEN && gh api "repos/{{GH_REPO}}/pulls/{{PR_NUMBER}}/comments" --jq '.[] | select(.in_reply_to_id == null) | {id: .id, author: .user.login, body: .body, path: .path, line: .line}'`
  - If CI failures: `unset GH_TOKEN && gh pr checks {{PR_NUMBER}} --repo {{GH_REPO}} 2>&1 | grep -iE 'fail|error'`

### Fix (steps 3-4)

- [ ] **3. Triage each issue** — classify as REAL (needs fix) or FALSE POSITIVE (dismiss/ignore).
- [ ] **4. Apply minimal fixes** — fix exactly what was flagged, nothing more.

### Verify (steps 5-6)

- [ ] **5. Auto-fix + CI parity gate:**

  ```bash
  cd {{REPO}}
  # Auto-fix (best-effort, NOT a gate) — scoped to changed files only:
  yarn lint:changed:fix || true

  # CI PARITY CHECK (strict — must all pass before pushing):
  # Mirrors `yarn lint` MINUS lint:images. `lint:images` scans the WHOLE repo and
  # master has known unoptimized PNGs unrelated to this PR — running it locally
  # blocks every PR on upstream pollution. If your fix actually touched any image,
  # run `yarn lint:images:fix` on those paths and re-stage; otherwise upstream CI
  # catches real image regressions on the PR.
  # DO NOT substitute `lint:fix` or `lint:changed:fix` — those are auto-fixers that exit 0, not validators.
  yarn lint:json && yarn lint:format && yarn lint:eslint && yarn lint:tsc && yarn lint:styles && yarn messenger-action-types:check && yarn verify-locales --quiet && yarn circular-deps:check
  ```

  STOP if any command exits non-zero. Fix the errors before proceeding.

- [ ] **6. Run affected tests** (if any test files changed):
  ```bash
  yarn jest <changed-test-files> --no-coverage 2>&1 | tail -20
  ```
- [ ] **6b. Re-run recipe regression gate** (if `{{TASK_DIR}}/artifacts/recipe.json` exists):
  ```bash
  cd {{REPO}}
  "$RUNNER_CMD" run {{TASK_DIR}}/artifacts/recipe.json --adapter extension --artifacts-dir {{TASK_DIR}}/artifacts/recipe-run --project-root {{REPO}} --json --cdp-port {{CDP_PORT}} --launch-existing-dist 2>&1 | tail -20
  ```
  Recipe must pass before pushing any CI-watch fix.

### Commit & Reply (steps 7-8)

- [ ] **7. Commit and push:**

  ```bash
  cd {{REPO}}
  # Final pre-commit parity gate — rerun after all last-mile edits.
  yarn lint:changed:fix || true
  yarn lint:json && yarn lint:format && yarn lint:eslint && yarn lint:tsc && yarn lint:styles && yarn messenger-action-types:check && yarn verify-locales --quiet && yarn circular-deps:check

  # Only stage files YOU intentionally changed for the fix.
  # Do NOT use `git add -A` — lint:fix/prettier may have modified unrelated files.
  # Review `git diff --name-only` and add only the files relevant to your fixes.
  git add <file1> <file2> ...
  git commit -m "fix: address CI feedback" && git push
  ```

  STOP if the final parity gate fails.

- [ ] **8. Reply to each bot comment thread** (skip if CI-failures-only):
  ```bash
  unset GH_TOKEN && gh api "repos/{{GH_REPO}}/pulls/{{PR_NUMBER}}/comments/{COMMENT_ID}/replies" -X POST -f body="Fixed in $(git rev-parse --short HEAD)"
  ```

### Signal (step 9)

- [ ] **9. Write CI-FIX-SIGNAL.json:**
  ```bash
  {{TASK_DIR}}/mark complete --mark-last
  ```
  **Do NOT `/exit`. Stay alive — CI-watch may nudge you again if new issues appear.**
