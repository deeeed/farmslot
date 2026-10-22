# Review and dispatch contract

**Status:** Normative, authorized by [ADR-063](../adr/063-review-modes-warm-cold.md), accepted 2026-10-11.
**Owner:** Farmslot maintainers.

Verdicts, severity, configurable approval policy and inline locations follow the [shared review policy](review-curation-and-results.md#approval-policy), including gate refresh.

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

When a run carries a `reviewSequence`, row 1 also selects the runner, model and
effort of its pipeline review and of that review's rechecks after the evidence
or head changes (ADR-063 Amendment 3). When row 1 is COLD, the publication gate
counts a passing pipeline review of the gate head as row 1's result and requests
only the remaining rows. A WARM row 1 continues its own review lineage at the
gate. Runs without a sequence take the pipeline reviewer from the project
`review` configuration.

## Round budget

The gateway MUST default to at most five reviewer rounds for a repository/PR. Before
a PR identity exists, admission is scoped to its canonical run. Initial, retry,
WARM/COLD, pipeline, standalone and publish-gate reviewer attempts MUST spend
this same budget; only a counted attempt spends a round (see
[No-verdict attempts](#no-verdict-attempts)). A worker fix is
not a reviewer round. Reattaching to an admitted attempt MUST reuse its receipt.
An ambiguous qualified GitHub reference alone MUST NOT establish PR scope for a
ticket flow. Existing PR linkage, a pull URL or a PR-bound flow supplies that context.

Admission receipts MUST persist in the existing run snapshots before a runner
can start. Replay, restart and a different gate or run MUST NOT refund rounds
by themselves; only the admission owner's no-verdict settlement does.
Copied review histories MUST NOT count the same admitted attempt twice. The
round budget is separate from the number of qualifying passing reviewer sessions.

Without an authorized extension, the gate MUST show `N/5` and refuse a sixth round before consuming its request
or starting a reviewer. The refusal MUST tell the operator to stop and diagnose
a design problem or scope creep, then narrow the scope or redesign. Spending all
five rounds MUST NOT prevent publication when all existing approval conditions
are satisfied.

### Scoped extension

**Status:** Accepted (lead, 2026-10-15) under ADR-063 Amendment 1.

`run.extendReviewBudget` MUST use existing admin authorization and capture the
authenticated request origin. Caller-supplied approver names or system/worker
signals MUST NOT grant authority. The operator must have lead approval for the
recorded scope; a service credential retains its service identity and cannot
claim to be a person. Existing credential and principal revocation checks apply.

The request names a stored, nonarchived unpublished run, including a failed or
interrupted run, its full current head SHA, a finite integer absolute limit
greater than its effective limit by one to five rounds, a nonempty scope brief, an idempotency key and
the expected prior limit. A new grant MUST refuse an already published, archived
or unrelated run, invalid inputs, unknown/live-head drift, unauthorized origin
or conflicting prior limit before any state or runner mutation.

The receipt MUST retain the request identity, run and source/PR identity,
approved head, prior/new limits, scope brief, authenticated origin and time.
Serialize the grant with review admission, recheck state/head after asynchronous
reads, and persist the receipt before using its extra capacity. An exact retry
returns the original receipt; reuse of its key for different inputs refuses.
Existing admissions MUST remain unchanged. Restart, replay and a copied result
MUST NOT refund attempts by themselves or apply the same extension twice.

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
run, preserving WARM lineage, immutable ranges, no-verdict accounting and
the number of required qualifying reviewers.

Validation MUST cover unauthorized/stale requests, exact retry and conflicting
keys, concurrent grants/admissions, restart/archive scope preservation, refusal
without an extension and real sixth/seventh admissions after a bounded grant.
An extension MUST NOT make stale reviews or an old package publishable.

### No-verdict attempts

**Status:** Accepted (lead, 2026-10-18) under ADR-063 Amendment 2.

Each admitted reviewer attempt settles once, through the admission owner, when
it ends. An attempt that returned its required result for the reviewed head with
a pass or issues verdict is counted and records nothing. These ends are
no-verdict and spend no round; `Run.reviewRoundSettlements` records the reason
and time against the receipt:

- a native reviewer that timed out, exited, left a missing or unusable result,
  failed to launch, or was cancelled or superseded;
- a reviewer a restart could not reattach, or whose recovered signal or result
  shows a failure;
- a workspace review whose launch failed after admission, or whose monitor
  ended without recording a result, a cancel or supersession included. A
  replay that dispatches again at a new engine generation is a new attempt; a
  restart that re-enters DISPATCH at the same generation keeps its receipt, and
  a monitor-only replay still settles the attempt its DISPATCH admitted.

A receipt without a settlement counts, so in-flight, older and rolled-back
receipts fail closed. A launch or delivery with an uncertain outcome still
counts, because its reviewer may be running, and so does a legacy tmux reviewer.
Admitting a receipt again (a reattach) keeps its settlement. When a settled
attempt's pass or issues verdict arrives later, through restart recovery or a
workspace monitor replay that records it, the settlement is cleared and the
attempt counts.

Settlements MUST be merged across the admission scope and copied to every live
run in it. Rounds used are admissions minus no-verdict settlements;
`ReviewRoundBudget.noVerdict` counts the settlements against `noVerdictLimit`
(default 3).

Below the cap, run behaviour is unchanged. At the cap, these automatic launches
stop with a reason naming the count and the last failures:

- the re-review after a fix: the loop stops before its next fix pass and keeps
  the findings for Continue Fixing;
- the re-review of a fix pass recovered after a restart;
- a publication review plan no operator request started, including configured
  sequences, reviewed-input reruns and a plan restart recovery resumes: the gate
  records a launch refusal.

An operator's Request Review still launches, and so does the first fix pass and
re-review of Continue Fixing or Send back. Their no-verdict ends count again.
The gate shows `N/L` and, once there are any, the no-verdict count against its
cap.

## Session and range

**Amended** by ADR-063 Amendment 5 (2026-10-20).

- A review's first pass, and a COLD a person asks for, MUST create a fresh
  review session and review the whole diff at captured base/head SHAs. A reset
  of an existing session is insufficient. That session becomes the lineage's
  retained session.
- A re-review MUST continue the retained session of the lineage whose work it
  checks, with the same runner, and review only `lastReviewedHead..currentHead`
  with the earlier findings in view. A lineage qualifies only with a validated
  earlier result and a recorded reviewed head; otherwise its next review is a
  first pass.
- The binding key is the run family plus the durable `reviewId` lineage. Once
  the run has a PR, the PR MUST match too, so a lineage started before the PR
  continues after it opens. A lineage MUST NOT continue in a run of another
  family. Request/sequence context identifies the lineage being continued; a
  recheck updates that same result. Missing or ambiguous lineage in a request
  MUST be refused. Lineage is provenance, not a fifth selection dimension or a
  runner-relative default.
- A retained session whose process ended MUST be resumed from its saved runner
  session. A busy session is waited for. A retained session is unavailable only
  when its record is missing or can't resume on this slot under the same result
  contract, the requested model or effort differs from its recorded one, another
  lineage holds it, or the current head no longer descends from the lineage's
  last reviewed head.
- A re-review whose session is unavailable, or whose resume fails to
  start, MUST run COLD in a fresh session in the same attempt and under its
  admitted receipt, scoped to the lineage's delta, with the earlier findings in
  its prompt. That session becomes the lineage's retained session. The review's
  session trace records the reason and the compared ranges (`fallback`), and the
  gate shows both with that review.
- The delta is `lastReviewedHead..currentHead` while the current head descends
  from the reviewed head. After a rebase it compares the branch's own change at
  both heads with `git range-diff`: the reviewed head against its merge-base
  with the base branch, and the current head against its current merge-base.
  Changes that came only from the base branch are left out.
- Operator and person WARM re-reviews MUST use the same delta fallback. An
  unavailable session MUST NOT turn a re-review into a full-diff review.
- Legacy completed contexts MAY establish the retained baseline through the
  validated verdict, reviewed head, matching provider session, owner, family and
  artifact scope. A missing newer validation timestamp or an older runtime
  review alias alone MUST NOT invalidate that provenance. An attempt that fails
  before inspection MUST NOT replace the last validated baseline. A binding
  transferred to a failed attempt MAY continue that provider session only with
  its gateway-owned no-verdict settlement and the earlier validated provenance.
- Passing review eligibility requires its separate session, current reviewed
  head and verdict evidence. Choosing a different runner proves nothing.
- A retained reviewer is a resumable session identity, not a running process.
  Once a native reviewer's result is recorded, the Gateway MUST stop its
  process and the MCP servers it started, keeping the session, lease and
  conversation for WARM. A WARM re-review transfers the stopped session and
  resumes its saved conversation, on native and tmux runs alike. An idle
  settled reviewer MUST NOT hold a live process. A stop the host does not
  confirm is logged and leaves the binding held, so the next reuse of the slot
  stops it.

## Mode resolution

`@farmslot/review-dispatch.resolveReviewMode` owns mode selection. Its precedence
is an explicit selection, `Run.reviewMode`, `Run.prWork.review.options.mode`,
the retained `Run.repeatReviewContext.mode`, a supplied project default, then
COLD. An explicit COLD selection MUST override a configured WARM default.
Admission, continuity, task instructions and recorded review snapshots MUST use
this precedence. Run creation MUST use the same shared default. The resolver does not verify lineage or authorize session reuse.

Under ADR-063 Amendment 5 this precedence selects only a review's first pass. A
re-review defaults to WARM in its lineage: the re-review after a worker fix,
including after a restart; Continue Fixing and Send back; a gate Request Review
that continues a lineage; and the gate's re-review of changed inputs, which
continues the lineage of the row the pipeline review ran, named by the pipeline
result's `session.reviewId`. A re-review runs COLD only when a person selects
COLD for it, in the gate's Request Review picker or with `--review-mode cold` on
the gate request. A sequence row's stored mode, `Run.reviewMode`, PR options and
the project `review.mode` select only first passes.

For each requested row, the gate's Request Review preselects the run family's
most recent lineage reviewed by that row's runner, in WARM, with that lineage's
model and effort, including when its session is unavailable, and only for one
row per lineage. A later row with the same runner takes that runner's next most
recent lineage, or is new and defaults to COLD. A row whose lineage is
unavailable stays WARM and shows why it will review the delta in a fresh session. The gateway lists the gate's lineages
and their availability in `ReadyGatePayload.reviewLineageOptions`.

Automatic reviews that create a separate new lineage select the shared COLD
default. A re-review whose session is unavailable runs the delta-scoped COLD
fallback above, including operator and person WARM requests. Eligibility
filtering for authorized alternatives remains separate from mode selection and
cannot downgrade an explicit WARM request.

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
- `@farmslot/protocol` also owns `ReviewRoundBudget`, `MAX_REVIEW_ROUNDS`,
  `REVIEW_NO_VERDICT_LIMIT`, `reviewRoundBudget` and the `reviewRoundBudgetLabel`
  formatter. Gateway admission, the CLI and both gate renderers consume the
  shared projection. `Run.reviewRoundAdmissions` contains gateway-owned opaque
  receipts and `Run.reviewRoundSettlements` their no-verdict settlements;
  `ReadyGatePayload.reviewRoundBudget` carries the display snapshot.
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
identity/delta range (including before a PR exists), the delta-scoped COLD
fallback of automatic and person re-reviews with its recorded reason and
compared ranges, including a rebased delta, legacy baseline adoption,
runner-choice-independent eligibility, effort preservation and sequence round
trips. Web/mobile proof
MUST exercise the shared picker through user input, not injected UI state.

## Diff scope

The shared minimal-diff policy is owned by `@farmslot/agent-runtime/scripts/review-diff-scope.cjs`. Worker task documents, independent review prompts and the cross-review orchestrator consume that definition. Every verdict includes its `Diff scope` table. Warm review, and the delta-scoped COLD fallback of a re-review whose session can't continue, narrow correctness review to the saved delta; their scope inventory still covers the whole contribution against the publication base.

The public read-only script prints the policy with `instructions`, or the policy plus changed paths and sensitive-path candidates with `packet <repository> <publication-base> <head>`. Candidates require review against the frozen ticket; the scanner neither grants an exception nor detects semantic refactors or formatting churn. It does not change source, review results or publication authority.
Grant-time head records provenance. Later fix heads on the same owned branch use current-head review rules and the recorded scope. An extension survives retirement of its granting run within the same PR scope. The command requires `--request-id` and accepts `--expected-limit` for a compare-and-set grant.
