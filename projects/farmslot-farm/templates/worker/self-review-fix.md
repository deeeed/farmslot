# Worker: Self-Review Fix Pass

> Self-review found issues. Fix them, verify, update artifacts, commit and push.

> **Checklist/signal target:** Always run `{{TASK_DIR}}/mark --checklist SELF-REVIEW-FIX.md --signal SELF-REVIEW-FIX-SIGNAL.json …`. This explicit target survives nested review recovery and keeps progress visible even if the ambient worker checklist changes.
> **Checklist marker:** Start with `{{TASK_DIR}}/mark --checklist SELF-REVIEW-FIX.md --signal SELF-REVIEW-FIX-SIGNAL.json start`. After each item, replace `…` with its visible 1-based step number. Terminal actions use the same prefix followed by `complete`, `no-change --reason "…"`, or `blocked --reason "…"` (never hand-write a signal file).

**CRITICAL: Never pause or wait for user input. Complete ALL steps. After each step, run the explicit checklist/signal marker above. Manually editing a checkbox does not emit the progress signal.**

---

## Task

```
TASK_DIR: {{TASK_DIR}}
REPO: {{REPO}}
TICKET: {{TICKET}}
STATUS: pending
```

## Issues Found by Self-Review

{{ISSUES}}

---

## Scope Discipline — READ FIRST

**Smallest diff that fixes the real cause.** No bandages, no refactors.

- Diagnose first: state the root cause to yourself in one sentence BEFORE editing. If you can't, re-read until you can.
- Fix the cause, not the symptom. Null-checks hiding the bug, try/catch swallowing errors, one-call special-cases = bandages, not fixes.
- Touch ONLY flagged files/lines. No drive-by cleanups, renames, reformatting, or new abstractions.
- Don't apply a change just to silence the reviewer. If the prescription is wrong, write the correct fix and note why in `report.md`.
- Each iteration shrinks the issue list, not the diff. Scope creep gets rejected.
- If the real fix needs broader changes, run `{{TASK_DIR}}/mark --checklist SELF-REVIEW-FIX.md --signal SELF-REVIEW-FIX-SIGNAL.json blocked --reason "..."` with a one-line reason — don't ship a regression to close the loop, and never hand-write the signal file.

---

## Checklist

> If the review issues turn out to require no code changes, write `{{TASK_DIR}}/artifacts/no-change-report.md` explaining why before running `{{TASK_DIR}}/mark --checklist SELF-REVIEW-FIX.md --signal SELF-REVIEW-FIX-SIGNAL.json no-change --reason "..."`.

### Fix (steps 1-3)

- [ ] **1. Update Status** — `STATUS: working` in Task block, then run the explicit checklist/signal marker with `start`, followed by `1`.
- [ ] **2. Read the review feedback** — `{{TASK_DIR}}/artifacts/review-feedback.md` has the full analysis. Understand each issue.
- [ ] **3. Fix each issue:**
  For each issue above:
  - Open the file, make the smallest possible fix
  - Diff discipline: only the lines required by the issue. Nothing more.

### Verify (steps 4-5)

- [ ] **4. Run focused validation** — per touched workspace, from `{{REPO}}`:
  ```bash
  # For each workspace you changed (packages/*, services/*, apps/command-center):
  yarn --cwd <workspace> format > /dev/null 2>&1 && yarn --cwd <workspace> quality
  ```
  Every touched workspace's `quality` must exit 0. Do NOT run repo-wide `tsc -b`
  (some packages emit into source paths); use each workspace's own scripts.
  If you touched `scripts/*.sh`, run `bash -n` on each edited script and
  `yarn test:project-hooks` from the repo root.
- [ ] **5. Artifact contract gate:**
  ```bash
  cd {{REPO}}
  node {{farmslot_dir}}/scripts/quality/check-task-artifact-contract.mjs {{TASK_DIR}} --require-recipe-coverage-if-recipe
  ```
  Fix any failure before signaling completion.

### Update artifacts (steps 6-8)

- [ ] **6. Append to report.md** — add a "Self-Review Fixes" section to `{{TASK_DIR}}/artifacts/report.md`:
  ```markdown
  ## Self-Review Fixes
  - <file:line> — <what you fixed>
  ```
- [ ] **7. Refresh the PR description** — if the fixes changed behavior, tests, or
  validation evidence, update `{{TASK_DIR}}/artifacts/pr-description.md` to match
  (local artifact only; the pipeline owns publication).
- [ ] **8. Commit and push:**
  ```bash
  cd {{REPO}}
  git add -A && git commit -m "fix: address self-review findings for {{TICKET}}"
  git push
  ```
  Conventional Commits; never `--amend`; never commit secrets or `{{TASK_DIR}}` contents into the repo.

### Branch freshness before re-review ready (step 9) — HARD GATE

Long fix/review loops leave the feature branch behind `origin/main`. Surface that
**before** signaling re-review ready so merge pain is not deferred to CI.

- [ ] **9. Behind-main + merge-tree conflict probe** — after each must-fix commit and
  before signaling re-review ready:
  ```bash
  cd {{REPO}}
  # Fail closed on fetch: do not trust a stale origin/main tracking ref.
  if ! git fetch origin main; then
    echo "WARN: git fetch origin main failed — behindMain/mergeConflicts below are unknown (not zero/clean)."
    behindMain=unknown
    mergeConflicts=unknown
  else
    behindMain=$(git rev-list --count HEAD..origin/main)
    echo "behindMain=$behindMain"
    # Non-destructive conflict probe (does not update the index or working tree).
    # git merge-tree --write-tree: exit 0 = clean, exit 1 = conflicts; --name-only lists paths.
    # Classic merge-tree $(merge-base) form prints +<<<<<<< markers and is NOT reliable with ^-anchored greps.
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
  **Failure path (must fix before re-review ready):**
  - If `mergeConflicts=unknown`, stop and fix the probe; do not mark complete or
    report the branch clean.
  - If `mergeConflicts=true` **or** `behindMain` is above the project threshold
    (default: any behindMain > 0 when continuing a re-review loop):
    - **Prefer merge** into the feature branch during open review loops (avoids
      force-push): `git merge origin/main`, resolve conflicts, commit, push.
    - Use **rebase** only when the project already standardizes on it
      (`merge_main_strategy: rebase` / BRANCH_UPDATE_STRATEGY):
      `git rebase origin/main` then `git push --force-with-lease` — never bare
      `--force`, and never auto force-push mid-loop without project policy.
  - Record `behindMain`, `mergeConflicts`, conflict path samples, and the
    concrete next command you ran in `{{TASK_DIR}}/artifacts/report.md`.
  - Do **not** mark complete while merge conflicts remain unresolved.

### Complete

- [ ] **10. Signal completion:**
  ```bash
  {{TASK_DIR}}/mark --checklist SELF-REVIEW-FIX.md --signal SELF-REVIEW-FIX-SIGNAL.json complete --mark-last
  ```
