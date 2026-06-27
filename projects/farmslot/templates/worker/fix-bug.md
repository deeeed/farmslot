# Worker: Fix-Bug — {{TICKET_ID}}

> **Signal file:** `./mark N` for progress; `SIGNAL.json` only when done. TASK `STATUS` ≠ SIGNAL `status`.
> **Checklist marker:** Run `{{TASK_DIR}}/mark start` once when work begins (before the first `./mark N`). After each checklist item, run `{{TASK_DIR}}/mark N` (use the visible 1-based step number). If unsure, run `{{TASK_DIR}}/mark --help`. Terminal: `{{TASK_DIR}}/mark complete --outcome success` (never `echo > SIGNAL.json`).

---

**CRITICAL: Never pause or wait for user input. Complete ALL steps in a single uninterrupted run.**

## Task

```text
TICKET: {{TICKET_ID}}
TITLE: {{TICKET_TITLE}}
BRANCH: {{BRANCH}}
TASK_DIR: {{TASK_DIR}}
STATUS: pending
```

## Checklist

### Early no-change exit (before code/PR mutations)

After `STATUS: working`, first decide if a code fix is still needed. If the bug is already fixed or cannot be reproduced in a valid target environment, do not create a fake commit/PR. Write `{{TASK_DIR}}/artifacts/no-change-report.md` with proof/repro steps, observed result, and evidence paths, then write one terminal `SIGNAL.json` and stop.

- Already fixed / not reproducible: `status=complete`, `outcome=success`, `disposition=already_fixed|not_reproducible`, plus evidence `{ reportPath, artifacts, confidence, noCodeChange: true, reproductionAttempted: true }`.
- Blocked: use `status=blocked`, `outcome=partial`, `disposition=blocked` for branch/env/auth/device/CDP/precondition problems. Never call setup failure `not_reproducible`.

Signal shape:

```json
{
  "status": "complete",
  "outcome": "success",
  "disposition": "already_fixed",
  "reason": "<one sentence>",
  "evidence": {
    "reportPath": "{{TASK_DIR}}/artifacts/no-change-report.md",
    "artifacts": ["{{TASK_DIR}}/artifacts/<proof>"],
    "confidence": "high",
    "noCodeChange": true,
    "reproductionAttempted": true
  },
  "timestamp": "<UTC ISO8601>"
}
```

- [ ] **1. Read project docs** — read `CLAUDE.md` (root) and `apps/command-center/CLAUDE.md` to understand repo structure, conventions, and validation rules.
- [ ] **2. Update status** — set `STATUS: working` in this file, then run `{{TASK_DIR}}/mark start`, then `{{TASK_DIR}}/mark 2`.
- [ ] **3. Read the bug description** — understand the reported issue, affected area, and expected behavior.
- [ ] **4. Reproduce via typecheck/tests** — run validation to confirm the bug:
  ```bash
  cd apps/command-center && yarn typecheck
  cd apps/command-center && yarn exec tsx ../../services/gateway/src/*.test.ts
  ```
- [ ] **5. Locate the root cause** — identify the exact file(s) and line(s) causing the issue.
- [ ] **6. Create branch** — `git checkout -b {{BRANCH}}`
- [ ] **7. Implement the fix** — make the minimal change needed. No refactoring, no cleanup beyond the fix.
- [ ] **8. Validate the fix** — re-run typecheck and tests:
  ```bash
  cd apps/command-center && yarn typecheck
  cd apps/command-center && yarn exec tsx ../../services/gateway/src/*.test.ts
  ```
- [ ] **9. Self-review** — read the diff (`git diff`). Check for: inline type duplication (use `@farmslot/protocol`), unnecessary helpers, comments that restate code.
- [ ] **10. Commit** — single commit following the repo's Lore commit protocol.
- [ ] **11. Prepare local PR package** — keep the branch local; do not run `git push`, `gh pr create`, `gh pr edit`, or `gh pr comment`.
- [ ] **12. Draft PR description artifact** — write the intended PR title/body to `{{TASK_DIR}}/artifacts/pr-description.md`; the gateway publishes it only after human approval.
- [ ] **12a. Optional visual evidence manifest** — if screenshots/videos prove the fix, write `{{TASK_DIR}}/artifacts/evidence-manifest.json` using the strict schema below. Use `before_after_pairs` for comparisons; unknown top-level keys are invalid. Omit this file when there is no visual evidence.
  ```json
  {
    "version": 1,
    "preferred_mode": "screenshots",
    "before_after_pairs": [
      {
        "label": "Bug before/after",
        "covers": ["ac1"],
        "before": "before-ac1.png",
        "after": "after-ac1.png"
      }
    ],
    "standalone": [{ "label": "Fixed final state", "covers": ["ac2"], "file": "after-ac2.png" }],
    "omit": ["redundant.png"],
    "videos": { "after": "after.mp4", "preferred": false }
  }
  ```
- [ ] **13. Write report** — create `{{TASK_DIR}}/artifacts/report.md` with: files changed, root cause, fix summary, test results.
- [ ] **14. Update status** — set `STATUS: done`.
- [ ] **15. Write completion signal** — run: `{{TASK_DIR}}/mark complete --outcome success --disposition fixed --mark-last`
      **Do NOT `/exit`.** Stay alive and idle in this session — the operator may attach at the publication gate to ask why/how questions before publish.
