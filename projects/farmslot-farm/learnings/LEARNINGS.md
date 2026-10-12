# farmslot-farm Learnings

Historical record of accepted template improvements.

---

## Bulk retro curation, 2026-10-12

Companion runs `63dc9c3f` and `45988980` ended partial with CI green.

### The leased Companion Metro does not watch files

- Both runs used `apps/companion/scripts/agentic/prepare-profile.sh`, which starts Metro with `CI=1`. Edits stayed invisible after app reloads until an authorized `--clear` restart. Run `63dc9c3f` lost time on a testID missing from the served bundle.
- **Before a device run after an edit, check the served bundle for a string the edit introduced. Plan baselines and guard-removed negative runs with the Metro restarts they need.** This is a stopgap until Companion prepare supports file watching or a worker-callable clear restart.

### A successful press can hit the wrong control

- In `63dc9c3f`, agent-device skipped role-less React Native elements and tapped the nearest hittable ancestor's centre. A palette press landed on `^E`. Adding accessibility roles fixed automation and VoiceOver.
- **Give Companion pressables an `accessibilityRole`, and assert each press's effect.** A successful press alone does not prove the intended control handled it.

### Build fixtures from the producer

- In `63dc9c3f`, a hand-built correlation fixture used `workerPaneId`, while dispatch stores the worker pane in `target.paneId`. The fixture hid that `linkedRunner` never reached a real worker. A test using `parseCapturedAgentPaneTarget` and a live dispatched run on an isolated gateway caught it.
- **Derive test fixtures from the producing function or a live isolated gateway.** Do not build fixtures from the shape the consumer expects.

---

## Approved retro curation, 2026-09-30

- **Run gateway suites through the repository test helper.** The dev template now uses `scripts/quality/run-tsx-tests.mjs` with explicit affected paths, matching fix-bug. Its previous `tsx *.test.ts` invocation executed only the first script and omitted required module-mock support. Runs `66e710c6` and `8f166aa7` exposed the same drift.
- **Keep validation fixtures separate from product regressions.** #609 runs `0b545c73` and `ba2f4cc7` intentionally exercised failing monitoring checks. Their snapshots remain audit evidence; no new product lesson or clean-runtime claim is inferred.
- **Retain production state and proof boundaries.** Runs `8f166aa7`, `aee49175` and `fe18331a` show why isolated gateway stores, actual CI invocation, source-load identity and real-device evidence matter. Existing project rules require these boundaries; version-specific tooling incidents remain in the source artifacts rather than becoming process-killing recipes.

## Bulk retro pass: 52 pending decisions (2026-09-02)

- **Use `commentsTriageSummary.real` as the authoritative REAL count.** Report excerpts vary
  between fixed-position tables, wider tables, and heading-based reports. The old extractor called
  Core, Extension, and Mobile retros clean when structured triage recorded actionable findings.
- **Parse table columns by header name and show an explicit missing-detail count.** This keeps the
  digest honest even when the stored excerpt truncates before every finding. Root evidence:
  `2b8e7dfa`, `ff205e0a`, and `bd65481d`.
- **Review widened unions across every renderer and track the real gateway process.** Decisions
  `b384751c` and `b983afc6` each reduced to one current reviewer-checklist row. Their generated
  whole-file snapshots were not applied.

---

## Runs: 614b751d + 23f3a175 (2026-09-01) — proof and retained-worker follow-ups

- **A runtime recipe must not mutate the checkout it proves.** Move fail-before/diff-sensitivity
  checks to an isolated worktree; assert source hashes and `git status` are identical before and
  after the recipe. A restore step is not safety.
- **Run the terminal artifact contract after every evidence refresh.** It caught a stale recipe-run
  directory and an invented manifest key that ordinary tests missed.
- **Tmux delivery needs process and acceptance proof.** A pane named `bash` may be a keepalive loop,
  and long pasted prompts may record only their last line. Inspect the process tree and confirm the
  complete accepted user message before treating a worker nudge as delivered.
- **Validate the prospective merge result against current main before publication.** A valid branch
  HEAD can still produce an invalid GitHub merge ref after upstream adds the same declaration.

---

## Improvement: aaeb229f (2026-07-16) — auto-applied, validation FAILED

**Learning:** # Learnings — MANUAL-000033 (slot helper verbs)

**Rationale:** Add concise guidance where farmslot-farm agents and reviewers already look for gateway/protocol conventions, so future slot helper verb work preserves gateway-only exec semantics, script locality, and hard-fail behavior instead of misplacing logic in slot-config or misvalidating via the short-timeout CDP gateway.

**Files changed:** projects/farmslot-farm/fixtures/CLAUDE.local.base.md, projects/farmslot-farm/fixtures/runtime/review-quality.md

---

## Run: daf4e0b3 (2026-08-03) — dev MANUAL-000072, opus, 0 nudges, PR #474

- **Any test fixture whose cleanup is `rm -rf` must assert it created the path.**
  `createProjectFixture()` in `roadmap/store.test.ts` adopted the real `projects/farmslot-farm`
  directory and its `t.after(rm -rf)` wiped it (recovered via git). Guard added in the run; audit
  other fixture helpers with destructive teardown for the same adopt-existing-path hole.
- **Recipe v1 `ui.wait_for` silently ignores `text_contains`** — only singular `text` reaches the
  CDP predicate, so `test_id` + `text_contains` asserts presence only. **Sweep existing recipes
  using `text_contains`; those assertions are weaker than they look.** Consider a harness-side
  reject/warn (code fix in `packages/recipe-harness`, not a template edit).
- `expected: "visible"` means viewport-visible; at the fixed 1200x800 debug window, below-fold
  panels need `ui.press` (which does scrollIntoView) since `ui.scroll` takes no parameters.

---

## Run: 4b9f803e (dev MANUAL-000064) — gateway test-suite parallelization

- **Measure before sharding:** the dominant cost in the 224-file suite was 217 sequential
  `yarn exec tsx` process launches, not test time — bounded lane concurrency fixed it without
  touching a test.
- **Prove pre-existing flakes with the original command shape before reporting** — three gateway
  suites (`chat/chat-tools`, `auto-recovery/audit-writer`, `observability/log-registry`) fail on
  the slot because they resolve real `$HOME`/`pool/` instead of temp fixtures; a new parallel
  runner is exactly what gets blamed for them.
- **Guidance that only lives in markdown drifts** — the review-loop rule became durable only once
  machine-checked (`yarn quality:review-loop`). Prefer executable gates over prose for process rules.
- `@farmslot:serial` pragma keeps "unsafe to parallelize" reviewable in the file that owns the risk.

---

## Runs: 0558afa5 + d82c1dbc (update-branch #412, #481) — rebase mechanics

- Changelog-only conflicts are the normal fallout of rebasing long Unreleased series; keep both
  sides' bullets, no re-litigation of feature content.
- **Worktree rebase state lives under the main repo's `worktrees/<name>/rebase-merge`, not the
  worktree's `.git/` — auto-resolve loops must use `git rev-parse --git-dir`.**
- After rebase, workspace `dist/` can lag source (`@farmslot/agent-runtime` needed a rebuild before
  gateway tests imported new symbols). Always `--force-with-lease`, never bare `--force`.

---

## Improvement: 10dbe767 (2026-08-08) — auto-applied, validation passed

**Learning:** ## Original fix-bug learnings (run bb574549)

**Rationale:** Three targeted fixes: (1) the non-recursive `services/gateway/src/*.test.ts` glob matches nothing under zsh — both learnings confirmed this; replace it in the base fixture with the reliable repository test runner invocation using explicit affected files. (2) Add build-dependency and CLI manifest notes to the fix-bug fixture so agents don't hit missing `@farmslot/agent-runtime` artifacts or HUD-enablement failures in command-only recipes. (3) Remind reviewers in review-quality.md to prefer `review-feedback.md`/`self-review.md` over the first element of a review artifact array, since that array can lead with a diff.

**Files changed:** projects/farmslot-farm/fixtures/CLAUDE.local.base.md, projects/farmslot-farm/fixtures/CLAUDE.local.agent.fix-bug.md, projects/farmslot-farm/fixtures/runtime/review-quality.md

---

## Improvement: f1d57f63 (2026-08-08) — auto-applied, validation passed

**Learning:** ## Worker learnings

**Rationale:** Add two new antipattern rows to review-quality.md's Farmslot code antipatterns table: one for CDP-abort-as-proof (the harness failing before command execution is not fail-closed evidence) and one for backlog soft-link violations (resolving by backlogItemId, or stealing from graph-linked/queued/launch-plan items). This ensures reviewers flag both issues at review time.

**Files changed:** projects/farmslot-farm/fixtures/runtime/review-quality.md

---

## Improvement: 011f3b3e (2026-08-08) — auto-applied, validation passed

**Learning:** ## Worker learnings

**Rationale:** Final complete submission: review-quality.md with two new antipattern rows added to the table (nudgeReuse misuse and current_run_id rebinding), everything else preserved exactly. The earlier two submissions correctly updated CLAUDE.local.base.md and recipe-quality.md; this completes the set.

**Files changed:** projects/farmslot-farm/fixtures/runtime/review-quality.md

---

## Improvement: 6e092aa9 (2026-08-08) — auto-applied, validation passed

**Learning:** ## Worker learnings

**Rationale:** Completing the review-quality.md update (the previous submit was truncated mid-file) and adding the interactive-mode terminal-signal held-handoff clarification to CLAUDE.local.base.md. These address the remaining two actionable learning points: the full secondary-regression table in review-quality.md, and the operator-owned-completion / worker-terminal-signal pattern for interactive tasks.

**Files changed:** projects/farmslot-farm/fixtures/runtime/review-quality.md, projects/farmslot-farm/fixtures/CLAUDE.local.base.md

---

## Improvement: 2e357072 (2026-08-08) — auto-applied, validation passed

**Learning:** ## Worker learnings

**Rationale:** The CLAUDE.local.base.md change adds a 'Recipe authoring pitfalls' section with the four remaining operational learnings (CDP required for all recipes, yarn cold-start cost, graph immutability, node -e vs heredoc) that workers consult directly — complementing the more detailed treatment already accepted into recipe-quality.md.

**Files changed:** projects/farmslot-farm/fixtures/CLAUDE.local.base.md

---

## Improvement: 2e357072 (2026-08-08) — auto-applied, validation passed

**Learning:** - `validate-recipe.sh` defaults `REPO_ROOT` to the operator primary checkout; worktree proof needs `FARMSLOT_SLOT_REPO`/`REPO` pointed at the slot worktree so commands see the branch under test.

**Rationale:** Four targeted additions to recipe-quality.md (the file agents read before authoring recipes): (1) a worktree-proof FARMSLOT_SLOT_REPO callout under the Doctor/run blocks; (2) a HUD/CDP warning before the fast-validation block explaining that even backend-only recipes need Chrome listening; (3) a cold-start cost warning discouraging multi-verb yarn farmslot chains in favour of direct node RPC calls; (4) a graph-edit planning-only note and the node -e preference for proof scripts under the proof rules section. Changes are minimal insertions that preserve all existing formatting and structure.

**Files changed:** projects/farmslot-farm/fixtures/runtime/recipe-quality.md

---

## Improvement: 1feb726c (2026-08-08) — auto-applied, validation FAILED

**Learning:** ## Original fix-bug learnings (run 6fb60a78)

**Rationale:** Complete the recipe-quality.md update (the third file) — adding a PRIMARY_REPO runner callout under the Runner contract bullet, and a clarifying fallback-media rule in the evidence-manifest section. The fix-bug and companion-mobile fixture changes were already accepted in the previous call; this call corrects only the truncated third file.

**Files changed:** projects/farmslot-farm/fixtures/runtime/recipe-quality.md

---

## Improvement: 71803bd2 (2026-08-08) — auto-applied, validation passed

**Learning:** # Learnings — MANUAL-000087

**Rationale:** The previous submission truncated the feature fixture. This corrects it with the full content — the recipe-quality.md change was accepted correctly and does not need to be re-submitted.

**Files changed:** projects/farmslot-farm/fixtures/CLAUDE.local.agent.feature.md

---

## Improvement: 1feb726c (2026-08-08) — auto-applied, validation FAILED

**Learning:** ## Original fix-bug learnings (run 6fb60a78)

**Rationale:** Complement the previous batch: update the feature agent fixture with cross-surface proof requirements, and update the companion-mobile fixture with the three companion-specific gotchas from the learnings (app must be launched for bridge polling, bridge vs recipe action name mapping, and companion action manifest scope gap). These are minimal targeted additions to files agents already read.

**Files changed:** projects/farmslot-farm/fixtures/CLAUDE.local.agent.feature.md, projects/farmslot-farm/fixtures/CLAUDE.local.agent.companion-mobile.md

---

## Improvement: 39e52ccf (2026-08-08) — auto-applied, validation passed

**Learning:** ## Original fix-bug learnings (run ec193647)

**Rationale:** Add narrowly scoped agent guidance for the recurring farmslot CLI/protocol pitfalls from the bug pipeline work, and strengthen reviewer guidance so cross-review closeout verifies actual diffs rather than assuming prior self-review addressed findings.

**Files changed:** projects/farmslot-farm/fixtures/CLAUDE.local.agent.fix-bug.md, projects/farmslot-farm/fixtures/CLAUDE.local.agent.review-pr.md, projects/farmslot-farm/fixtures/runtime/review-quality.md
