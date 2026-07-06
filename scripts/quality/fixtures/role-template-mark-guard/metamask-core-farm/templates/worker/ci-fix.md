# Worker: CI Fix Pass (Core Monorepo)

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

Resolve once, then reuse when a recipe regression gate applies:

```bash
cd {{REPO}}
RUNNER_CMD="$({{recipe_runner_resolve_cmd}})" || true
RECIPES_DIR="$(dirname "$RUNNER_CMD")/../recipes"
```

## Checklist

### Triage (steps 1-2)

- [ ] **1. Update Status** — `STATUS: working` in Task block, then `{{TASK_DIR}}/mark start`, then `{{TASK_DIR}}/mark 1`.
- [ ] **2. Fetch full context:**
  - If review comments: `unset GH_TOKEN && gh api "repos/{{GH_REPO}}/pulls/{{PR_NUMBER}}/comments" --jq '.[] | select(.in_reply_to_id == null) | {id: .id, author: .user.login, body: .body, path: .path, line: .line}'`
  - If CI failures: `unset GH_TOKEN && gh pr checks {{PR_NUMBER}} --repo {{GH_REPO}} 2>&1 | grep -iE 'fail|error'`
  - For failed GitHub Actions jobs, open the linked run log and capture the first actionable error (file:line or command).

### Fix (steps 3-4)

- [ ] **3. Triage each issue** — classify as REAL (needs fix) or FALSE POSITIVE (dismiss/ignore).
- [ ] **4. Apply minimal fixes** — fix exactly what was flagged, nothing more. Prefer package-local changes under the touched Core package(s).

### Verify (steps 5-6)

- [ ] **5. Auto-fix + Core CI parity gate:**

  ```bash
  cd {{REPO}}
  # Auto-fix (best-effort, NOT a gate):
  yarn lint:fix || true

  # CI PARITY CHECK (strict — must all pass before pushing):
  # Mirrors `yarn lint` on MetaMask/core. Do NOT substitute `lint:fix` — it exits 0 even when follow-up checks fail.
  yarn lint:eslint && yarn lint:misc:check && yarn constraints && yarn lint:dependencies && yarn lint:teams && yarn messenger-action-types:check && yarn readme-content:check
  ```

  STOP if any command exits non-zero. Fix the errors before proceeding.

- [ ] **6. Run affected tests** for the touched package(s):
  ```bash
  cd {{REPO}}
  changed_tests=$(git diff --name-only origin/{{DEFAULT_BRANCH}}...HEAD -- '*.test.ts' '*.test.tsx' '*.spec.ts' '*.spec.tsx')
  if [ -n "$changed_tests" ]; then
    NODE_OPTIONS=--experimental-vm-modules yarn jest $changed_tests --no-coverage 2>&1 | tail -30
  else
    # When CI failed on lint only, run the smallest Jest target covering changed src files.
    changed_src=$(git diff --name-only origin/{{DEFAULT_BRANCH}}...HEAD -- 'packages/*/src/**')
    if [ -n "$changed_src" ]; then
      pkg=$(echo "$changed_src" | head -1 | cut -d/ -f2)
      NODE_OPTIONS=--experimental-vm-modules yarn jest "packages/$pkg" --no-coverage --passWithNoTests 2>&1 | tail -30
    fi
  fi
  ```
- [ ] **6b. Re-run recipe regression gate** (if `{{TASK_DIR}}/artifacts/recipe.json` exists):
  ```bash
  cd {{REPO}}
  if [ -f {{TASK_DIR}}/artifacts/recipe.json ] && [ -n "$RUNNER_CMD" ]; then
    "$RUNNER_CMD" run {{TASK_DIR}}/artifacts/recipe.json --adapter core \
      --project-root {{REPO}} --artifacts-dir {{TASK_DIR}}/artifacts/recipe-run --json 2>&1 | tail -20
  fi
  ```
  Recipe must pass before pushing any CI-watch fix.

### Commit & Reply (steps 7-8)

- [ ] **7. Commit and push:**

  ```bash
  cd {{REPO}}
  # Final pre-push parity gate — rerun after last-mile edits.
  yarn lint:eslint && yarn lint:misc:check && yarn constraints && yarn lint:dependencies && yarn lint:teams && yarn messenger-action-types:check && yarn readme-content:check

  # Only stage files YOU intentionally changed for the fix.
  # Do NOT use `git add -A` — lint:fix may have modified unrelated files.
  git add <file1> <file2> ...
  git commit -m "fix: address CI feedback" && git push origin {{BRANCH}}
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
