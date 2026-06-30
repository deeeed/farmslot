# Worker: CI Fix Pass

> CI-watch detected issues on your PR. Fix them, verify, commit and push.
> **Signal file:** `./mark N` for progress; `CI-FIX-SIGNAL.json` when done. TASK `STATUS` ≠ SIGNAL `status`.
> **Checklist marker:** Run `{{TASK_DIR}}/mark start` once when work begins (before the first `./mark N`). After each checklist item, run `{{TASK_DIR}}/mark N` (use the visible 1-based step number). If unsure, run `{{TASK_DIR}}/mark --help`. Terminal: `{{TASK_DIR}}/mark complete | {{TASK_DIR}}/mark no-change --reason "…" | {{TASK_DIR}}/mark blocked --reason "…"` (never hand-write `SIGNAL.json`).

**CRITICAL: Never pause or wait for user input. Complete ALL steps. After each step, run `{{TASK_DIR}}/mark N` (or mark `[x]` manually).**

This is the **Farmslot default** `ci-fix.md` template. Projects should override it under `projects/<name>/templates/worker/ci-fix.md` with repo-specific validation commands. The gateway uses this file only when the project does not supply its own.

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
  # Auto-fix (best-effort, NOT a gate):
  yarn lint:fix || npm run lint:fix --if-present || true

  # CI PARITY CHECK (strict — must all pass before pushing):
  # Replace with your repo's canonical lint/typecheck command if different.
  yarn lint 2>&1 | tail -30 || npm run lint --if-present 2>&1 | tail -30
  yarn lint:tsc 2>&1 | tail -30 || npm run typecheck --if-present 2>&1 | tail -30
  ```

  STOP if any command exits non-zero. Fix the errors before proceeding.

- [ ] **6. Run affected tests** (if any test files changed):
  ```bash
  yarn test --passWithNoTests 2>&1 | tail -20 || npm test --if-present 2>&1 | tail -20
  ```

### Commit & Reply (steps 7-8)

- [ ] **7. Commit and push:**
  ```bash
  cd {{REPO}}
  # Only stage files YOU intentionally changed for the fix.
  # Do NOT use `git add -A` — auto-fixers may have modified unrelated files.
  git add <file1> <file2> ...
  git commit -m "fix: address CI feedback" && git push origin {{BRANCH}}
  ```
- [ ] **8. Reply to each bot comment thread** (skip if CI-failures-only):
  ```bash
  unset GH_TOKEN && gh api "repos/{{GH_REPO}}/pulls/{{PR_NUMBER}}/comments/{COMMENT_ID}/replies" -X POST -f body="Fixed in $(git rev-parse --short HEAD)"
  ```

### Signal (step 9)

- [ ] **9. Write CI-FIX-SIGNAL.json:**
  ```bash
  node {{farmslot_dir}}/packages/skills/scripts/mark-checklist-step.cjs {{TASK_DIR}}/CI-FIX.md {{TASK_DIR}}/CI-FIX-SIGNAL.json complete --outcome success --mark-last
  ```
  **Do NOT `/exit`. Stay alive — CI-watch may nudge you again if new issues appear.**
