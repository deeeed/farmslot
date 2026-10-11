# PR-complete checklist

**CRITICAL: Never pause or wait for user input. Complete ALL steps in a single uninterrupted run.**

## Checklist

- [ ] **1. Read project docs** — read `CLAUDE.md` (root) and `apps/command-center/CLAUDE.md` to understand repo structure, conventions, and validation rules.
- [ ] **2. Start** — `{{TASK_DIR}}/mark start`, then `{{TASK_DIR}}/mark 2`.
- [ ] **3. Confirm PR context** — verify `PR_NUMBER`, `PR_BRANCH`, and current task scope before editing.
- [ ] **4. Checkout PR branch** — `git checkout {{PR_BRANCH}}`
- [ ] **5. Read inherited context** — review `{{TASK_DIR}}/inputs/inherited/` and any materialized family artifacts before making changes.
- [ ] **6. Fix the reported PR follow-up issue** — keep changes minimal and scoped to the current follow-up.
- [ ] **7. Validate** — run typecheck and focused tests:

  ```bash
  (cd "{{REPO}}/apps/command-center" && yarn typecheck)
  # Replace the example path with the affected gateway test files.
  cd "{{REPO}}" && node scripts/quality/run-tsx-tests.mjs --cwd services/gateway --tsconfig tsconfig.json src/path/to/affected.test.ts
  ```

{{CI_PARITY_STEP}}

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
  # Fail closed on fetch: do not trust a stale origin/main tracking ref.
  if ! git fetch origin main; then
    echo "WARN: git fetch origin main failed — behindMain/mergeConflicts below are unknown (not zero/clean)."
    behindMain=unknown
    mergeConflicts=unknown
  else
    behindMain=$(git rev-list --count HEAD..origin/main)
    echo "behindMain=$behindMain"
    # Non-destructive: --write-tree exit 1 = conflicts (classic merge-tree markers are +<<<<<<<).
    # Subshell keeps set +e from enabling errexit in a persistent pane shell.
    mt_rc=0
    mt_out=$(
      set +e
      git merge-tree --write-tree --name-only HEAD origin/main 2>&1
      echo "__MT_RC:$?"
    )
    mt_rc=$(printf '%s\n' "$mt_out" | sed -n 's/^__MT_RC://p' | tail -1)
    mt_out=$(printf '%s\n' "$mt_out" | sed '/^__MT_RC:/d')
    if [ "$mt_rc" = "1" ]; then
      mergeConflicts=true
    elif [ "$mt_rc" = "0" ]; then
      mergeConflicts=false
    else
      mergeConflicts=unknown
    fi
    echo "mergeConflicts=$mergeConflicts"
    echo "$mt_out" | sed -n 's/^CONFLICT ([^)]*): Merge conflict in //p'
  fi
  ```
  **Failure path:** if `mergeConflicts=unknown`, stop and fix the probe; do not
  report the branch clean. If `mergeConflicts=true` or `behindMain` is material,
  update the branch first — **prefer** `git merge origin/main` during open review loops;
  use `git rebase origin/main` + `git push --force-with-lease` only when the
  project already standardizes on rebase. Never auto force-push mid-loop.
  Record `behindMain`, `mergeConflicts`, and the next command used in the report.
- [ ] **10. Write report** — create `{{TASK_DIR}}/artifacts/comments-report.md` with: files changed, issue addressed, validation results, behindMain/mergeConflicts.
- [ ] **11. Write `{{TASK_DIR}}/artifacts/learnings.md`** — required packaged evidence. Use 3–5 bullets on key learnings or struggles during the session; if nothing relevant: `- No reviewer-driven learnings — no actionable comment fixes on this run.`
- [ ] **12. Signal completion** — run: `{{TASK_DIR}}/mark complete --mark-last` (validates learnings, report, checklist, artifact contract)

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
