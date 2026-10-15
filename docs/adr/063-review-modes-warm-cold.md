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
**Related:** ADR-065's publication-package refresh amendment.

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
reviews still consume their admissions. Existing approval policy is unchanged.

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
