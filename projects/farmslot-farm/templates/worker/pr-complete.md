# Worker: PR-Complete

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
TASK_DIR: {{TASK_DIR}}
STATUS: pending
```

## Checklist

- [ ] **1. Read project docs** — read `CLAUDE.md` (root) and `apps/command-center/CLAUDE.md` to understand repo structure, conventions, and validation rules.
- [ ] **2. Update status** — set `STATUS: working` in this file, then run `{{TASK_DIR}}/mark start`, then `{{TASK_DIR}}/mark 2`.
- [ ] **3. Confirm PR context** — verify `PR_NUMBER`, `PR_BRANCH`, and current task scope before editing.
- [ ] **4. Checkout PR branch** — `git checkout {{PR_BRANCH}}`
- [ ] **5. Read inherited context** — review `{{TASK_DIR}}/inputs/inherited/` and any materialized family artifacts before making changes.
- [ ] **6. Fix the reported PR follow-up issue** — keep changes minimal and scoped to the current follow-up.
- [ ] **7. Validate** — run typecheck and focused tests:
  ```bash
  cd apps/command-center && yarn typecheck
  cd apps/command-center && yarn exec tsx ../../services/gateway/src/*.test.ts
  ```
- [ ] **8. Commit and push — REQUIRED before marking complete:**
  ```bash
  git status --porcelain   # must be empty after committing
  git add -A && git commit -m "fix: address PR follow-up" && git push origin {{PR_BRANCH}}
  git rev-list origin/{{PR_BRANCH}}..HEAD | wc -l   # must print 0
  ```
  The gateway verifies the branch is pushed before accepting your completion signal; an unpushed `mark complete` blocks the run.
- [ ] **9. Behind-main + merge-tree conflict probe** — before signaling re-review /
  completion ready (after must-fix commits):
  ```bash
  git fetch origin main
  behindMain=$(git rev-list --count HEAD..origin/main)
  echo "behindMain=$behindMain"
  base=$(git merge-base HEAD origin/main)
  probe=$(git merge-tree "$base" HEAD origin/main)
  if printf '%s\n' "$probe" | grep -E '^(<<<<<<<|=======|>>>>>>>|CONFLICT )' >/dev/null; then
    mergeConflicts=true
  else
    mergeConflicts=false
  fi
  echo "mergeConflicts=$mergeConflicts"
  ```
  **Failure path:** if `mergeConflicts=true` or `behindMain` is material, update
  the branch first — **prefer** `git merge origin/main` during open review loops;
  use `git rebase origin/main` + `git push --force-with-lease` only when the
  project already standardizes on rebase. Never auto force-push mid-loop.
  Record `behindMain`, `mergeConflicts`, and the next command used in the report.
- [ ] **10. Write report** — create `{{TASK_DIR}}/artifacts/comments-report.md` with: files changed, issue addressed, validation results, behindMain/mergeConflicts.
- [ ] **11. Write `{{TASK_DIR}}/artifacts/learnings.md`** — required packaged evidence. Use 3–5 bullets on key learnings or struggles during the session; if nothing relevant: `- No reviewer-driven learnings — no actionable comment fixes on this run.`
- [ ] **12. Update status and signal** — set `STATUS: done`, then run: `{{TASK_DIR}}/mark complete --mark-last` (validates learnings, report, checklist, artifact contract)
