# Worker: Self-Review (Core Monorepo)

> **Signal file:** `{{TASK_DIR}}/mark N` for progress; `SELF-REVIEW-SIGNAL.json` when done. TASK `STATUS` ≠ SIGNAL `status`. The orchestrator watches this for completion detection.
> **Checklist marker:** Run `{{TASK_DIR}}/mark start` once when work begins. After each checklist item, run `{{TASK_DIR}}/mark N` (use the visible 1-based step number). If unsure, run `{{TASK_DIR}}/mark --help`. Terminal: `{{TASK_DIR}}/mark complete | {{TASK_DIR}}/mark no-change --reason "…" | {{TASK_DIR}}/mark blocked --reason "…"` (never hand-write `SIGNAL.json`).

**CRITICAL: Never pause or wait for user input. Do not use `/review`; execute this checklist directly.**

## Task

```text
TASK_DIR: {{TASK_DIR}}
REPO: {{REPO}}
TICKET: {{TICKET}}
SESSION: {{SESSION}}
STATUS: pending
```

## Checklist

- [ ] **1. Update status** — `STATUS: working` in Task block, then `{{TASK_DIR}}/mark start`, then `{{TASK_DIR}}/mark 1`.
- [ ] **2. Read worker report**:
  ```bash
  if [ -f {{TASK_DIR}}/artifacts/report.md ]; then cat {{TASK_DIR}}/artifacts/report.md; else echo "No report.md artifact"; fi
  if [ -f {{TASK_DIR}}/artifacts/comments-report.md ]; then cat {{TASK_DIR}}/artifacts/comments-report.md; else echo "No comments-report.md artifact"; fi
  ```
- [ ] **3. Inspect diff**:
  ```bash
  cd {{REPO}}
  git diff origin/main...HEAD --stat
  git diff origin/main...HEAD
  ```
- [ ] **4. Review Core correctness** — check logic, tests, package exports, no swallowed exceptions, no unrelated refactors.
- [ ] **5. Review downstream compatibility** — if `packages/perps-controller` changed, check for Mobile/Extension breaking risk in exports, types, state/actions, constants, utils, error codes, and behavior.
- [ ] **6. Run bounded validation** with the smallest relevant Jest target. Run package build only if exported types/package exports/build wiring changed.
- [ ] **7. Write `{{TASK_DIR}}/artifacts/review-feedback.md`** with:
  - `## Verdict: PASS` or `## Verdict: ISSUES`;
  - summary;
  - findings with `file:line`;
  - downstream compatibility assessment;
  - validation results.
- [ ] **8. Signal completion**:
  ```bash
  {{TASK_DIR}}/mark complete --mark-last
  ```

## Rules

- Do not mutate source files, commits, branches, or GitHub.
- Never mention Claude/AI/LLM in review artifacts.
- After writing `SELF-REVIEW-SIGNAL.json`, **STOP**.
