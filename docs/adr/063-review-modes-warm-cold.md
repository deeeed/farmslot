# ADR-063: Review modes WARM and COLD

**Status:** Accepted
**Date:** 2026-10-11
**Owner:** Farmslot maintainers
**Scope:** Review sessions, publication gates, dispatch configuration, and shared web/mobile pickers
**Related:** [ADR-038](038-gate-held-worker-session.md), [ADR-057](057-structured-runner-transports.md), [ADR-058](058-static-review-and-farm-owned-qa.md), [ADR-061](061-structured-assessment-providers.md)
**Supersedes:** ADR-038's publication-review classification and runner-diversity requirement in lifecycle contract item 2, and ADR-058's implicit fresh-session fallback for review continuation. Worker lifecycle and farm-owned QA remain in effect.

## Context

ADR-038 ties review eligibility to whether a reviewer uses the worker's runner.
That distinction has spread into gate actions, review counts, dispatch plans,
artifacts and picker labels. Separate session and scope settings also permit
contradictory requests. Picker implementations differ between gate, dispatch,
backlog and PR screens, and between web and mobile.

This record defines one review contract and one configurable picker. Acceptance
authorizes implementation; it does not claim that the behavior has shipped.

## Decision

Any review running in its own separate session is independent by definition.
Choosing a different runner is just the runner choice. No policy, gate or
dispatch rule may check, require, count or label runner diversity. The only
review dimensions are **runner, model, effort and mode**, where mode is
`warm | cold`. Any supported runner, model and effort may review; comparing
them with the worker's choices never changes review eligibility.

| Mode | Session                                                     | Reviewed range                                            |
| ---- | ----------------------------------------------------------- | --------------------------------------------------------- |
| WARM | Reuse the previous review session of the same repository/PR | Last reviewed head to the current head                    |
| COLD | Create a fresh review session                               | The whole PR diff, using a captured base and current head |

The picker defaults to COLD without a retained review; an explicit WARM request
without one is refused. WARM requires a verified retained reviewer session and
its last reviewed head, scoped to that PR rather than the current run ID or
worker runner. A missing, foreign, busy or incompatible session never silently
turns WARM into COLD. Show the reason and let the operator wait or choose COLD.
Model/effort changes follow the runner's session capabilities. Those are
transport constraints, not diversity policy. COLD creates a new session;
clearing a retained session is not COLD.

Each review has a durable `reviewId` lineage, bound to repository/PR, its native
reviewer session and last reviewed head. The WARM key is repository/PR plus
`reviewId`. A sequence row's request context identifies which lineage it
continues; the selected runner does not choose it. Missing or ambiguous lineage
is refused. A recheck updates that lineage's result. Lineage and session IDs are
provenance, not a fifth picker dimension.

Publication may require passing reviews, but counts depend on valid separate
review sessions and exact-head results, never distinct runners. A pipeline
review in its own session qualifies like a gate-requested review. Worker fixes
are work, not reviews. Rechecking one review after fixes updates its result;
it does not manufacture another required reviewer.

Use one review-and-dispatch picker with one `ReviewDispatchViewModel` in the
shared package `@farmslot/review-dispatch`. It owns selection, defaults, catalog
choices, validation, sequence-row changes and payload construction. Preserve
custom model IDs and saved model preferences rather than narrowing them to a
static model list. Command
Center and Companion each provide one thin platform renderer. Call context
supplies allowed actions, defaults and whether a sequence is allowed. Callers
must not copy picker state, validation or normalization.

Every review or dispatch configuration uses that picker, including gate
requests, the dispatch wizard, backlog options and PR execution. Effort is
always visible next to model; a capability that cannot vary effort shows its
supported default explicitly. All review rows also expose WARM/COLD. Resource,
publication and QA controls remain host concerns; QA remains separate from
static review under ADR-058.

The [normative contract](../reference/review-modes-warm-cold.md) defines request validation and wire consumers.

## Public surface

- **CLI:** keep `--runner`, `--model` and `--effort`; add
  `--review-mode <warm|cold>` and `--review-sequence <json>` to review/dispatch
  entry points. Existing `--mode` continues to select the run workflow, not
  review mode. Gate requests use `request-review`. Remove old review-session
  and review-scope choices and their help/output labels, without aliases.
- **SDK and protocol:** introduce `ReviewMode`, `ReviewSelection` and ordered
  `ReviewSequence`. Each selection carries `{runner, model, effort, mode}`;
  effort may explicitly select the runner default. Use the same types for
  run creation, PR options, gate requests, backlog and dispatch queues.
  Replace `ReviewSessionPolicy`/`ReviewSessionIntent` and public `ReviewScope`
  choices with mode. Rename `IndependentReviewStatus`/`IndependentReviewAttempt`
  to `ReviewStatus`/`ReviewAttempt`, and `ReviewDepthPolicy` to `ReviewPolicy`.
  Remove `crossRunner`, `requireCrossRunner`, `require_cross_runner`, the
  `same` runner sentinel and runner-relative defaults. Rename review-count and
  sequence fields to `minimumReviews` and `reviewSequence`, including project
  configuration's `minimum_reviews`; rename `independentReviews` to `reviews`.
  Project `review.mode` replaces `self_review.session_policy` as the configured
  default; removed configuration keys must be rejected with a conversion hint.
  Keep head/session/receipt provenance distinct from choices. Server and SDK
  request validation use the shared package's validators too.
- **Gate actions:** replace `request-cross-runner-review` and
  `request-extra-review` with `request-review`, carrying
  `{runner, model, effort, mode}`. A sequence-capable request may include
  `sequence` containing the remaining ordered selections; the shared serializer
  combines the first selection and these rows into one `ReviewSequence` and one
  request receipt. There is no separate loop schema or diversity flag.
- **Dispatch options:** store `reviewSequence` using that same row model for
  immediate dispatch, backlog creation/editing and queued dispatch. The shared
  view-model and validation preserve runner/model/effort/mode through every
  transition. Platform wrappers select context, render and invoke the action.

### Existing duplicates to replace

These locations are anchored to implementation base `b90485650`. Delete the
listed duplicate components, types and selection functions in the single
implementation PR, then move every caller to the shared picker. In mixed-purpose
files, delete the selection implementation and retain unrelated host behavior.

| Current location, file:line                                                                                                                            | Duplicate replaced                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `apps/command-center/ui/src/components/workspace/ready-workspace-modal-renderers.ts:23`, `:83`                                                         | Gate row type and review-sequence renderer                                          |
| `apps/command-center/ui/src/components/workspace/ready-workspace-review-request-model.ts:13`                                                           | Gate defaults, row edits and request serialization                                  |
| `apps/command-center/ui/src/components/workspace/ready-workspace-state.ts:68`; `ready-workspace-action-presenter.ts:674` in the same directory         | Gate-local selection state and row handlers                                         |
| `apps/command-center/ui/src/components/dispatch/dispatch-wizard-draft.ts:20`, `:123`, `:141`, `:159`                                                   | Wizard row type, alternate-runner default, plan/depth builders                      |
| `apps/command-center/ui/src/components/dispatch/dispatch-wizard-publication-review-renderer.ts:27`                                                     | Wizard review-sequence renderer                                                     |
| `apps/command-center/ui/src/components/dispatch/dispatch-wizard-primary-controls-renderer.ts:247`; `dispatch-wizard.ts:1712` in the same directory     | Wizard runner/model/effort controls and selection/row handlers                      |
| `apps/command-center/ui/src/components/shared/dispatch-config-editor.ts:237`, `:413`, `:538`                                                           | Backlog/queue review-plan model and both selector renderers                         |
| `apps/command-center/ui/src/components/shared/runner-model-effort-picker.ts:41`; `apps/command-center/ui/src/utils/runner-options.ts:43`, `:67`, `:97` | Old picker and platform-local defaults/model/effort selection logic                 |
| `apps/command-center/ui/src/components/pr-dashboard/pr-execution-picker.ts:25`, `:41`                                                                  | PR execution selection defaults and model-row editor                                |
| `apps/command-center/ui/src/components/pr-dashboard/pr-review-options-picker.ts:17`                                                                    | Separate session/scope reviewer controls                                            |
| `apps/command-center/ui/src/components/roadmap/roadmap-panel.ts:1070`, `:2042`                                                                         | Local runner/model options and refinement execution picker                          |
| `apps/companion/src/components/BacklogCreateForm.tsx:42`, `:59`, `:132`, `:239`, `:337`, `:529`, `:616`                                                | Mobile catalogs, local selection/plan state, serialization and dispatch/review rows |
| `apps/companion/src/features/pr-automation/components/PRPolicyFields.tsx:23`, `:137`                                                                   | Mobile reviewer session/scope and execution model-row controls                      |
| `apps/command-center/ui/src/components/dispatch/dispatch-wizard-prefill.ts:31`, `:107`                                                                 | Wizard-local review row parsing and URL serialization                               |

PR request, policy, monitor and rule hosts reuse the new renderers. Migrate the
old runner picker's chat/native-session callers before deleting that component;
they use single-row contexts. Companion's gate host at
`apps/companion/src/features/decision-workspace/DecisionWorkspaceScreen.tsx:516`,
`:1527` has generic action handling, not a review-sequence picker: attach the
shared RN renderer there, without adding another view-model. Mock data,
fixtures and tests use the same contracts and labels.

## Security and data handling

The runner capability layer owns launch, reload and native session identity.
Verify PR ownership, reviewer session and immutable head boundaries before WARM
delivery. Never reuse the worker's conversation or infer ownership from pane
text. Credentials remain in existing host authentication paths. Picker context
does not grant publication, merge or dispatch authority.

## Consequences

- Review meaning is consistent across every entry point and platform.
- Session reuse and reviewed range cannot disagree through separate controls.
- Removing old fields/actions is a breaking protocol/configuration change.
  Convert persisted configuration and queued requests before deployment; do
  not ship alias handlers, dual contracts or runtime compatibility shims.
- Preserve historical results as provenance. Missing session/head evidence
  cannot be promoted into a current passing review during conversion.

## Implementation order

1. Lead and product-owner approval recorded on 2026-10-11.
2. Implement protocol, shared picker/view-model and all consumers in one PR.
   Cover gateway quality/review sources and artifacts, completion, review loops,
   backlog/dispatch, gate replay, slot release and session-process ownership.
   Rename all consumers, including the web/mobile hosts, pipeline/roadmap
   displays, mocks, fixtures, project schemas and executable validation.
3. Prove separate-session eligibility independent of runner choice; exact-PR
   WARM identity/delta, fresh COLD identity/full diff, unavailable-WARM refusal,
   and request/queue round trips. Verify every picker exposes effort and uses
   the shared model. Run live web/mobile flows with visible evidence.
4. Run required tests and separate-session PR reviews, with a hard maximum of
   five rounds. Freeze an approved exact head; record MERGE-READY after CI and
   required evidence pass. No implementation or public PR before ADR approval.

## Non-goals

- Runner-diversity scores, quotas, badges or worker-relative review categories.
- Per-caller picker components or separate Lit/RN business logic.
- Changing ADR-038's worker retention, slot ownership or publication authority.
- Treating a fresh session, a different model or a changed runner as evidence
  that a review passed.

## Amendment 1: scoped review-budget extensions, 2026-10-15

**Status:** Accepted (lead, 2026-10-15).
**Specification:** [Round budget](../reference/review-modes-warm-cold.md#round-budget).

### Decision

Five reviewer attempts remain the default limit. A lead-authorized operator
may raise the limit for the same run through an authenticated, audited gateway
operation, recording the bounded new limit, current head and scope brief.
The operation preserves every spent admission and review result. It grants
only additional review attempts; publication still requires current reviews,
evidence, deterministic checks and an explicit Approve Publish decision.

The existing review admission owner consumes the extension. Other entry points,
replay and PR-linked runs cannot reset the count or manufacture another budget.
Additional reviews use the existing WARM/COLD session and range contracts and
receive the approved scope brief with their ordinary review instructions.

### Rationale

An absolute stop after five attempts drove approved repair rounds outside the
run, leaving the publication gate attached to an older package. A recorded,
bounded exception keeps review provenance and publication in the original run.

### Consequences

The gate displays the effective limit and extension receipt. Unauthorized,
stale or conflicting requests refuse before mutation. Failed and interrupted
reviews keep their admissions; under Amendment 2 a no-verdict attempt spends no
round. Existing approval policy is unchanged.

### Public surface

- `run extend-review-budget <run-id> --limit <n> --head <sha> --scope <text>`
  is the operator CLI consumer of the admin RPC `run.extendReviewBudget`.
  The request supports an idempotency key and expected prior limit.
- `@farmslot/protocol` owns the request, response, extension receipt and effective
  `ReviewRoundBudget`. Existing CLI, Command Center and Companion run/gate views
  consume the projection; the gateway owns authorization and admission.
- This is an additive protocol capability. Runtime clients must use a matching
  protocol version. Harnesses inherit the gateway policy without another review
  command, reviewer dimension, package writer or permission bypass.

## Amendment 2: reviewer failures do not spend the review budget, 2026-10-18

**Status:** Accepted (lead, 2026-10-18).
**Trigger:** run 8cff6e80 stopped after one of its two fix attempts with all five rounds spent. Only two of those rounds returned a review: one reviewer timed out after 30 minutes and another emitted invalid JSON. A separate restart double-count (fixed by its own bug PR) spent a third.
**Specification:** [No-verdict attempts](../reference/review-modes-warm-cold.md#no-verdict-attempts). These [Round budget](../reference/review-modes-warm-cold.md#round-budget) rules changed to match:

- "including failed and interrupted attempts" (only counted attempts spend a round);
- "Replay, restart and a different gate or run MUST NOT refund rounds", and the scoped-extension rule "Restart, replay and a copied result MUST NOT refund attempts" (these still never refund by themselves; only the admission owner's settlement below does);
- "failed-attempt accounting" (now no-verdict accounting);
- Amendment 1's consequence "Failed and interrupted reviews still consume their admissions".

### Decision

**Every admitted reviewer attempt settles exactly once**, when it ends, through
the existing admission owner:

- **Counted:** the attempt returned its required result for the reviewed head,
  with a verdict of pass or issues. It spends one round of `N/5`.
- **No-verdict:** the attempt ended any other way, and it spends no round. This
  covers a reviewer that timed out, exited or left a missing or unusable result
  (such as invalid JSON); a launch that never started a reviewer; an attempt
  cancelled or superseded by a cancel, replay or gate replay; and an attempt a
  restart could not reattach to. Its reason is recorded.

A receipt with no settlement counts. That covers attempts still in flight,
receipts recorded before this amendment, and a rollback, so the rule fails
closed.

Admission is unchanged: a round is reserved and persisted before any runner
starts, under the same serialized budget path. Restart, replay and copied
history never refund by themselves:

- a restart that reattaches reuses the receipt;
- a restart that cannot reattach ends the attempt, and the owner settles it
  no-verdict with reason "lost on restart";
- copied histories neither settle nor duplicate receipts.

**Below the cap, run behaviour is unchanged.** A reviewer that fails still moves
the run to `review-failed` (ADR-065) with its retry action. No new automatic
retry is added. The only difference is that the no-verdict attempt is not
counted in `N/5`.

**The cap.** No-verdict settlements are counted in the same scope as the budget:
the repository PR, or the canonical run before a PR exists. The default cap is
3, and the lead sets the final value. When the count reaches the cap:

- the existing automatic launch paths stop starting reviewers for that work
  (restart recovery replay, review-sequence continuation, and the re-review
  after a fix);
- the run stays `review-failed`, with a reason naming the count and the last
  failures.

An operator-requested retry stays available. It is recorded, and a no-verdict
end counts toward the cap again. The cap stops automatic loops; it does not
override the operator.

**Storage.**

- `Run.reviewRoundAdmissions` stays the opaque string receipt list.
- A new optional `Run.reviewRoundSettlements` maps a receipt ID to its no-verdict
  settlement: reason and time. Counted receipts need no entry.
- Settlements are copied across the PR scope with the admissions, using the
  same merge, so every run for one PR shows the same counts.
- Rounds used = admissions in scope minus no-verdict settlements in scope.
- No-verdict count = no-verdict settlements in scope.

Extensions (Amendment 1) still raise only the review-round limit.

### Rationale and consequences

The budget exists to stop review and fix loops that do not converge and to point
at scope or design problems. A reviewer timeout, a crash, unusable output or a
cancelled or lost attempt says nothing about the change, but under the current
rule each one spends a round the work needed for a real review. Run 8cff6e80
lost its second fix attempt that way.

Run behaviour stays as ADR-065 defines it. The cap keeps a reviewer that fails
every time from being relaunched automatically without limit, and it says why.

The gate shows both counts: `N/5` reviews, plus no-verdict attempts against
their cap. The gateway computes `used` without no-verdict receipts, so older
clients that show only `N/5` also show the corrected count.

### Public surface

- `@farmslot/protocol`:
  - `Run` gains the optional, gateway-owned `reviewRoundSettlements`;
  - `ReviewRoundBudget` gains the no-verdict count and its limit, alongside the
    corrected `used`.
- The gateway's admission owner records settlements when attempts end, merges
  them across the PR scope, and applies the cap to the existing automatic launch
  paths. No new RPC or CLI command is added. `run get`, the gate views, Command
  Center and Companion show both counts through the existing projection.
- Coordinated protocol, gateway and client release. Existing receipts need no
  conversion: an unsettled receipt counts.

## Amendment 3: the pipeline review runs the dispatch's first review row, 2026-10-19

**Status:** Proposed

### Context

A run's pipeline review takes its runner and model from the project's `review` configuration, even when the dispatcher chose reviewers for the run in `reviewSequence`. The sequence only drives publication-gate reviews. On a validation run, the dispatcher chose a reviewer from a different model family than the worker. The pipeline review still ran the worker's own runner and model from the project configuration, and the gate then ran the chosen reviewer as an extra review.

### Decision

1. **The pipeline review runs row 1.** When a run carries a `reviewSequence`, its pipeline review uses the first row's runner, model and effort. The project `review` configuration applies only to runs without a sequence. This is an absolute selection, which the dispatcher makes per run. No rule compares it with the worker.
2. **Rechecks use the same row.** A pipeline review rerun after the evidence or the head changes uses the same row-1 selection, not a fixed runner.
3. **The gate counts it as row 1.** The publication gate counts that pipeline review as row 1's result, and requests only the remaining rows. Row 1 runs again only when the head or the reviewed inputs changed, like any recheck of the same review. A WARM row 1 continues its own review lineage at the gate, so only a COLD row 1 is counted from the pipeline review.

### Rationale and consequences

The dispatcher already states, per run, which reviewer it wants. Using that choice for the pipeline review gives cross-family review wherever the dispatcher asks for it, and the ADR's rule stays intact: review eligibility never depends on the worker's runner. A row-1 reviewer no longer runs twice. Runs without a sequence behave as before.

### Public surface

No protocol or RPC change. `reviewSequence` row 1 now also selects the pipeline reviewer, and gate review plans count a pipeline review as that row. The spec in `docs/reference/review-modes-warm-cold.md` states both.

## Amendment 4: unresolved code findings at the publish gate, 2026-10-20

**Status:** Accepted (lead, 2026-10-20).
**Related:** Amendment 1, [ADR-065](065-fail-closed-run-lifecycle.md) Amendment 7, [ADR-062](062-recorded-run-evidence.md) Amendment 10.

### Decision

A publication review at the gate can return code findings when the review budget has no round left for the fix. The fix loop then stops before delivery. Those findings stay pending delivery.

While a review round is available, the gate offers the existing "Continue Fixing N Findings" action for findings at the package head. It resumes the review loop's fix path: the retained worker receives the findings, and the fix is re-reviewed, which spends one round. The action is not offered while the budget is spent. A pending fix also comes before the gate's automatic re-review of changed inputs, so that re-review does not spend the round on the same code.

A recorded grant re-presents a pending publish gate. The gate then shows the effective limit, the grant receipt and the actions that limit allows (Amendment 1), including Continue Fixing. As before, a grant starts no reviewer and delivers nothing by itself; a person chooses the action.

Unchanged:

- visual Send back (ADR-062 Amendment 10);
- approval rules, so findings at the package head still block Approve Publish;
- ADR-065 Amendment 7's held results.

### Rationale and consequences

On TAT-4145 run bda11b1a, a codex review at the gate found a P1 on admission 5 of 5. The loop stopped before delivery and recorded the findings as not pending. The gate offered only Hold and Request Review. The 5→6 grant at 16:11Z left the gate saying five rounds were spent.

The gate offered no supported path to the worker. The P1 reached it only through a manual operator terminal message, and was fixed in 25867794. Request Review then reviewed the new head.

### Public surface

There is no new action, status, field or RPC:

- the gateway keeps round-limited findings pending;
- it offers `continue-review-fix` only while a round is available;
- it re-presents a pending gate after `run.extendReviewBudget`.

The CLI, Command Center and Companion already render the action and the budget.

## Amendment 5: a re-review continues the reviewer session that already reviewed the work, 2026-10-20

**Status:** Accepted (lead, 2026-10-20).
**Related:** Amendment 1 (scoped budget extensions), Amendment 2 (no-verdict attempts), Amendment 3 (the pipeline review runs row 1), Amendment 4 (unresolved code findings at the publish gate).
**Specification:** on acceptance, [Session and range](../reference/review-modes-warm-cold.md#session-and-range) and [Mode resolution](../reference/review-modes-warm-cold.md#mode-resolution) are updated to match, together with the required evidence list and the [Diff scope](../reference/review-modes-warm-cold.md#diff-scope) rule, which applies the WARM delta rule to the delta-scoped COLD fallback.
**Changes:**

This amendment replaces these accepted texts.

From the Decision and Security and data handling:

- the mode table's session and range entries ("Reuse the previous review session of the same repository/PR"; "The whole PR diff");
- "scoped to that PR rather than the current run ID or worker runner";
- "A missing, foreign, busy or incompatible session never silently turns WARM into COLD. Show the reason and let the operator wait or choose COLD.";
- "Model/effort changes follow the runner's session capabilities", for re-reviews;
- "bound to repository/PR" and "The WARM key is repository/PR plus `reviewId`";
- "Verify PR ownership … before WARM delivery", which now applies once the run has a PR.

From the specification:

- the first three bullets of Session and range (full-diff COLD, the PR-bound WARM binding, the visible refusal or wait state);
- "A model/effort change is allowed only when the session adapter supports it", for re-reviews;
- the Mode resolution rule that "an unavailable selected WARM mode MUST still be refused", for automatic re-reviews;
- the required "unavailable-WARM refusal" evidence, which becomes delta-scoped fallback evidence.

Every other verification and admission requirement stays in force.

### Decision

**A re-review defaults to WARM.** A re-review checks work that an earlier review of the same lineage already reviewed. It continues that review's retained reviewer session, with the same runner. It reviews the change from that review's last reviewed head to the current head, with the earlier findings in view. A lineage qualifies only when it has a validated earlier review result and a recorded reviewed head; otherwise its next review is a first pass. The WARM default applies to every re-review:

- the automatic re-review after a worker fix, in the review loop and after a restart;
- Continue Fixing and Send back;
- a gate Request Review that continues a lineage;
- the gate's re-review of changed inputs.

**First passes keep their scope.** A review's first pass creates its session in the mode its row selects, COLD by default, and reviews the whole diff. Its re-reviews default to WARM.

**Asking for COLD.** A re-review runs COLD only when a person selects COLD for it: COLD in the gate's Request Review picker, or `--review-mode cold` on the gate request. A COLD a person asks for creates a fresh session, reviews the whole diff and stays in the lineage. That session becomes the lineage's retained session. These select only a review's first pass:

- a sequence row's stored mode;
- `Run.reviewMode`;
- PR options;
- the project `review.mode`.

`resolveReviewMode` keeps its precedence for first passes.

**A re-review continues its review's lineage.** A re-review keeps the `reviewId` of the review whose work it checks, and never starts a new lineage. Its result updates that lineage's result. For each requested row, a gate Request Review preselects the run family's most recent lineage reviewed by that row's runner, in WARM, with that lineage's model and effort. The picker preselects WARM for a validated lineage, including when its session is unavailable, and only for one row per lineage. A later row with the same runner takes that runner's next most recent lineage, or is new and defaults to COLD. An unavailable session shows why the review will use a fresh session for the delta. A row whose runner has no earlier lineage is new and defaults to COLD. The re-review of changed inputs continues the lineage of the row the pipeline review ran (Amendment 3). The pipeline lineage is identified by the pipeline result's `session.reviewId`.

**The binding key works before a PR exists.** The WARM key is the run family plus the durable `reviewId` lineage. Once the run has a PR, the PR must match too. A lineage started before the PR existed continues after the PR opens. A lineage never continues in a run of another family.

**A retained session whose process ended is resumed** from its saved runner session, the same way a worker resumes. A busy session isn't unavailable: the re-review waits for its current turn. A retained session is unavailable only when:

- its session record is missing, or the runner can't resume it on this slot under the same result contract;
- the requested model or effort differs from the session's recorded model or effort;
- another lineage holds it;
- the current head no longer descends from the lineage's last reviewed head.

**An unavailable session never stops a re-review.** The re-review runs COLD in a fresh session, scoped to the lineage's delta, with the earlier findings in its prompt. Like a WARM re-review, it keeps correctness checks on that delta. That fresh session becomes the lineage's retained session. The same applies when a resume fails to start: the same attempt runs the delta-scoped COLD under its admitted receipt. The review records why it ran COLD and the ranges it compared, and the gate shows both with that review.

The delta is the change since the lineage's last reviewed head. After a rebase, it compares the branch's own change at both heads (`git range-diff`): the reviewed head against its merge-base with the base branch, and the current head against its current merge-base. Changes that came only from the base branch are left out.

**A person's request.** Operator and person WARM re-reviews use the same delta fallback as automatic re-reviews. An unavailable session never turns such a request into a full-diff review. A legacy completed reviewer may supply the retained baseline when its validated verdict, reviewed head, provider session, owner, family and artifact scope bind it to that lineage. Missing newer validation timestamps or an older runtime review alias alone do not invalidate that provenance. A failed attempt before inspection does not replace that earlier validated baseline. If the binding transferred to that attempt, its gateway-owned no-verdict settlement permits resuming the same provider session from the earlier baseline.

**Clarification, 2026-10-21:** the lead requested this operator fallback and legacy baseline adoption after an unavailable WARM request could only be replaced with a full COLD review.

**Unchanged:**

- admission limits, the round budget and the no-verdict cap still stop automatic launches, and settlements and restart receipt reuse work as before (Amendments 1 and 2);
- a re-review spends one round, subject to Amendment 7's farm-caused fallback exception, and its result updates the lineage like any recheck;
- runner diversity is still never a rule;
- `run rereview` and PR-rule review-pr chains keep their own continuation rules.

### Rationale and consequences

On TAT-4145 run bda11b1a, all 12 reviewer attempts ran COLD on the full diff:

- **COLD by default.** The automatic re-review, Continue Fixing and the gate's re-review of changed inputs all default to COLD.
- **WARM needed a PR.** A run before publication has none, so its lineage context couldn't be built. The one path that asked for WARM, restart recovery of an active fix pass, was refused and fell back to a full-diff COLD.
- **A new lineage each time.** Each gate Request Review and each re-review of changed inputs started a new lineage.

Each attempt reviewed the whole diff in a fresh session, so it could raise new findings on code that earlier rounds had accepted. Continuing the session that raised the findings lets the reviewer check them against the fix, with the context it already built. When that session can't continue, a delta-scoped review still checks only the change, and the run keeps moving.

### Public surface

There is no new action or RPC. `@farmslot/protocol` changes in one release with the packages that depend on it: a review's lineage context no longer requires a PR number, and the review record gains its fallback reason and compared ranges. Behaviour changes:

- WARM lineage resolution accepts a run family before a PR exists;
- the re-review paths default to WARM in their review's lineage;
- the gate's Request Review preselects the row runner's latest lineage in WARM;
- any re-review whose session is unavailable runs a delta-scoped COLD review;
- the review records the fallback reason and its compared ranges, and the gate shows them with that review in the CLI, Command Center and Companion.

## Amendment 6: a bounded update-branch review budget, 2026-10-24

**Status:** Accepted by the lead for the update-branch budget repair.
**Specification:** [Update-branch budget](../reference/review-modes-warm-cold.md#update-branch-budget).

### Decision

Each `update-branch` run receives two review rounds for its branch update,
separate from the feature PR's five-round budget and scoped extensions. It
cannot receive an extension. Replay and restart reuse that run's admissions;
they do not create another two rounds. A later update-branch run has its own
budget because it checks a separate branch update.

New maintenance admissions record their owning run beside the existing opaque
receipts. Legacy receipts keep their PR charge and are never reassigned on
reattachment. Shared persistence retains all receipts, owners and settlements.
Each gate and no-verdict cap counts only the admissions in its budget.

### Rationale and consequences

A successful merge-main push could fail its required review because the feature
PR had spent five rounds and update-branch cannot receive extensions. Two own
rounds let the maintenance check settle without reopening the feature budget.
The existing review, immutable-input and publication requirements still apply;
spending the budget does not invalidate an already qualifying pass.

### Public surface

There is no new RPC, CLI action or harness setting. `@farmslot/protocol` 0.70.2
adds optional `Run.reviewRoundOwners`, the update-branch limit constant and a
bounded base-limit argument to `reviewRoundBudget`. `reviewRoundBudgetForRun`
and `reviewRoundAdmissionsInScope` share accounting between the gateway and
`@farmslot/review-dispatch` 0.18.1 activity labels. Existing calls keep five rounds. The wire protocol remains 0.63.0. Clients keep rendering the shared budget
projection; they do not infer scope themselves.

## Amendment 7: farm-caused fallback preserves the review budget, 2026-10-25

**Status:** Accepted (lead F144 direction, 2026-10-25).
**Specification:** [Farm-caused fallback](../reference/review-modes-warm-cold.md#farm-caused-fallback).

### Decision

Static-code reviewer launches use their explicit project environment and pinned sources, without unrelated pool tool overrides. Full-live reviews keep their pool environment. A retained session keeps its recorded launch policy, including the legacy policy when no validation depth was captured. Handoff recovery uses the launch already validated for that lease and reconciles an uncertain transfer or resume once before declaring the session unavailable. Owner, slot, profile, lease, generation and launch-digest fences remain in force.

When a farm failure prevents a retained WARM reviewer from accepting its initial command, its delta-scoped COLD replacement keeps the same admission and spends no review round. The failed WARM launch is settled as `infrastructure-fallback`. Its replacement's valid verdict does not clear that settlement, including after restart recovery. The failed launch still counts against the existing no-verdict cap, so automatic retries remain bounded.

Ordinary WARM reviews, explicitly selected COLD reviews and incompatible requested model, effort or validation-depth changes keep their existing accounting. The replacement's findings remain authoritative; no finding or approval requirement is waived.

### Rationale and consequences

A provider rollout changed unused reviewer environment and invalidated a saved launch. Handoff also reloaded newer pool settings after validating an earlier launch. Two farm-caused COLD replacements exhausted a validation run's review budget. Keeping irrelevant pool selection out of static launch identity and reconciling the existing intent avoids those replacements; the accounting exception keeps a necessary farm fallback from spending the author's round.

### Public surface

`@farmslot/protocol` 0.71.1 adds optional `AgentContext.reviewValidationDepth` for the gateway's retained launch policy and optional `ReviewRoundSettlement.kind = 'infrastructure-fallback'` for the gateway-owned settlement. Existing budget projections subtract the same settled admission and retain the failed-launch cap. No new CLI action, RPC, shared renderer policy or native runtime field is introduced. Wire protocol 0.63.0 is unchanged.

## Amendment 8: stop empty and small-fix re-reviews, 2026-10-26

**Status:** Accepted by the lead, approved by Arthur 2026-10-26.
**Specification:** [Automatic re-review limits](../reference/review-modes-warm-cold.md#automatic-re-review-limits).

A fix that changes no source files and leaves the reviewer's findings unchanged
ends the automatic loop at the gate with those findings open. A completed fix
that touches only evidence or at most 50 source lines skips the warm re-review
and resolves those findings for the gate. The original reviewer attempt remains
unchanged; gateway acceptance records the completed fix and current inputs.
Unknown deltas retain
the existing review path. Restart recovery applies the same limits.

Repeated empty cycles and small rechecks consumed reviewer rounds without new
findings. These limits remove automatic launches without another reviewer
verdict or round admission. There is no new public API or package field.

## Amendment 9: independent review-pr request budgets, 2026-10-29

**Status:** Proposed for the requested review-pr budget repair.
**Specification:** [Review-pr budget](../reference/review-modes-warm-cold.md#review-pr-budget).

Each `review-pr` run has its own five-round budget, independent of other runs
for the same repository/PR, including archived requests and feature work.
Admissions, settlements, no-verdict accounting and the admission lock are scoped
to that run. Replay, restart and reattachment retain its spent rounds; a new
review request receives a new budget. Review-pr remains ineligible for extensions.

A requested review of core#10693 could not dispatch because earlier archived
review-pr requests had spent the PR-wide budget. That cap governs convergence
within one request, not whether a PR can ever be reviewed again. Feature PR
budgets and the two-round update-branch budget retain their existing accounting.

### Public surface

This changes gateway budget selection only. Existing admission records and
budget projections remain authoritative; no record, RPC, CLI flag, SDK export,
harness setting or worker-loaded package changes. WARM lineage and review
publication requirements remain unchanged.
