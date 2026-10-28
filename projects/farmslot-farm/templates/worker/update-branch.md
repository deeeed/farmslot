# Update-branch checklist

**CRITICAL: Never pause or wait for user input. Complete ALL steps in a single uninterrupted run.**

This is an **update-branch** run: rebase this PR branch onto its publication base,
resolve conflicts, validate and push with a recorded remote-SHA lease.

## SCOPE BUDGET (hard rule)

This flow is **near-mechanical**. Stay inside the checklist — do not open drive-by
refactors, broad refactors of unrelated packages, or multi-PR scope.

Soft ceilings (monitor warns once when exceeded; do not treat as license to keep going):

- **Turn budget:** ~80 turns (`monitoring.flows.update-branch.max_turns`)
- **Token budget:** ~8M total tokens (`monitoring.flows.update-branch.max_total_tokens`)

If you are past those ceilings, you have expanded past branch-update work. Stop new
workstreams, finish the current checklist item, then run
`{{TASK_DIR}}/mark complete --mark-last` or `{{TASK_DIR}}/mark blocked --reason "…"`.
Never hand-write `SIGNAL.json`. A 100M-token update-branch run is a failure mode,
not thoroughness.

## Strategy

Use a rebase with the exact remote PR-head lease described in TASK.md. If branch
protection refuses that push, report the refusal and block; do not fall back to a
merge commit.

## Checklist

- [ ] **1. Read project docs** — read `CLAUDE.md` (root) and `apps/command-center/CLAUDE.md` to understand repo structure, conventions, and validation rules.
- [ ] **2. Start** — `{{TASK_DIR}}/mark start`, then `{{TASK_DIR}}/mark 2`.
- [ ] **3. Confirm target** — verify `PR_NUMBER`, `PR_BRANCH` and `PUBLICATION_BASE` in TASK.md.
- [ ] **4. Checkout PR branch** — `git checkout {{PR_BRANCH}}`
- [ ] **5. Update branch** — fetch `{{PUBLICATION_BASE}}` from origin and rebase onto `origin/{{PUBLICATION_BASE}}`. Follow TASK.md's recorded remote-SHA lease guard and resolve conflicts on `{{PR_BRANCH}}`. The default branch remains the separate freshness reference.
- [ ] **6. Validate** — run typecheck and focused tests:

  ```bash
  (cd "{{REPO}}/apps/command-center" && yarn typecheck)
  cd "{{REPO}}" && node scripts/quality/run-tsx-tests.mjs --cwd services/gateway --tsconfig tsconfig.json src/path/to/affected.test.ts
  ```

  Replace the example test path with explicit affected suites. Confirm every requested suite ran; do not invoke a glob as a single tsx script.
- [ ] **7. Push** — publish the updated branch with an explicit lease against the recorded remote PR-head SHA. Record the exact push command used.
- [ ] **8. Write report** — create `{{TASK_DIR}}/artifacts/report.md` recording: publication base, validation results, conflict resolution, exact push command and any remaining risks.
- [ ] **9. Write `{{TASK_DIR}}/artifacts/learnings.md`** — required packaged evidence. One bullet per failure in this run that is likely to recur and should change a template, reviewer or engine step; `- None` when there is none.
- [ ] **10. Signal completion** — run `{{TASK_DIR}}/mark complete --mark-last`

## Recipe proof + acceptance review

Follow TASK.md for task-bound recipe proof, registered criteria, coverage and completion commands. Retain the recipe results and resolve refused checks before completing the checklist.
