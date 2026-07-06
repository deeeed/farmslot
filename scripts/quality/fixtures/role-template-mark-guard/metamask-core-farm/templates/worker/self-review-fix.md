# Worker: Self-Review Fix Pass (Core Monorepo)

> **Signal file:** `{{TASK_DIR}}/mark N` for progress; `SELF-REVIEW-FIX-SIGNAL.json` when done. TASK `STATUS` ≠ SIGNAL `status`. The orchestrator watches this for completion detection.
> **Checklist marker:** Run `{{TASK_DIR}}/mark start` once when work begins. After each checklist item, run `{{TASK_DIR}}/mark N` (use the visible 1-based step number). If unsure, run `{{TASK_DIR}}/mark --help`. Terminal: `{{TASK_DIR}}/mark complete | {{TASK_DIR}}/mark no-change --reason "…" | {{TASK_DIR}}/mark blocked --reason "…"` (never hand-write `SIGNAL.json`).

**CRITICAL: Never pause or wait for user input. Complete ALL steps.**

## Task

```text
TASK_DIR: {{TASK_DIR}}
REPO: {{REPO}}
TICKET: {{TICKET}}
STATUS: pending
```

## Issues Found by Self-Review

{{ISSUES}}

## Checklist

- [ ] **1. Update status** — `STATUS: working` in Task block, then `{{TASK_DIR}}/mark start`, then `{{TASK_DIR}}/mark 1`.
- [ ] **2. Read full feedback** — `cat {{TASK_DIR}}/artifacts/review-feedback.md`.
- [ ] **3. Fix only the reported issues** — smallest diff, no drive-by cleanup.
- [ ] **4. Re-run Core validation** with the smallest relevant Jest target. Run package build only if the fix touches exported types/package exports/build wiring.
- [ ] **5. Append to report** — add `## Self-Review Fixes` to `{{TASK_DIR}}/artifacts/report.md`.
- [ ] **6. Commit locally only if code changed**:
  ```bash
  cd {{REPO}}
  git status --short
  # Only stage files YOU intentionally changed. Do NOT use `git add -A`; auto-fixers may have modified unrelated files.
  git add <intentional-files>
  git commit -m "fix: address self-review feedback ({{TICKET}})"
  ```
  Stop here: do not run `git push`. The gateway publishes after human approval.
- [ ] **7. Signal completion**:
  ```bash
  {{TASK_DIR}}/mark complete --mark-last
  ```

## Rules

- If an issue is wrong, document why in `report.md`; do not make a fake fix.
- If the correct fix requires a product decision, write a blocked signal instead of shipping a risky workaround.
- Do not run `gh pr view`, `gh pr edit`, `gh pr comment`, or any other PR mutation command.
- Never mention Claude/AI/LLM in commits, PR text, or GitHub comments.
- After writing `SELF-REVIEW-FIX-SIGNAL.json`, **STOP**.
