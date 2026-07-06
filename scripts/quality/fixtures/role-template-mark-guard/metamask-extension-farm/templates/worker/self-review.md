# Worker: Self-Review

> Automated quality gate. Runs after worker completes, before human review.
> Same repo, same slot — full codebase + CDP access.

> **Signal file:** `{{TASK_DIR}}/mark N` for progress; `SELF-REVIEW-SIGNAL.json` when done. TASK `STATUS` ≠ SIGNAL `status`. The orchestrator watches this for instant completion detection.
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
CDP_PORT: {{CDP_PORT}}
SESSION: {{SESSION}}
RUNTIME_DIR: {{RUNTIME_DIR}}
TICKET: {{TICKET}}
STATUS: pending
```

---

### Recipe tooling

Resolve once, then reuse:

```bash
cd {{REPO}}
RUNNER_CMD="$({{recipe_runner_resolve_cmd}})"
HARNESS_CMD="$({{recipe_harness_resolve_cmd}})"
```

## Checklist

Execute top-to-bottom. Every step is mandatory.

**When updating STATUS or checkboxes, make the edit idempotent.** If a line is already `[x]`, do not try to patch it again; verify the file state and continue.

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

- [ ] **4. Run bounded local validation:**

  ```bash
  yarn lint:changed
  yarn verify-locales --quiet
  yarn circular-deps:check
  ```

  Treat any failure here as a blocker.

  Do **not** run broad full-repo gates (`yarn lint`, `yarn lint:fix`,
  `yarn lint:eslint`, `yarn lint:format`, or `yarn lint:tsc`) by default in
  self-review. Those commands can make the machine unusable and often surface
  unrelated stale issues. Only run `yarn lint:tsc` when the diff changes
  dependency/type/public API surfaces where TypeScript compatibility is itself
  part of the review (for example `package.json`, `yarn.lock`, shared exported
  types, or controller/mock type contracts), or when the operator explicitly
  asks for the broad gate. If you run it, record why in `review-feedback.md`.

- [ ] **5. Run affected tests:**
  ```bash
  # Find tracked test files for changed code. Do not use raw `find .` in this
  # repo: temp/build/dependency folders make it slow and noisy.
  {
    git diff main...HEAD --name-only -- '*.test.ts' '*.test.tsx' '*.spec.ts' '*.spec.tsx'
    git diff main...HEAD --name-only -- '*.ts' '*.tsx' | while read -r f; do
      dir=$(dirname "$f")
      base=$(basename "$f" .tsx); base=$(basename "$base" .ts)
      git ls-files "${dir}/${base}.test.*" "${dir}/${base}.spec.*" "${dir}/__tests__/${base}*" 2>/dev/null || true
    done
  } | sort -u | head -10
  ```
  Run any found tests:
  ```bash
  yarn jest <test-files> --no-coverage 2>&1 | tail -30
  ```
  If no tests exist for changed code, note it.
- [ ] **6. Review test quality against project guidelines:**
      For every new or modified test file in the diff, check:
  - No "should" in test names (hard rule, zero exceptions)
  - AAA pattern with blank line separation
  - Async state updates wrapped in `act()`
  - Assertions are specific (not just `toBeTruthy()`/`toBeDefined()`)
  - Tests do not duplicate i18n/user-facing copy as raw hardcoded strings when the component already uses a message key/helper
    Before flagging this, quote the exact assertion line and confirm it uses a real string literal (for example `'Add funds'`) rather than an existing message/helper reference such as `messages.addFunds.message`, `t('addFunds')`, or a shared constant. If the assertion already uses the message source, do NOT flag it.
    Flag every violation with file:line.
- [ ] **7. Review against extension domain anti-patterns:**
      Read `{{RUNTIME_DIR}}/extension-review-antipatterns.md` (synced from project fixtures). Check the diff against every category:
  - **Import boundaries** — cross-package imports that bypass `@metamask/` scope, reaching into `app/` from `ui/` or vice versa
  - **Controller usage** — direct controller state mutation from UI, missing selector abstractions
  - **LavaMoat policy** — new dependencies or changed imports that require `lavamoat/browserify/` policy updates
  - **MV3 patterns** — long-running operations in service worker without `keepAlive`, sync storage access in hot paths
  - **Shared state** — mutable module-level state, missing defensive copies
  - **Accessibility + loading fallback** — for changed pressable/text UI, verify accessible role, visible label vs accessible name, and screen-reader meaning. For displayed values sourced from async metadata/controller data, verify the loading/fallback path preserves correct precision/format instead of briefly rendering a misleading default.
  - **Error handling — no swallowed exceptions.** Every new `catch` block must rethrow or surface user-visible state (`displayWarning`, toast, store action). `log.error()` / `console.error()` / `Sentry.captureException()` followed by silent return is still a swallow. Bare `catch (e) {}` and `.catch(() => {})` are violations. **Exception:** intentional swallows are allowed only when an inline comment on the line above the `catch` explains why recovery is correct (expected error, retried elsewhere, fire-and-forget cleanup). No comment ⇒ flag with file:line.
  - **testIDs** — interactive elements without testID
- [ ] **8. Compare with mobile equivalent (if perps change):**
      Check if the diff touches perps components, hooks, or utils:
  ```bash
  git diff main...HEAD --name-only | grep -i perps | head -10
  ```
  If yes, consult the mobile-extension map:
  ```bash
  cat {{RUNTIME_DIR}}/perps-mobile-extension-map.md
  ```
  For each changed perps file, find the mobile equivalent using section 6 of the map and read it:
  ```bash
  ls {{MOBILE_REPO}}/app/components/UI/Perps/Views/ 2>/dev/null | head -20
  ```
  Check for:
  - **Behavioral alignment** — does the extension fix match how mobile handles the same scenario?
  - **Formatting divergence** — any new `.toFixed(2)` or `{min:2, max:2}`? (mobile uses `formatPerpsFiat` — see section 3 of map)
  - **Pattern drift** — did the worker introduce a pattern mobile already solved better?
  - **Missing constants** — inline `0`, `0.03`, `5000` instead of named constants that mobile uses
    If `{{MOBILE_REPO}}` is empty or the change is not perps-related, write "N/A" and proceed.
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

### Recipe validation (step 11)

- [ ] **11. Check recipe quality and re-run it** (if `{{TASK_DIR}}/artifacts/recipe.json` exists):

  ```bash
  cat {{TASK_DIR}}/artifacts/recipe.json 2>/dev/null
  cat {{TASK_DIR}}/artifacts/recipe-quality.json 2>/dev/null
  ```

  If a recipe exists, you must also re-run it against the current code. Reload the extension first because webpack does not hot-reload the active page:

  ```bash
  (cd {{REPO}} && "$RUNNER_CMD" runtime-health --adapter extension --target {{REPO}} --cdp-port {{CDP_PORT}} --json)
  ```

  If the extension is unresponsive or blocked:

  ```bash
  "$RUNNER_CMD" runtime-launch --adapter extension --target {{REPO}} --cdp-port {{CDP_PORT}} --artifacts-dir {{TASK_DIR}}/artifacts/runtime-launch --json
  (cd {{REPO}} && "$RUNNER_CMD" runtime-health --adapter extension --target {{REPO}} --cdp-port {{CDP_PORT}} --json)
  ```

  Then execute the recipe and inspect the resulting trace:

  ```bash
  (cd {{REPO}} && "$RUNNER_CMD" run {{TASK_DIR}}/artifacts/recipe.json --adapter extension --artifacts-dir {{TASK_DIR}}/artifacts/recipe-run --project-root {{REPO}} --json --cdp-port {{CDP_PORT}} --launch-existing-dist)
  cat {{TASK_DIR}}/artifacts/trace.json 2>/dev/null
  ```

  - Does it test the **actual fix**, not just "app boots"?
  - Did the re-run actually pass? If not, verdict must be `ISSUES`.
  - Does `trace.json` show the AC-bound nodes executing successfully, not just a drafted recipe on disk?
  - Does it **seed its own data**? If the fix depends on specific state (e.g. order/funding transactions), the recipe must create or inject that data — a recipe that passes on an empty wallet is trivially true and does not validate the fix. Flag as `weak` if it relies on pre-existing wallet state.
  - Does it use `call` for runner action or task-local flows instead of raw steps?
  - Are assertions meaningful (specific testID checks, not just `not_null`)?
  - If the ticket/AC asks for screenshots, recordings, or visible UI text/copy/warning/label/modal/toast proof, does `recipe-coverage.md` classify at least one relevant AC as `visual` or `mixed`?
  - If `recipe-quality.json` is missing for a task that wrote a recipe, verdict should usually be `ISSUES`, not a silent pass.
  - If no recipe exists, note it.

- [ ] **11a. Validate evidence screenshots** (if evidence PNGs exist in `{{TASK_DIR}}/artifacts/`):
      For each `after-evidence-ac*.png`, `evidence-ac*.png`, or `after-ac*.png`:
  1. **Read the file via the Read tool** — do NOT judge from filename or recipe pass/fail status alone
  2. Verify the claimed element/state is **actually visible** in the image — not below fold, not obscured, not cut off, not on wrong screen/tab
  3. If the screenshot shows a generic home screen or a screen that doesn't contain the claimed AC element → flag as `ISSUES` with: "Screenshot `<filename>` claims `<AC note>` but element not visible — recipe needs scroll or navigation fix before screenshot node"
  - **read-only runtime check / DOM query passing does NOT mean the element is visible on screen.** An element can exist in the DOM but be off-screen or in a different tab/panel. The recipe runner confirms data correctness; only the screenshot proves the user can SEE it.
  - Cross-check against `recipe-coverage.md` if it exists — any AC marked PROVEN with a visual/mixed proof mode must have a screenshot where the claimed element is actually visible.
  - Cross-check `recipe.json`: every visual/mixed AC screenshot must have `claims.must_show`, and the preceding target assertion must use `wait_for` with `visibility: "viewport"` plus `scroll.strategy: "into_view"` when the target may be off-screen. Missing protocol for a visual claim ⇒ verdict `ISSUES`.
- [ ] **11b. Artifact contract gate** — any `TASK_ARTIFACT_CONTRACT_FAIL`, `FAIL_*`, or `MISSING:` ⇒ verdict ISSUES. The script validates `evidence-manifest.json` schema, all referenced screenshots/videos (including `videos.after`), and required recipe quality/coverage sidecars.
  ```bash
  node {{farmslot_dir}}/scripts/quality/check-task-artifact-contract.mjs {{TASK_DIR}} --require-recipe-quality-if-recipe --require-recipe-coverage-if-recipe || echo TASK_ARTIFACT_CONTRACT_FAIL
  sed '/^## Execution Checklist/,$d' {{TASK_DIR}}/TASK.md | grep -qiE 'screenshot|recording|video|visible|copy|warning|label|modal|toast' && \
    ! grep -qE '\| (visual|mixed) \|' {{TASK_DIR}}/artifacts/recipe-coverage.md && echo FAIL_VISUAL_CLASSIFICATION
  grep -qE '\| (visual|mixed) \|' {{TASK_DIR}}/artifacts/recipe-coverage.md && \
    [ "$(jq '(.before_after_pairs // []) + (.standalone // []) | length' {{TASK_DIR}}/artifacts/evidence-manifest.json 2>/dev/null || echo 0)" -eq 0 ] && echo FAIL_EMPTY
  jq -r '[.before_after_pairs[]?.before, .before_after_pairs[]?.after, .standalone[]?.file] | flatten | .[] | strings' {{TASK_DIR}}/artifacts/evidence-manifest.json 2>/dev/null | while read f; do [ -s "{{TASK_DIR}}/artifacts/$f" ] || echo "MISSING:$f"; done
  grep -R --include='artifact-manifest.json' --include='trace.json' -nE 'extension-dom-raster|macos-screencapture|Page\.captureScreenshot' {{TASK_DIR}}/artifacts && echo FAIL_INVALID_SCREENSHOT_PROVIDER
  ```

### LavaMoat policy check (step 12)

- [ ] **12. Check LavaMoat policy consistency:**
  ```bash
  git diff main...HEAD --name-only | grep -q 'lavamoat/browserify/' && echo "POLICY_CHANGED" || echo "NO_POLICY_CHANGE"
  ```
  If deps were added/changed in the diff but no policy files changed, flag it — `yarn lavamoat:auto` may be needed.
  If policy files changed, verify they correspond to actual dependency changes (not spurious regeneration).

### Write verdict (steps 13-14)

- [ ] **13. Write `{{TASK_DIR}}/artifacts/review-feedback.md`:**

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

  ## Test Quality

  - Findings: <list with file:line, or "none found">

  ## Domain Anti-Patterns

  - Findings: <list with file:line, or "none found">

  ## Mobile Comparison

  - Status: N/A | ALIGNED | DIVERGES
  - Details: <if diverges, describe with file:line — what mobile does differently and whether it matters>

  ## LavaMoat Policy

  - Status: OK | NEEDS_UPDATE | N/A
  - Details: <explanation if needs update>

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

  Every issue bullet MUST start with a parseable location:
  `- **file.ts:42** — description`. Do not wrap the location in backticks.

  - **file.ts:42** — description of the problem
  - **other.ts:10** — another issue

  (empty if verdict is PASS)
  ```

  **Verdict rules:**
  - `PASS` — no issues found.
  - `ISSUES` — any of: type errors in changed files, test failures, domain anti-pattern violations, logic bugs, missing test coverage for behavioral changes, LavaMoat policy inconsistencies, **or easy-fix nitpicks** (unused imports, missing testIDs, inconsistent naming, stale comments). If the worker can fix it in under 2 minutes, flag it — cheap quality wins add up.

- [ ] **14. Finalize** — checkbox first, then signal, in this order so the orchestrator never sees a complete signal next to an unchecked final step:
  1. Edit this file to set the checkbox above to `[x]`.
  2. Write the signal: `{{TASK_DIR}}/mark complete --mark-last`
