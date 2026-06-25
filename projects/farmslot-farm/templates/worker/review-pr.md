# Worker: Review-PR — PR #{{PR_NUMBER}}

> **Signal file:** Write `{{TASK_DIR}}/SIGNAL.json` with status updates.
> **Checklist marker:** After each checklist item, run `{{TASK_DIR}}/mark N` (1-based). The final item can add `--status complete --outcome success`.

---

**CRITICAL: Never pause or wait for user input. Complete ALL steps in a single uninterrupted run.**

## Task

```text
PR: {{PR_NUMBER}}
TITLE: {{PR_TITLE}}
BRANCH: {{BRANCH}}
TASK_DIR: {{TASK_DIR}}
STATUS: pending
```

## Checklist

- [ ] **1. Read project docs** — read `CLAUDE.md` (root) and `apps/command-center/CLAUDE.md` to understand conventions.
- [ ] **2. Update status** — set `STATUS: working` in this file.
- [ ] **3. Checkout PR branch** — `git checkout {{BRANCH}}` and merge main.
- [ ] **4. Read the PR description** — understand intent, scope, and linked issues.
- [ ] **5. Read changed files in full** — do NOT rely on diffs alone. Read each modified file completely to understand surrounding context.
- [ ] **6. Run validation** — confirm the PR compiles and tests pass:
  ```bash
  cd apps/command-center && yarn typecheck
  cd apps/command-center && yarn exec tsx ../../services/gateway/src/*.test.ts
  ```
- [ ] **7. Review for bugs and regressions** — focus on logic errors, missing edge cases, broken call sites, type mismatches.
- [ ] **8. Review for code quality** — check for inline type duplication, unnecessary abstractions, dead code, unclear naming.
- [ ] **9. Write review** — create `{{TASK_DIR}}/artifacts/review.md` with findings organized by severity (blocking, suggestion, nit).
- [ ] **10. Post review comments** — post inline comments on specific lines via GitHub API.
- [ ] **11. Update status** — set `STATUS: done`.
- [ ] **12. Write completion signal** — run: `{{TASK_DIR}}/mark 12 --status complete --outcome success`
