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

- [ ] **5. Auto-fix + bounded local CI gate:**

  ```bash
  cd {{REPO}}
  # Auto-fix (best-effort, NOT a gate) — scoped to changed files only:
  git diff --name-only HEAD | grep -E '\.(ts|tsx|js|jsx)$' | xargs yarn prettier --write 2>/dev/null || true
  git diff --name-only HEAD | grep -E '\.(ts|tsx|js|jsx)$' | xargs yarn eslint --fix 2>/dev/null || true

  # BOUNDED LOCAL CI GATE (strict - must pass before pushing):
  # DO NOT run `yarn lint` in worker slots. In metamask-mobile it expands to
  # `eslint **/*.{js,ts,tsx} --cache` and can scan the whole repo/node_modules.
  changed_js=$(git diff --name-only HEAD -- '*.ts' '*.tsx' '*.js' '*.jsx')
  if [ -n "$changed_js" ]; then
    printf '%s\n' "$changed_js" | xargs yarn eslint --max-warnings=0
  fi
  NODE_OPTIONS='--max-old-space-size=8192' yarn lint:tsc
  yarn format:check
  ```

  STOP if any command exits non-zero. If `format:check` fails, re-run prettier on YOUR changed files only (`git diff --name-only HEAD | grep -E '\.(ts|tsx|js|jsx|json)$' | xargs yarn prettier --write`) and re-check.

  Then verify working tree is clean (mobile CI runs `git diff --exit-code`):

  ```bash
  git status --porcelain
  ```

  If output is non-empty, stage the auto-fix changes (minus TASK.md / artifacts) before proceeding.

- [ ] **6. Run affected tests** (if any test files changed):
  ```bash
  yarn jest <changed-test-files> --no-coverage 2>&1 | tail -20
  ```
- [ ] **6b. Re-run recipe regression gate** (if `{{TASK_DIR}}/artifacts/recipe.json` exists):
  ```bash
  "$RUNNER_CMD" run {{TASK_DIR}}/artifacts/recipe.json --adapter mobile --artifacts-dir {{TASK_DIR}}/artifacts/recipe-run --project-root {{REPO}} --slot {{SLOT_ID}} --json 2>&1 | tail -20
  ```
  Recipe must pass before pushing any CI-watch fix.

### Commit & Reply (steps 7-8)

- [ ] **7. Commit and push:**
  ```bash
  # Only stage files YOU intentionally changed for the fix.
  # Do NOT use `git add -A` — lint:fix/format may have modified unrelated files.
  # Review `git diff --name-only` and add only the files relevant to your fixes.
  git add <file1> <file2> ...
  git commit -m "fix: address CI feedback" && git push
  ```
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
