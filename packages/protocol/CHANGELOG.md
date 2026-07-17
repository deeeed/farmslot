# Changelog

## Unreleased

- feat: `TmuxWorkerAttentionReason` gains `'observability-degraded'` — surfaced when hook/statusline liveness lapses for an event-driven runner while the ADR-032 Phase 3A pane-retirement flag is on, so the operator is alerted before a nudge is attempted (additive; older readers ignore the new reason).

- feat: `ReviewSessionPolicy` (`'fresh-per-pass' | 'warm-per-reviewer'`), `REVIEW_SESSION_POLICIES`, and `DEFAULT_REVIEW_SESSION_POLICY` — reviewer session lifecycle across one run's review loops (MANUAL-000009), shared by the gateway and `@farmslot/slot-config`.

- chore: comment-only sweep — code comments describe rationale inline instead of citing ticket numbers (no behavior change).

- feat: `ReviewSummary.independentReviews[]` rows gain optional `source` and `runner` so gate-summary surfaces can render _Independent review (requested)_ and `runner: <id>` policy metadata (additive; older persisted summaries simply omit them); review-loop JSDoc comments use independent-review language.

- feat: launch-plan attempt fields for MANUAL-000037 — `QueueItem.launchAttempt`, `Run.launchAttempt`, `RunCreateParams.launchAttempt`, and `BacklogLaunchCandidateProjection.attempt`: a monotonic per-candidate attempt so backlog run observations can tell a legitimate re-enqueue takeover from a stale echo of a superseded run.

- feat: `BacklogItem.multiPr` (+ create/update inputs) — marks items whose acceptance criteria span multiple PRs so a finished run returns them to `ready` instead of auto-closing them; final closure stays the explicit `backlog.closeShipped` call.
- feat: `CICheck.status` and `PRStatus.checkSummary` gain `skipped` — watched-check surfaces distinguish path-skipped CI jobs from pending ones. `CiCheckSummary.skipped` is optional (absent in run outputs persisted before skipped tracking).
- feat: `contracts/bug-score.ts` — decision cores for the LLM grade / validity / batch stages of the bug pipeline, ported from `grade-bug.sh`, `validate-bug.sh`, and the `batch-triage.sh` GitHub post-filter: `normalizeLlmGrade` + `computeFinalScore` (LLM grade validation and the deterministic heuristic/LLM final-score merge), `normalizeBugValidation` (validity-check defaults), `parseLlmJson` (fence-stripping JSON parse), and `filterBatchIssues` (since/exclude-assigned filter), plus the `LlmGrade`/`FinalScore`/`BugValidation`/`LlmComplexity`/`FinalScoreSource` types and `LLM_COMPLEXITIES`/`FINAL_SCORE_SOURCES` constants. Companion to `contracts/bug-input.ts`; both back the new `farmslot bug` CLI command family.
  - `computeFinalScore` rounds the merged one-shot probability half-to-even to approximate the retired Python grader's `round(x, 2)`, but does not bit-match it on binary near-ties: `final.one_shot_probability` may differ by 0.01 from the old Python output on values like `0.015` (JS rounds to `0.02`, Python to `0.01`). Deliberate — bit-parity would need arbitrary-precision decimals for a cosmetic delta.
- feat: `contracts/bug-input.ts` — `scoreKeyForGithub` / `scoreKeyForJira` expose the score-file key rules (`gh-<n>` / lowercased Jira key) that `deriveScoreKey` now delegates to, so the batch/skip-existing fast paths derive a key from a raw ref without duplicating the rules.
- feat: slot helper RPCs — `Methods.SLOT_MONITOR`/`SLOT_SHOW`/`SLOT_SOFT_REFRESH`/`SLOT_REOPEN`/`SLOT_AUTO_REFRESH` (+ matching `SlotMethods` entries) and their params/results (`SlotMonitorParams`/`Result`, `SlotShowParams`, `SlotSoftRefreshParams`, `SlotReopenParams`, `SlotCommandResult` extending `ExecResult`, `SlotAutoRefreshParams`/`Result`) for the ported slot helper CLI verbs.
- **BREAKING** feat: rename the branch-maintenance flow `merge-main` → `update-branch` in `FlowType`. Adds load-boundary migrations `normalizeFlowType` (`merge-main`→`update-branch`, `feature`→`dev`) and `normalizeCiActionId` (`dispatch-merge-main`→`dispatch-update-branch`), the `BranchUpdateStrategy` type + `BRANCH_UPDATE_STRATEGIES`/`isBranchUpdateStrategy`, and `Run.branchUpdateStrategy`/`RunCreateParams.branchUpdateStrategy`. `update-branch` is PR-bound; its worker report artifact is `report.md`.
- docs: slot-selection comments reference the retired find-slot.sh script (comment-only; no behavior change).

- Active-development baseline; add user-facing changes here before release or package publication.

## 0.9.0 - 2026-07-13

- feat: `contracts/pr-recommendation.ts` (`computePRRecommendation`, `derivePRMergeState`, `isPassiveMergeWaitCandidate` moved from the gateway, now covering the bash pr-monitor rule set) and `contracts/bug-input.ts` (`BugInput`, `parseBugInput` for GitHub/Jira incl. ADF flattening + shared image-URL extraction, `validateBugScore`)
- feat: `contracts/runner-ids.ts` — canonical runner-id vocabulary (`DEFAULT_RUNNER`, `RUNNER_ALIASES`, `normalizeRunner`) moved from the gateway runner registry so slot-config template expansion shares it; the registry re-exports
- feat: `contracts/slot-selection.ts` — operator slot availability + selection core (`selectSlot` over the fleet snapshot — stale-refusing, with discriminated failure codes —, `slotUnavailableReason`, `explicitSlotBlocker`, `slotSelectionScore`, `cdpLive`/`isCdpLiveValue`), the TypeScript port of the `scripts/find-slot.sh` decision logic; `isCdpLiveValue` is shared with the gateway dispatch scorer
- feat: `backlog.closeShipped` method + `BacklogItem.shipped` provenance field
- feat: RPC response errors may carry `userAction` and `details`; `SlotStatus.missingFromPool` and `FleetStatus.stale` flag ghost slots and stale fleet snapshots

## 0.8.0 - 2026-07-12

- feat: add Recipe Protocol v1 passive UI observation fields to manifests, recipes, and schemas.
- feat: add reviewer context protocol types and exports for slot reviewer panes.
- feat: add tmux runtime recovery RPC contracts for reconciling and restoring worker sessions.
- feat: add `WorkGraphSchedulerTickParams.forceEnqueue` for operator manual-enqueue of a work-graph node even when its backlog item has autoDispatch disabled.
- refactor: remove the unused `slot.prepare.output` event (`SLOT_PREPARE_OUTPUT`) — raw prepare output rides `script.output`. Add `ARCHIVABLE_BACKLOG_STATUSES` as the shared source of truth for backlog archive gating, and backlog archive/delete/restore RPC types.
- docs: note `grok-4.5-fast-xhigh` as a Cursor Agent model example on `SlotStatus.model`.

## 0.7.6 - 2026-07-09

- feat: publish the canonical Recipe Protocol v1 JSON Schema (`schemas/recipe-v1.schema.json`, exported via `./schemas/*`) and validate a `recipe.$schema` URL contract in `validateRecipeDocument` (`RECIPE_PROTOCOL_SCHEMA_URL`, `recipeProtocolSchemaUrlForVersion`; `$schema` must match `schema_version` when present, or is required under opt-in `requireSchemaRef`). The published schema matches the validator (`schema_version`/`validate` required, `flows` allowed, `additionalProperties`)
- feat: `validateRecipeArtifactPackage` takes `resolvedRecipe` (the fully-composed `resolved-recipe.json`) and `runPassed`. For a passing run the composition must be proven: `resolvedRecipe`, when present, is validated in full and `recipe` is then checked envelope-only; otherwise `recipe` is validated in full — and because `uses` catalogs are not in the package, a `uses`/library composition with no `resolved-recipe.json` is rejected. `validateFlowCalls` gains `skipResolution` (skip `unresolved_call_ref` only; call-shape checks always run) and `externalCatalogsResolvable`. A failed run keeps `recipe` envelope-only and skips `resolvedRecipe`, so a graceful failure is not turned into a rejection

## 0.7.5 - 2026-07-08

- feat: export `DEFAULT_GATEWAY_TLS_PORT` (7778) — the shared default port the gateway serves `wss://` on when TLS is configured, so the gateway daemon and CLI reference one source of truth instead of duplicating the literal

## 0.7.4 - 2026-07-06

- Add `@farmslot/protocol/checklist-target` as the canonical checklist filename registry (worker, self-review, ci-fix) with signal derivation, nested-loop progress filtering, and UI progress label helpers; optional `ChecklistTargetRegistry` supports dynamic overrides.

## 0.7.3 - 2026-07-06
