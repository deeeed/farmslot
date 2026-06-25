# Worker: Feature — {{TICKET_ID}}

> **Signal file:** Write `{{TASK_DIR}}/SIGNAL.json` with status updates.
> **Checklist marker:** After each checklist item, run `{{TASK_DIR}}/mark N` (use the visible 1-based step number). If unsure, run `{{TASK_DIR}}/mark --help`. The final item can add `--status complete --outcome success`.

---

**CRITICAL: Never pause or wait for user input. Complete ALL steps in a single uninterrupted run.**

**Publication model:** keep the workspace local-first. Do not run `git push`, `gh pr create`,
`gh pr edit`, or `gh pr comment`. The gateway will prepare a validated workspace package for
human approval, optional independent review, and CI only after publication.

## Task

```text
TICKET: {{TICKET_ID}}
TITLE: {{TICKET_TITLE}}
BRANCH: {{BRANCH}}
TASK_DIR: {{TASK_DIR}}
STATUS: pending
```

## Checklist

- [ ] **1. Read project docs** — read `CLAUDE.md` (root) and `apps/command-center/CLAUDE.md` to understand repo structure, conventions, and validation rules.
- [ ] **2. Update status** — set `STATUS: working` in this file.
- [ ] **3. Read the feature requirements** — understand scope, acceptance criteria, and affected packages.
- [ ] **4. Create branch** — `git checkout -b {{BRANCH}}`
- [ ] **5. Plan implementation** — identify files to create/modify, types to add to `@farmslot/protocol`, gateway methods, UI components.
- [ ] **6. Implement types** — add shared types to `packages/protocol/src/types.ts` if needed.
- [ ] **7. Implement gateway logic** — add methods, handlers, or engine changes.
- [ ] **8. Add tests** — write tests using `node:test` + `node:assert` for new gateway logic.
- [ ] **9. Validate** — run typecheck and tests:
  ```bash
  cd apps/command-center && yarn typecheck
  cd apps/command-center && yarn exec tsx ../../services/gateway/src/*.test.ts
  ```
- [ ] **10. Self-review** — read the diff. Check for: inline type duplication, unnecessary helpers, comments that restate code.
- [ ] **11. Commit** — atomic commit(s) following the repo's Lore commit protocol.
- [ ] **12. Prepare local workspace package inputs** — keep the branch local; write the intended PR title/body to `{{TASK_DIR}}/artifacts/pr-description.md`; do not push or mutate GitHub.
- [ ] **12a. Optional visual evidence manifest** — if screenshots/videos prove the change, write `{{TASK_DIR}}/artifacts/evidence-manifest.json` using the strict schema below. Use `before_after_pairs` for comparisons; unknown top-level keys are invalid. Omit this file when there is no visual evidence.
  ```json
  {
    "version": 1,
    "preferred_mode": "screenshots",
    "before_after_pairs": [
      {
        "label": "What changed",
        "covers": ["ac1"],
        "before": "before-ac1.png",
        "after": "after-ac1.png"
      }
    ],
    "standalone": [{ "label": "Final state", "covers": ["ac2"], "file": "after-ac2.png" }],
    "omit": ["redundant.png"],
    "videos": { "after": "after.mp4", "preferred": false }
  }
  ```
- [ ] **13. Write report and signal** — create `{{TASK_DIR}}/artifacts/report.md` with files changed, implementation summary, local review notes, screenshots/assets to validate, and test results; update `STATUS: done`, then write the completion signal:
  ```bash
  {{TASK_DIR}}/mark 13 --status complete --outcome success
  ```
  **Do NOT `/exit`.** Stay alive and idle in this session — the operator may attach at the publication gate to ask why/how questions before publish.
