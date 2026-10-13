---
# GENERATED from docs/reference/review-modes-warm-cold.md; edit that source, then run generate:contracts.
title: 'Review and dispatch contract'
---

**Status:** Normative, authorized by [ADR-063](https://github.com/deeeed/farmslot/blob/main/docs/adr/063-review-modes-warm-cold.md), accepted 2026-10-11.
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

The gateway MUST admit at most five reviewer rounds for a repository/PR. Before
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

The gate MUST show `N/5` and refuse a sixth round before consuming its request
or starting a reviewer. The refusal MUST tell the operator to stop and diagnose
a design problem or scope creep, then narrow the scope or redesign. Spending all
five rounds MUST NOT prevent publication when all existing approval conditions
are satisfied.

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
