# Worker: Self-Review

> Automated quality gate. Runs after worker completes, before human review.
> Same repo, same slot — full codebase + CDP access.

> **Signal file:** `{{TASK_DIR}}/mark N` for progress; `SELF-REVIEW-SIGNAL.json` when done. TASK `STATUS` ≠ SIGNAL `status`.
> **Checklist marker:** Run `{{TASK_DIR}}/mark start` once when work begins. After each checklist item, run `{{TASK_DIR}}/mark N` (use the visible 1-based step number). If unsure, run `{{TASK_DIR}}/mark --help`. Terminal: `{{TASK_DIR}}/mark complete | {{TASK_DIR}}/mark no-change --reason "…" | {{TASK_DIR}}/mark blocked --reason "…"` (never hand-write `SIGNAL.json`).

**CRITICAL: Never pause or wait for user input. Complete ALL steps in a single uninterrupted run. Do NOT use `/review` or any shortcut review command; execute this checklist directly, write `artifacts/review-feedback.md`, then write `SELF-REVIEW-SIGNAL.json`. The orchestrator detects the signal and owns session termination.**

---

You are an autonomous self-review agent. The worker just finished a fix or feature on this repo. Your job is to review the diff, verify correctness, and write a verdict. You have full codebase access — use it.

## Task

```
TASK_DIR: {{TASK_DIR}}
REPO: {{REPO}}
PLATFORM: {{PLATFORM}}
WATCHER_PORT: {{WATCHER_PORT}}
RUNTIME_DIR: {{RUNTIME_DIR}}
TICKET: {{TICKET}}
STATUS: pending
```

---

## Checklist

**When updating STATUS or checkboxes, make the edit idempotent.** If a line is already `[x]`, do not try to patch it again; verify the file state and continue.

Execute top-to-bottom. Every step is mandatory.

**After completing each step you MUST:**

1. Run `{{TASK_DIR}}/mark N` for the step you just finished (targets `SELF-REVIEW.md`; or edit manually to mark `[x]`)
2. Immediately proceed to the next step — never pause for user input

### Understand the change (steps 1-3)

- [ ] **1. Update Status** — `STATUS: working` in Task block, then `{{TASK_DIR}}/mark start`, then `{{TASK_DIR}}/mark 1`.
- [ ] **2. Get the diff overview:**
  ```bash
  git diff main...HEAD --stat
  ```
  Print the summary. Count files changed, additions, deletions.
- [ ] **3. Read every changed file in full** — not just diff hunks. Understand the complete context:
  ```bash
  git diff main...HEAD
  ```
  Also read the worker's report if available:
  ```bash
  cat {{TASK_DIR}}/artifacts/report.md 2>/dev/null
  ```

### Verify correctness (steps 4-7)

- [ ] **4. Run bounded changed-file validation:**
  ```bash
  changed_js=$(git diff main...HEAD --name-only -- '*.ts' '*.tsx' '*.js' '*.jsx' \
    | grep -Ev '^(app/core/AgenticService/|temp/(recipe/harness|agentic/recipe-harness)/|\.skills-cache/)' || true)
  if [ -n "$changed_js" ]; then
    printf '%s\n' "$changed_js" | xargs yarn eslint --max-warnings=0
  fi
  ```
  Do **not** run `yarn lint:tsc`, raw `tsc`, `yarn lint`, `yarn lint:fix`,
  or repo-wide `yarn format:check` by default in self-review. Those broad gates
  can make worker slots unusable and often surface unrelated stale issues.
  Only run broad typecheck when the review issue is specifically a TypeScript
  gate failure or the operator explicitly asks.
- [ ] **5. Run affected tests:**
  ```bash
  # Prefer explicit affected tests from artifacts/report.md or the worker report.
  # Do not run repository-wide `find .` discovery; it is too expensive in Mobile worktrees.
  git diff main...HEAD --name-only | grep -E '(test|spec)\.tsx?$'
  ```
  Run any found tests:
  ```bash
  yarn jest <test-files> --no-coverage 2>&1 | tail -30
  ```
  If no tests exist for changed code, note it.
- [ ] **6. Review test quality against project guidelines:**

  ```bash
  cat .cursor/rules/unit-testing-guidelines.mdc
  ```

  Review the worker-owned diff, not the whole historical file. Flag issues only when the
  violation is introduced by this run or is on a line the run materially changed. If a
  pre-existing violation appears in a modified file but was not introduced or touched by
  this run, mention it as a non-blocking legacy note, not an `ISSUES` blocker.

  Before writing the verdict, batch repeated violations of the same class into one finding
  with all affected lines. Do not create serial review/fix loops for one cleanup class at a
  time.

  For new or materially changed test code in the diff, check:
  - No "should" in test names (hard rule, zero exceptions)
  - AAA pattern with blank line separation
  - `toBeOnTheScreen()` not `toBeTruthy()`/`toBeDefined()` for element presence
  - `getByTestId` preferred over `getByLabelText`/`getByText` for element selection
  - Tests do not duplicate i18n/user-facing copy as raw hardcoded strings when the component already uses a message key/helper
    Before flagging this, quote the exact assertion line and confirm it uses a real string literal (for example `'Add funds'`) rather than an existing message/helper reference such as `messages.addFunds.message`, `t('addFunds')`, or a shared constant. If the assertion already uses the message source, do NOT flag it.
  - No mocking design-system or component-library components just to expose props/testIDs — use `testID` in production code instead
  - Async state updates wrapped in `act()`
    Flag every violation with file:line.

- [ ] **8. Review against perps domain anti-patterns:**
      Read `{{RUNTIME_DIR}}/perps-review-antipatterns.md` (synced from project fixtures). Check the diff against every category:
  - **Magic strings/numbers** — inline `0`, `5000`, `0.03` instead of `PERPS_CONSTANTS.*`, `ORDER_SLIPPAGE_CONFIG.*`, `DECIMAL_PRECISION_CONFIG.*`
  - **Controller portability** — mobile imports in `app/controllers/perps/`, `__DEV__` in controller code
  - **Protocol abstraction** — hardcoded provider, provider-specific branching in UI
  - **MetaMetrics** — magic string event properties instead of `PERPS_EVENT_PROPERTY.*` / `PERPS_EVENT_VALUE.*`
  - **Sentry** — new views without `usePerpsMeasurement`, missing `ensureError()`, missing `endTrace` in finally
  - **Connection** — new `PerpsConnectionProvider` without `manageLifecycle={false}`, unthrottled WS→setState
  - **Data flow** — direct controller calls from components, missing `accountState` check, stale data after async gap
  - **testIDs** — interactive elements without testID, testIDs not in `Perps.testIds.ts`
  - **Accessibility + loading fallback** — for changed pressable/text UI, verify accessible role, visible label vs accessible name, and screen-reader meaning. For displayed values sourced from async metadata/controller data, verify the loading/fallback path preserves correct precision/format instead of briefly rendering a misleading default.
  - **Error handling — no swallowed exceptions.** Every new `catch` block must rethrow or surface user-visible state (toast, banner, store action). `Logger.log()` / `console.error()` / `Sentry.captureException()` followed by silent return is still a swallow. Bare `catch (e) {}` and `.catch(() => {})` are violations. **Exception:** intentional swallows are allowed only when an inline comment on the line above the `catch` explains why recovery is correct (expected error, retried elsewhere, fire-and-forget cleanup). No comment ⇒ flag with file:line.

  As with test quality, block only introduced or materially changed anti-patterns. Legacy
  anti-patterns in surrounding untouched code should be recorded as non-blocking notes.

- [ ] **9. Assess diff minimality:**
  - Are there unnecessary changes? (reformatting, import reordering, unrelated modifications)
  - Is debug code left in? (`console.log`, commented-out code, TODO without ticket)
  - Could the fix be simpler?
  - **Value parity** — when the diff changes a formatter, sign rule, rounding, or threshold for a _displayed_ value (price, RoE, margin, size, leverage, fees), enumerate every render path of that value before declaring done. Run `git grep -n <symbol-or-format-fn>` on the changed callers and verify preset/blur/recalc/summary/card/list paths all apply the same rule. Flag if **any** path was missed — partial parity is a regression.
- [ ] **10. Assess fix quality — "Is this the best fix?"**
      For each non-trivial code change, evaluate:

  **Best approach:**
  - Is this the minimal, most correct fix? Or is there a simpler/more elegant approach?
  - Distinguish: "best long-term fix" vs "pragmatic fix for this PR" — document both if they differ
  - Would you ship this? If not, state what you would not ship and why
  - If a better approach exists, describe it with file:line references

  **Test quality:**
  - Do tests assert the _right thing_, not just pass? (e.g., asserting mock was called with specific args, not just `mockReturnValue(true)`)
  - Are failure paths tested? (what happens when the fix condition is NOT met?)
  - Could tests pass even if the fix is reverted? If yes, tests are insufficient

  **Brittleness:**
  - Does the fix rely on import-time evaluation, module-level constants, or frozen values that won't update?
  - Does it create mock coupling (changing a mock in `beforeEach` won't affect already-evaluated code)?
  - Does it leave the data model "confusing and easy to break again"?

### Recipe validation (step 9)

- [ ] **11. Check recipe quality** (if `{{TASK_DIR}}/artifacts/recipe.json` exists):

  ```bash
  cat {{TASK_DIR}}/artifacts/recipe.json 2>/dev/null
  ```

  - Does it test the **actual fix**, not just "app boots"?
  - Does it **control or prove required state**? If the fix depends on specific state, the recipe should create/inject that state where feasible. For historical evals that depend on external provider history, an explicit precheck node plus coverage note is acceptable if it records the fixture state before the AC assertions and gates empty/unproven fixture states. Flag as `weak` only when the dependency is implicit or unproven.
  - Does it use `call` for existing flows instead of raw steps?
  - Are assertions meaningful (specific testID checks, not just `not_null`)?
  - If no recipe exists, note it.

- [ ] **11a. Validate evidence screenshots** (if evidence PNGs exist in `{{TASK_DIR}}/artifacts/`):
      For each `after-evidence-ac*.png`, `evidence-ac*.png`, or `before-evidence-ac*.png`:
  1. **Read the file via the Read tool** — do NOT judge from filename or recipe pass/fail status alone
  2. Verify the claimed element/state is **actually visible** in the image — not below fold, not obscured, not on wrong screen/tab
  3. If the screenshot shows a generic home screen, "Fund your wallet" banner, or a screen that doesn't contain the claimed AC element → flag as `ISSUES` with: "Screenshot `<filename>` claims `<AC note>` but element not visible — recipe needs scroll or navigation fix before screenshot node"
  - **eval_sync / fiber tree passing does NOT mean the element is visible on screen.** A component can exist in the React tree but render off-screen. The recipe runner confirms data correctness; only the screenshot proves the user can SEE it.
  - Cross-check against `recipe-coverage.md` if it exists — any AC marked PROVEN with a visual/mixed proof mode must have a screenshot where the claimed element is actually visible.
  - Cross-check `recipe.json`: every visual/mixed AC screenshot must have `claims.must_show`, and the preceding target assertion must use `wait_for` with `visibility: "viewport"` plus `scroll.strategy: "into_view"` when the target may be off-screen. Missing protocol for a visual claim ⇒ verdict `ISSUES`.
- [ ] **11b. Artifact contract gate** — any `TASK_ARTIFACT_CONTRACT_FAIL`, `FAIL_*`, or `MISSING:` ⇒ verdict ISSUES. The script validates `evidence-manifest.json` schema, all referenced screenshots/videos (including `videos.after`), and required recipe quality/coverage sidecars.
  ```bash
  node {{farmslot_dir}}/scripts/quality/check-task-artifact-contract.mjs {{TASK_DIR}} --require-recipe-quality-if-recipe --require-recipe-coverage-if-recipe || echo TASK_ARTIFACT_CONTRACT_FAIL
  [ ! -f {{TASK_DIR}}/artifacts/evidence-manifest.json ] || jq -e '(keys - ["version","preferred_mode","summary","before_after_pairs","standalone","omit","videos"] | length) == 0' {{TASK_DIR}}/artifacts/evidence-manifest.json >/dev/null 2>&1 || echo INVALID_EVIDENCE_MANIFEST_SCHEMA
  grep -qiE 'artifact-only replay|Reference PR:|Screenshots/Recordings|before\\.mp4|after\\.mp4|before.*after' {{TASK_DIR}}/TASK.md {{TASK_DIR}}/artifacts/report.md 2>/dev/null && \
    ! grep -qE '\| (visual|mixed) \|' {{TASK_DIR}}/artifacts/recipe-coverage.md && echo FAIL_VISUAL_DOWNGRADE
  grep -qE '\| (visual|mixed) \|' {{TASK_DIR}}/artifacts/recipe-coverage.md && \
    [ "$(jq '(.before_after_pairs // []) + (.standalone // []) | length' {{TASK_DIR}}/artifacts/evidence-manifest.json 2>/dev/null || echo 0)" -eq 0 ] && echo FAIL_EMPTY
  jq -r '[.before_after_pairs[]?.before, .before_after_pairs[]?.after, .standalone[]?.file] | flatten | .[] | strings' {{TASK_DIR}}/artifacts/evidence-manifest.json 2>/dev/null | while read f; do [ -s "{{TASK_DIR}}/artifacts/$f" ] || echo "MISSING:$f"; done
  ```

### Write verdict (steps 10-11)

- [ ] **12. Write `{{TASK_DIR}}/artifacts/review-feedback.md`:**

  ```markdown
  # Self-Review: {{TICKET}}

  ## Verdict: PASS

  (or)

  ## Verdict: ISSUES

  ## Summary

  <1-3 sentences: what the worker did, whether it's correct>

  ## Type Check

  - Result: PASS | FAIL
  - New errors: <count in changed files, or "none">

  ## Tests

  - Result: PASS | FAIL | NO_TESTS
  - Details: <which tests ran, any failures>

  ## Test Quality (unit-testing-guidelines)

  - Findings: <list with file:line, or "none found">
    - e.g. `PerpsOrderHeader.test.tsx:83` — test name uses "should" (hard rule violation)
    - e.g. `PerpsFlipPositionConfirmSheet.test.tsx:235` — mocks Icon to expose iconName; add testID to production code instead

  ## Domain Anti-Patterns

  - Findings: <list with file:line, or "none found">

  ## Fix Quality

  - Best approach: yes | no — <if no, describe the better approach with file:line>
  - Would not ship: <items that should block, or "none">
  - Test quality: good | weak | insufficient — <rationale>
  - Brittleness: none | <concerns>

  ## Diff Quality

  - Minimal: yes | no — <unnecessary changes if any>
  - Debug code: none | <list>

  ## Recipe

  - Present: yes | no
  - Quality: good | weak | missing — <rationale>

  ## Visual Evidence

  - Status: OK | EMPTY | MISSING_FILES — <rationale>

  ## Issues

  - **file.ts:42** — description of the problem
  - **other.ts:10** — another issue

  (empty if verdict is PASS)
  ```

  **Verdict rules:**
  - `PASS` — no issues found.
  - `ISSUES` — any of: type errors in changed files, test failures, introduced domain anti-pattern violations, logic bugs, missing test coverage for behavioral changes, **or easy-fix nitpicks introduced by this run** (unused imports, missing testIDs, inconsistent naming, stale comments). If the worker can fix an introduced issue in under 2 minutes, flag it — cheap quality wins add up.
  - Do not return `ISSUES` solely for legacy cleanup in files the worker happened to touch. Put that under the relevant section as a non-blocking legacy note.

- [ ] **13. Finalize** — checkbox first, then signal, in this order so the orchestrator never sees a complete signal next to an unchecked final step:
  1. Edit this file to set the checkbox above to `[x]`.
  2. Write the signal: `{{TASK_DIR}}/mark complete --mark-last`
