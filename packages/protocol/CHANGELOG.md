# Changelog

All notable changes to `@farmslot/protocol` are tracked here.

## Unreleased

- feat(runs): add optional `ImprovementDiffPayload.analysisAttempts` so startup recovery can bound crash-loop retries of interrupted improvement analyses.
- feat(review): add repeat-review generation context, independent incremental/full scope, and static/full-live validation depth to run and dispatch contracts.
- feat(review): expose one shared review-chain projection with explicit reviewer-session resume, reset, and safe-fallback provenance.
- feat(agents): add the optional `reviewResultFile` path used for authoritative structured results by newly launched self-review and publication reviewers.
- feat(terminal): add the terminal image-attachment contract — chunked upload params, separate delivery result with an explicit `unsupported` status, size/MIME limits, and cleanup scopes.

- Active-development baseline; add user-facing changes here before release or package publication.

## 0.19.0 - 2026-08-06

- fix(git): expose the current `HEAD` SHA in `git.status` so clients can invalidate committed diff caches after same-ahead rebases and rewritten commits
- fix(publication): bind review snapshots to explicit untracked file paths, Git modes, and blob identities, including empty files and dangling symlinks that produce no Git patch
- fix(publication): carry the exact reviewed diff identity and PR base through ready-gate packages so clients and publish policy can reject stale reviews
- feat(publication): ready-gate payload soft fields `behindMain`, `mergeConflicts`, `mergeConflictPaths`, and `branchFreshnessHint` for early branch-staleness chips (not a hard fail)
- fix(run): independent review state records when restart recovery explicitly owes a worker fix/re-review continuation, and reviewer contexts retain the loop that owns their launch snapshot
- fix(runs): expose structured publication-review launch rejections in ready-gate payloads and persisted publish-gate state alongside the recoverable gate description

## 0.18.0 - 2026-08-03

- feat(run): `failedRunCancelEffects` — the single filter every human-facing cancel caller uses to detect a partially applied cancel.
- feat(git): worktree-target branch-diff files carry a `committed` flag — committed-vs-purely-local is knowable per file.
- feat(git): `target: 'worktree'` on `git.diff` / `git.branchDiff` — diff the merge-base against the working tree (every branch change, committed or not).
- feat(work-graph): `isSchedulerAuthoritativeGraph` / `SCHEDULER_AUTHORITATIVE_GRAPH_STATUSES` — one definition of which graph statuses the scheduler acts on (`active` and `waiting`), shared by the scheduler and the planning-context projection so a `waiting` graph's required edges are never described as advisory.
- feat(roadmap): `RoadmapDeliveryRunRef.archivedOnly` marks families whose runs are all archived, so clients render historical evidence without offering navigation that dead-ends.
- feat(recipe): add the opt-in `ui.capture_surface` action for full-page and full-scroll-surface evidence while keeping `ui.screenshot` viewport-only.
- feat(visual-review): define portable source and self-contained feedback documents for hierarchical full-surface or explicit viewport captures, typed multi-path navigation edges, and normalized color-coded point and area annotations.

## 0.17.0 - 2026-08-03

- feat(roadmap): shared `RoadmapDeliveryProjection` contract (`unstarted|active|partial|delivered|inconsistent`) with per-backlog lineage, run-family and PR evidence, consistency findings, and a `summarizeRoadmapDelivery` aggregate for list badges.
- feat(roadmap): `PlanningContextProjection` with typed relation labels (`depends-on`, `blocks`, `supersedes`, `absorbs`, `composes-with`, `follow-up`, `parent-roadmap`, `promoted-sibling`), scheduler-authority flags, and a content snapshot hash.
- feat(roadmap): optional additive `delivery` on `roadmap.list` and `delivery`/`planningContext` on `roadmap.get`.
- feat(github): `parseGitHubPullUrl` — the single PR-URL parser, so clients render `repo#number` without re-parsing persisted run links.
- feat(backlog): typed `backlog.refine` / `backlog.refinementSession.get` RPC contracts and default refinement runner/model constants.
- feat(checklist): shared `enumerateChecklistCheckboxes` + `CHECKLIST_SKIP_SECTIONS` — the single definition of which markdown checkboxes are checklist steps.

## 0.16.0 - 2026-08-02

- **BREAKING:** Replace the unused `ui.gesture` vocabulary with typed `ui.swipe`, `ui.pan`, `ui.drag`, and `ui.long_press` actions, including snake-case `hold_ms`, strict duration/path/direction validation, and manifest-owned adapter-specific parameter limits before and after template resolution. Publish `@farmslot/protocol`, then `@farmslot/recipe-harness`, then `@farmslot/expo-recipe`.

## 0.15.0 - 2026-08-01

- **BREAKING:** Recipe artifact-package validation requires structured run totals and all four failure-cause counts in `summary.json`; publish `@farmslot/protocol` first, then `@farmslot/recipe-harness`, before updating CLI, agent-runtime, and Gateway consumers as one coordinated release.
- feat(recipe): publish fail-closed suite scope/result contracts and reconcile trace failure causes with run summaries.
- fix(protocol): declare the optional worker `needsSelfReview` signal already emitted by the agent runtime so remote update-branch review skips remain type-safe on clean builds.
- fix(agents): expose the canonical primary `worker` tmux session anchor separately from disposable role windows, and recognize legacy `review-fix[-N]` reviewer windows for lifecycle cleanup.
- fix(work-graph): persist scheduler authorization on nodes so historical reconciliation cannot suppress prerequisite-regression alarms for scheduled work.
- feat(backlog): add the typed `backlog.reconcileRun` repair action for existing run/backlog handoffs.
- fix(protocol): expose checklist-scoped terminal contract paths and persist each agent context's artifact scope for restart-safe independent review recovery.
- feat(protocol): `RunEngineState.flags.warmSessionReuse` for CI-watch chained follow-ups that hand off into a parent worker kept warm through finalize (MANUAL-000065).
- fix(runners): update the shared Grok default to the installed CLI's `grok-4.5` model so launches do not silently fall back from retired `grok-build`.
- feat(runners): export `DEFAULT_CODEX_MODEL` (`gpt-5.6-sol`), `DEFAULT_CODEX_EFFORT` / `DEFAULT_GROK_EFFORT` (`xhigh`), and bump the roadmap refinement default model to Sol so dispatch/UI/gateway share one catalog.
- `ProviderAccountsSnapshotParams.forceRefresh` — wait for a live probe instead of accepting the gateway's cached snapshot (additive; default stays cache-first).
- Export canonical roadmap project sentinels and shared concrete/unscoped predicates so clients and the gateway use the same scoping rules.
- Add the authenticated `gateway.ping` liveness contract for cheap client health checks.
- feat(protocol): `QueueItem` claim fields (`claimHolder`, `claimEpoch`, `claimExpiresAt`) and `QueueClaim` token type for exclusive dispatch-queue ownership (MANUAL-000053).
- `Run` declares `prState` and `mergedAt`. Work-graph `merged` edges gate on merge state read off the run, but `Run` declared no such field — the graph code cast the run to a shape that did not exist, so the condition read `undefined` and no `merged` edge could ever be satisfied.
- feat: provider subscription contracts and `providerAccounts.snapshot` RPC (per-machine runner seats: label, CodexBar/native identity/quota mirrors — never tokens or auth paths); optional `RunMetrics.providerAccountLabel` and dispatch `providerAccountLabel` for label-only attribution after bind/failover.
- **BREAKING:** `exec` accepts an `argv` array alongside `cmd`, and `fs.*` takes `{root, relPath}` instead of a pre-joined absolute path. Argv carries arguments as data rather than shell text, so no caller value is ever re-parsed by a shell; the split path lets the node confine every filesystem operation under a declared root and refuse `.git` server-side. Bounded remote artifact reads collapse `realpath`/`stat`/`readBase64` into one call with a byte ceiling.

## 0.14.0 - 2026-07-27

- **BREAKING:** carry optional execution-template descriptions, keep catalog options effective-only (removing unused `shadowedBy`), and let `config.templatePreview` identify an exact source-backed template

## 0.13.0 - 2026-07-26

- Add portable execution-template selection and provenance contracts.

## 0.12.0 - 2026-07-24

- Describe every Recipe v1 field for editor hover and completion help.
- **BREAKING:** Replace duplicated action-manifest lists with one strict keyed `actions` allowlist and direct copyable node examples.
- Publish the Action Manifest v1 JSON Schema for editor validation.
- Keep manifest examples, result cases, and transitions identical across runtime and JSON Schema validation.
- Reject retained traces whose node actions, intents, or artifact attribution no longer match the retained recipe and manifest.
- Reject explicit nulls and remove the ignored `requireSchemaRef` option.

## 0.11.1 - 2026-07-23

- Fix browser consumers by replacing Node-only recipe digest and parameter helpers.

## 0.11.0 - 2026-07-22

- **BREAKING:** Recipe v1 now exposes only actions and parameterized composable recipes. Root `paramsSchema`, static recipe calls, and exact digest-keyed dependency evidence replace the separate reusable graph type.
- Validate nested defaults/schema keywords and derive dependency artifact paths from canonical digests.

- feat: `DispatchCandidate.ineligibleReason` — optional dispatch-validation failure reason for candidate rows.

## 0.10.0 - 2026-07-19

- feat: add recipe provenance, execution-capability, exact-plan approval, and stable trust-failure contracts
- fix: bind recipe approvals to the project root, artifact destination, and effective run environment
- fix: reject parameter-templated flow references that cannot be represented in a static execution plan
- feat: `CICheck.status` and `PRStatus.checkSummary` gain `skipped` — watched-check surfaces distinguish path-skipped CI jobs from pending ones. `CiCheckSummary.skipped` is optional (absent in run outputs persisted before skipped tracking).
- feat: `SLOT_LIFECYCLE` — canonical `SlotLifecycle` value constants for runtime logic (companion to the type union; string literals drift silently)
- feat: `SlotReleaseParams.expectedRunId` — optional owner binding for slot release: when set, the teardown proceeds only while that run still holds the slot's claim, so a release initiated for one run can never destroy a rival run's fresh claim (additive; absent means the pre-existing unbound behavior)
- feat: `AgentContext.attemptStartedAt` — launch time of the current attempt/pass, so restart recovery can tell a current-attempt signal from a prior loop's (startedAt survives warm reuse; updatedAt is rewritten by startup reconciliation)
- feat: `TmuxWorkerAttentionReason` gains `'observability-degraded'` — surfaced when hook/statusline liveness lapses for an event-driven runner while the ADR-032 Phase 3A pane-retirement flag is on, so the operator is alerted before a nudge is attempted (additive; older readers ignore the new reason)
- feat: `ReviewSessionPolicy` (`'fresh-per-pass' | 'warm-per-reviewer'`), `REVIEW_SESSION_POLICIES`, and `DEFAULT_REVIEW_SESSION_POLICY` — reviewer session lifecycle across one run's review loops (MANUAL-000009), shared by the gateway and `@farmslot/slot-config`
- feat: `ReviewSummary.independentReviews[]` rows gain optional `source` and `runner` so gate-summary surfaces can render _Independent review (requested)_ and `runner: <id>` policy metadata (additive; older persisted summaries simply omit them); review-loop JSDoc comments use independent-review language
- feat: launch-plan attempt fields for MANUAL-000037 — `QueueItem.launchAttempt`, `Run.launchAttempt`, `RunCreateParams.launchAttempt`, and `BacklogLaunchCandidateProjection.attempt`: a monotonic per-candidate attempt so backlog run observations can tell a legitimate re-enqueue takeover from a stale echo of a superseded run
- feat: `BacklogItem.multiPr` (+ create/update inputs) — marks items whose acceptance criteria span multiple PRs so a finished run returns them to `ready` instead of auto-closing them; final closure stays the explicit `backlog.closeShipped` call
- feat: `contracts/bug-score.ts` — decision cores for the LLM grade / validity / batch stages of the bug pipeline, ported from `grade-bug.sh`, `validate-bug.sh`, and the `batch-triage.sh` GitHub post-filter: `normalizeLlmGrade` + `computeFinalScore` (LLM grade validation and the deterministic heuristic/LLM final-score merge), `normalizeBugValidation` (validity-check defaults), `parseLlmJson` (fence-stripping JSON parse), and `filterBatchIssues` (since/exclude-assigned filter), plus the `LlmGrade`/`FinalScore`/`BugValidation`/`LlmComplexity`/`FinalScoreSource` types and `LLM_COMPLEXITIES`/`FINAL_SCORE_SOURCES` constants. Companion to `contracts/bug-input.ts`; both back the new `farmslot bug` CLI command family
- `computeFinalScore` rounds the merged one-shot probability half-to-even to approximate the retired Python grader's `round(x, 2)`, but does not bit-match it on binary near-ties: `final.one_shot_probability` may differ by 0.01 from the old Python output on values like `0.015` (JS rounds to `0.02`, Python to `0.01`). Deliberate — bit-parity would need arbitrary-precision decimals for a cosmetic delta
- feat: `contracts/bug-input.ts` — `scoreKeyForGithub` / `scoreKeyForJira` expose the score-file key rules (`gh-<n>` / lowercased Jira key) that `deriveScoreKey` now delegates to, so the batch/skip-existing fast paths derive a key from a raw ref without duplicating the rules
- feat: slot helper RPCs — `Methods.SLOT_MONITOR`/`SLOT_SHOW`/`SLOT_SOFT_REFRESH`/`SLOT_REOPEN`/`SLOT_AUTO_REFRESH` (+ matching `SlotMethods` entries) and their params/results (`SlotMonitorParams`/`Result`, `SlotShowParams`, `SlotSoftRefreshParams`, `SlotReopenParams`, `SlotCommandResult` extending `ExecResult`, `SlotAutoRefreshParams`/`Result`) for the ported slot helper CLI verbs
- **BREAKING** feat: rename the branch-maintenance flow `merge-main` → `update-branch` in `FlowType`. Adds load-boundary migrations `normalizeFlowType` (`merge-main`→`update-branch`, `feature`→`dev`) and `normalizeCiActionId` (`dispatch-merge-main`→`dispatch-update-branch`), the `BranchUpdateStrategy` type + `BRANCH_UPDATE_STRATEGIES`/`isBranchUpdateStrategy`, and `Run.branchUpdateStrategy`/`RunCreateParams.branchUpdateStrategy`. `update-branch` is PR-bound; its worker report artifact is `report.md`

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
- feat: add `missing_required_resources` as a slot-picker reason when dispatch waits for a resource-capable slot.
- feat: add optional app/prepare-profile hints to dispatch candidate requests so resource-gated nudge rows match dispatch preview.
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
