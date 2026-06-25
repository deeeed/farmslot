# Worker: Merge-Main

> **Signal file:** Write `{{TASK_DIR}}/SIGNAL.json` with status updates.
> **Checklist marker:** After each checklist item, run `{{TASK_DIR}}/mark N` (1-based). The final item can add `--status complete --outcome success`.

---

**CRITICAL: Never pause or wait for user input. Complete ALL steps in a single uninterrupted run.**

## Task

```text
PR: {{PR_NUMBER}}
TITLE: {{PR_TITLE}}
BRANCH: {{PR_BRANCH}}
PR_BRANCH: {{PR_BRANCH}}
TASK_DIR: {{TASK_DIR}}
STATUS: pending
```

## Checklist

- [ ] **1. Read project docs** — read `CLAUDE.md` (root) and `apps/command-center/CLAUDE.md` to understand repo structure, conventions, and validation rules.
- [ ] **2. Update status** — set `STATUS: working` in this file.
- [ ] **3. Confirm merge target** — verify `PR_NUMBER` and `PR_BRANCH`; this task is specifically for main-branch merge fallout.
- [ ] **4. Checkout PR branch** — `git checkout {{PR_BRANCH}}`
- [ ] **5. Merge main** — update from default branch and resolve conflicts on `{{PR_BRANCH}}`.
- [ ] **6. Validate** — run typecheck and focused tests:
  ```bash
  cd apps/command-center && yarn typecheck
  cd apps/command-center && yarn exec tsx ../../services/gateway/src/*.test.ts
  ```
- [ ] **7. Write report** — create `{{TASK_DIR}}/artifacts/report.md` with: conflicts resolved, files changed, validation results.
- [ ] **8. Update status and signal** — set `STATUS: done`, then run: `{{TASK_DIR}}/mark 8 --status complete --outcome success`
