# Review and dispatch contract

**Status:** Normative, authorized by [ADR-063](../adr/063-review-modes-warm-cold.md), accepted 2026-10-11.
**Owner:** Farmslot maintainers.

## Selection and sequence

A review selection has exactly four configurable dimensions: `runner`, `model`,
`effort`, and `mode`. `mode` MUST be `warm` or `cold`. Runner choices MUST come
from the registered capability catalog; there is no `same` sentinel or
worker-relative reviewer default. Model and effort may explicitly select the
runner default. No policy, count, gate action or label may depend on runner
diversity. Every review MUST run in a separate review session.

`ReviewSequence` is an ordered collection of these selections. One shared
serializer emits the first row as the `request-review` action payload and any
remaining rows in its optional `sequence` field. Backlog, dispatch and queue
records use the same selection model in `reviewSequence`. Rechecks update the
existing review result; retry attempts do not increase the qualifying-review count.

## Round budget

The gateway MUST default to at most five reviewer rounds for a repository/PR. Before
a PR identity exists, admission is scoped to its canonical run. Initial, retry,
WARM/COLD, pipeline, standalone and publish-gate reviewer attempts MUST spend
this same budget, including failed and interrupted attempts. A worker fix is
not a reviewer round. Reattaching to an admitted attempt MUST reuse its receipt.
An ambiguous qualified GitHub reference alone MUST NOT establish PR scope for a
ticket flow. Existing PR linkage, a pull URL or a PR-bound flow supplies that context.

Admission receipts MUST persist in the existing run snapshots before a runner
can start. Replay, restart and a different gate or run MUST NOT refund rounds.
Copied review histories MUST NOT count the same admitted attempt twice. The
round budget is separate from the number of qualifying passing reviewer sessions.

Without an authorized extension, the gate MUST show `N/5` and refuse a sixth round before consuming its request
or starting a reviewer. The refusal MUST tell the operator to stop and diagnose
a design problem or scope creep, then narrow the scope or redesign. Spending all
five rounds MUST NOT prevent publication when all existing approval conditions
are satisfied.

### Scoped extension

**Status:** Proposed under ADR-063 Amendment 1, 2026-10-15.

`run.extendReviewBudget` MUST use existing admin authorization and capture the
authenticated request origin. Caller-supplied approver names or system/worker
signals MUST NOT grant authority. The operator must have lead approval for the
recorded scope; a service credential retains its service identity and cannot
claim to be a person. Existing credential and principal revocation checks apply.

The request names a stored, nonarchived unpublished run, including a failed or
interrupted run, its full current head SHA, a finite integer absolute limit
greater than its effective limit, a nonempty scope brief, an idempotency key and
the expected prior limit. A new grant MUST refuse an already published, archived
or unrelated run, invalid inputs, unknown/live-head drift, unauthorized origin
or conflicting prior limit before any state or runner mutation.

The receipt MUST retain the request identity, run and source/PR identity,
approved head, prior/new limits, scope brief, authenticated origin and time.
Serialize the grant with review admission, recheck state/head after asynchronous
reads, and persist the receipt before using its extra capacity. An exact retry
returns the original receipt; reuse of its key for different inputs refuses.
Existing admissions MUST remain unchanged. Restart, replay and a copied result
MUST NOT refund attempts or apply the same extension twice.

The effective limit and used count MUST come from the existing admission owner.
Before a PR exists, the receipt applies only to its canonical run. Once the run
has a verified repository/PR identity, the existing shared scope MUST preserve
that receipt and its admissions across active and archived history. A different
run MUST NOT obtain a fresh default budget for the same PR. The original run
remains the execution and publication owner.

The gate shows `N/L` and the grant's scope/provenance. The current approved
scope brief MUST accompany additional reviewer instructions. A grant does not
start a reviewer, reset worker-fix retries, mark a result passed or authorize
publication. Existing review requests/replay collect real results on the same
run, preserving WARM lineage, immutable ranges, failed-attempt accounting and
the number of required qualifying reviewers.

Validation MUST cover unauthorized/stale requests, exact retry and conflicting
keys, concurrent grants/admissions, restart/archive scope preservation, refusal
without an extension and real sixth/seventh admissions after a bounded grant.
An extension MUST NOT make stale reviews or an old package publishable.

## Session and range

- COLD MUST create a fresh review session and review the complete PR diff at
  captured base/head SHAs. A reset of an existing session is insufficient.
- WARM MUST reuse that PR's verified previous review session and review only
  `lastReviewedHead..currentHead`. The binding is to repository/PR and review
  provenance, not the worker's runner or a run ID alone. The exact binding key
  is repository/PR plus durable `reviewId` lineage. Request/sequence context
  identifies the lineage being continued; a recheck updates that same result.
  Missing or ambiguous lineage MUST be refused. Lineage is provenance, not a
  fifth selection dimension or a runner-relative default.
- Missing, foreign, busy or incompatible WARM bindings MUST produce a visible
  refusal or wait state. They MUST NOT silently launch COLD. A model/effort
  change is allowed only when the session adapter supports it.
- Passing review eligibility requires its separate session, current reviewed
  head and verdict evidence. Choosing a different runner proves nothing.

## Mode resolution

`@farmslot/review-dispatch.resolveReviewMode` owns mode selection. Its precedence
is an explicit selection, `Run.reviewMode`, `Run.prWork.review.options.mode`,
the retained `Run.repeatReviewContext.mode`, a supplied project default, then
COLD. An explicit COLD selection MUST override a configured WARM default.
Admission, continuity, task instructions and recorded review snapshots MUST use
this precedence. Run creation MUST use the same shared default. The resolver does not verify lineage or authorize session reuse;
an unavailable selected WARM mode MUST still be refused.

Automatic reviews that create a separate new lineage select the shared COLD
default. Eligibility filtering for authorized alternatives remains separate
from mode selection and cannot downgrade an explicit WARM request.

## Shared picker

`@farmslot/review-dispatch` owns one `ReviewDispatchViewModel`, catalog/default
resolution, row operations, serialization and validation. The backend and SDK
use its validators. Lit and React Native each have one thin renderer. Call
context supplies allowed actions, defaults and sequence availability; callers
MUST NOT duplicate selection state or normalization.

Gate requests, dispatch wizard, backlog options, PR execution and Companion
equivalents consume this model. Effort MUST appear next to model. Every review
row MUST expose WARM/COLD. Unsupported adjustable effort shows the supported
default explicitly. Resource, publication and QA controls remain host concerns.
The duplicate units listed in ADR-063 MUST be removed after their callers move.

## Public surface

- CLI consumers are `run create`, review/dispatch entry points and gate
  requests: `--runner`, `--model`, `--effort`, `--review-mode warm|cold`, and
  `--review-sequence <json>`. Existing run `--mode` retains its workflow meaning.
- `@farmslot/protocol` owns `ReviewMode`, `ReviewSelection`, `ReviewSequence`,
  `ReviewStatus`, `ReviewAttempt` and `ReviewPolicy`. Run creation, PR options,
  gate resolution, backlog and dispatch queue RPCs consume these types.
- `@farmslot/protocol` also owns `ReviewRoundBudget`, `MAX_REVIEW_ROUNDS` and
  `reviewRoundBudget`. Gateway admission and both gate renderers consume the
  shared projection. `Run.reviewRoundAdmissions` contains gateway-owned opaque
  receipts; `ReadyGatePayload.reviewRoundBudget` carries the display snapshot.
  No CLI flag or client-written receipt is added.
- The shared package exports the view-model and selection/sequence validators
  for Command Center, Companion, CLI and gateway consumers.
- `resolveReviewMode` and `ResolveReviewModeOptions` are additive exports from
  that same package. Pickers and gateway admission, execution and evidence
  readers consume them. They add no protocol field, CLI flag or harness policy;
  harnesses inherit the gateway's selected mode and existing lineage checks.
- Gate action `request-review` replaces both old review-request action IDs.
  Old fields, action IDs and session/scope enums have no aliases or shims.
- This is a coordinated breaking contract update. Persisted configuration and
  queued requests MUST be converted before deployment; old records lacking
  proof remain historical provenance, not current passing reviews.
- Project `review.mode` supplies a configured mode default. Removed keys such
  as `minimum_independent_reviews`, `require_cross_runner` and
  `self_review.session_policy` MUST be rejected with a conversion hint, not
  ignored into a less restrictive default.
- Project harnesses consume the typed gateway contract. They
  inherit session/mode validation; farm-owned QA remains separate under
  ADR-058. This adds no harness-specific review policy or extension flag.

## Required evidence

Tests and live receipts MUST prove fresh COLD identity/full range, retained WARM
identity/delta range, unavailable-WARM refusal, runner-choice-independent
eligibility, effort preservation and sequence round trips. Web/mobile proof
MUST exercise the shared picker through user input, not injected UI state.

## Diff scope

The shared minimal-diff policy is owned by `@farmslot/agent-runtime/scripts/review-diff-scope.cjs`. Worker task documents, independent review prompts and the cross-review orchestrator consume that definition. Every verdict includes its `Diff scope` table. Warm review narrows correctness review to the saved delta; its scope inventory still covers the whole contribution against the publication base.

The public read-only script prints the policy with `instructions`, or the policy plus changed paths and sensitive-path candidates with `packet <repository> <publication-base> <head>`. Candidates require review against the frozen ticket; the scanner neither grants an exception nor detects semantic refactors or formatting churn. It does not change source, review results or publication authority.
