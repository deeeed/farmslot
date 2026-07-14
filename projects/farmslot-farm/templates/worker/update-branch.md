# Worker: Update-Branch

> **Signal file:** `./mark N` for progress; `SIGNAL.json` only when done. TASK `STATUS` ≠ SIGNAL `status`.
> **Checklist marker:** Run `{{TASK_DIR}}/mark start` once when work begins (before the first `./mark N`). After each checklist item, run `{{TASK_DIR}}/mark N` (use the visible 1-based step number). If unsure, run `{{TASK_DIR}}/mark --help`. Terminal: `{{TASK_DIR}}/mark complete | {{TASK_DIR}}/mark no-change --reason "…" | {{TASK_DIR}}/mark blocked --reason "…"` (never hand-write `SIGNAL.json`).

---

**CRITICAL: Never pause or wait for user input. Complete ALL steps in a single uninterrupted run.**

## Task

```text
PR: {{PR_NUMBER}}
TITLE: {{PR_TITLE}}
BRANCH: {{PR_BRANCH}}
PR_BRANCH: {{PR_BRANCH}}
BRANCH_UPDATE_STRATEGY: {{BRANCH_UPDATE_STRATEGY}}
TASK_DIR: {{TASK_DIR}}
STATUS: pending
```

This is an **update-branch** run: bring this PR branch up to date against its base
branch and continue CI/finalization. The intent is not "make a merge commit from
main" — it is "update this branch, resolve any fallout, keep CI green."

## Strategy

`BRANCH_UPDATE_STRATEGY` selects how to update the branch:

- `rebase` — rebase the PR branch onto the base branch. Preferred for agent-owned
  PR branches. Push with `git push --force-with-lease` (never a bare `--force`).
- `merge` — merge the base branch into the PR branch (merge commit). Use when the
  project disallows force-push, the branch is shared/protected, or a merge commit
  is explicitly safer for the conflict.
- `project-default` — defer to the project's configured `merge_main_strategy`.

If the resolved strategy is `project-default`, read the project policy and record
the concrete strategy you actually used in the outcome artifact.

## Checklist

- [ ] **1. Read project docs** — read `CLAUDE.md` (root) and `apps/command-center/CLAUDE.md` to understand repo structure, conventions, and validation rules.
- [ ] **2. Update status** — set `STATUS: working` in this file, then run `{{TASK_DIR}}/mark start`, then `{{TASK_DIR}}/mark 2`.
- [ ] **3. Confirm target + strategy** — verify `PR_NUMBER` and `PR_BRANCH`; resolve `BRANCH_UPDATE_STRATEGY` (rebase | merge | project-default) to the concrete strategy you will use.
- [ ] **4. Checkout PR branch** — `git checkout {{PR_BRANCH}}`
- [ ] **5. Update branch** — update from the base branch using the selected strategy and resolve any conflicts on `{{PR_BRANCH}}`.
- [ ] **6. Validate** — run typecheck and focused tests:
  ```bash
  cd apps/command-center && yarn typecheck
  cd apps/command-center && yarn exec tsx ../../services/gateway/src/*.test.ts
  ```
- [ ] **7. Push** — publish the updated branch. For `rebase`, use `git push --force-with-lease`; for `merge`, a normal `git push`. Record the exact push command used.
- [ ] **8. Write report** — create `{{TASK_DIR}}/artifacts/report.md` recording: **selected strategy** (rebase | merge), **validation notes** (typecheck + test results), **conflict resolution summary**, **push command used**, and **risk notes** (force-push impact, follow-up needed).
- [ ] **9. Write `{{TASK_DIR}}/artifacts/learnings.md`** — required packaged evidence. Use 3–5 bullets on key learnings or struggles during the session; if nothing relevant: `- Nothing relevant — straightforward run; no blockers or surprises.`
- [ ] **10. Update status and signal** — set `STATUS: done`, then run: `{{TASK_DIR}}/mark complete --mark-last`
