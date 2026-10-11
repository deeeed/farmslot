# Update-branch checklist

**CRITICAL: Never pause or wait for user input. Complete ALL steps in a single uninterrupted run.**

This is an **update-branch** run: bring this PR branch up to date against its base
branch and continue CI/finalization. The intent is not "make a merge commit from
main" — it is "update this branch, resolve any fallout, keep CI green."

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

`BRANCH_UPDATE_STRATEGY` (in the TASK.md task block) selects how to update the branch:

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
- [ ] **2. Start** — `{{TASK_DIR}}/mark start`, then `{{TASK_DIR}}/mark 2`.
- [ ] **3. Confirm target + strategy** — verify `PR_NUMBER` and `PR_BRANCH`; resolve `BRANCH_UPDATE_STRATEGY` (rebase | merge | project-default) to the concrete strategy you will use.
- [ ] **4. Checkout PR branch** — `git checkout {{PR_BRANCH}}`
- [ ] **5. Update branch** — update from the base branch using the selected strategy and resolve any conflicts on `{{PR_BRANCH}}`.
- [ ] **6. Validate** — run typecheck and focused tests:
  ```bash
  (cd "{{REPO}}/apps/command-center" && yarn typecheck)
  cd "{{REPO}}" && node scripts/quality/run-tsx-tests.mjs --cwd services/gateway --tsconfig tsconfig.json src/path/to/affected.test.ts
  ```
  Replace the example test path with explicit affected suites. Confirm every requested suite ran; do not invoke a glob as a single tsx script.
- [ ] **7. Push** — publish the updated branch. For `rebase`, use `git push --force-with-lease`; for `merge`, a normal `git push`. Record the exact push command used.
- [ ] **8. Write report** — create `{{TASK_DIR}}/artifacts/report.md` recording: **selected strategy** (rebase | merge), **validation notes** (typecheck + test results), **conflict resolution summary**, **push command used**, and **risk notes** (force-push impact, follow-up needed).
- [ ] **9. Write `{{TASK_DIR}}/artifacts/learnings.md`** — required packaged evidence. Use 3–5 bullets on key learnings or struggles during the session; if nothing relevant: `- Nothing relevant — straightforward run; no blockers or surprises.`
- [ ] **10. Signal completion** — run `{{TASK_DIR}}/mark complete --mark-last`

## Acceptance verdicts + recipe coverage

Before successful completion or handing off this PR, set `export TASK_DIR="{{TASK_DIR}}"`. Use the deployed agent runtime, not the application checkout's dependencies:

```bash
FARMSLOT_ACCEPTANCE_ROOT="{{farmslot_dir}}"
case "$FARMSLOT_ACCEPTANCE_ROOT" in
  "~/"*) FARMSLOT_ACCEPTANCE_ROOT="$HOME/${FARMSLOT_ACCEPTANCE_ROOT#\~/}" ;;
esac
node "$FARMSLOT_ACCEPTANCE_ROOT/packages/agent-runtime/bin/farmslot-agent.mjs" ac list
```

If `ac list` has no registered criteria, skip ledger recording/rendering and retain the task's existing recipe-coverage workflow. Otherwise, record an honest verdict for each AC with `node "$FARMSLOT_ACCEPTANCE_ROOT/packages/agent-runtime/bin/farmslot-agent.mjs" ac set AC-N proven --proof-mode state --recipe-node <node-id> --evidence <task-relative-path>`. Use the actual state, visual or mixed mode and existing evidence; omit the recipe node when no recipe applies. Use `untestable --note <reason>` only when proof is unavailable. Check `ac list` again.

When a recipe exists and ACs are registered, render coverage to a temporary file and replace the existing coverage only after success:

```bash
coverage_tmp=$(mktemp "{{TASK_DIR}}/artifacts/recipe-coverage.XXXXXX")
if node "$FARMSLOT_ACCEPTANCE_ROOT/packages/agent-runtime/bin/farmslot-agent.mjs" ac render > "$coverage_tmp"; then
  mv "$coverage_tmp" "{{TASK_DIR}}/artifacts/recipe-coverage.md"
else
  rm -f "$coverage_tmp"
  exit 1
fi
```

Before `mark complete`, run `node "$FARMSLOT_ACCEPTANCE_ROOT/packages/agent-runtime/bin/farmslot-agent.mjs" artifact-check "{{TASK_DIR}}" --require-recipe-coverage-if-recipe --require-acceptance-status`. Refresh affected verdicts and coverage after the final proof run. Checklist completion alone does not assess an AC.
