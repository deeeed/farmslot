# Fail-closed run lifecycle

**Status:** Accepted normative specification for [ADR-065](../adr/065-fail-closed-run-lifecycle.md), 2026-10-12.
**Owner:** Farmslot maintainers.
**Scope:** Gateway enforcement over existing evidence, review, runtime and runner contracts.

MUST and MUST NOT are requirements for implementation, not claims about current
behavior. Keep this specification with ADR-065 through implementation. ADR-062
and ADR-063 own the referenced evidence/review rules.

## Inputs and ownership

The gateway MUST consume the selected canonical execution template and its
declared deterministic steps, the registered task ACs and ADR-062 ledger/package,
ADR-063 required review results, and Goal 3's admitted project/target/resource
requirements. Selected template identity, execution attempt, source revision and
evidence-package identity MUST agree with the results used to advance the run.
Source-affecting changes invalidate deterministic/review results; evidence
selection changes invalidate evidence approval. Do not borrow success from a
sibling run, another attempt or an older head.

Goal 3's current draft exports `RecipeFlowRequirements` and
`recipeFlowRequirements` from `@farmslot/protocol`; its `resources` are provider
IDs. This spec does not add metadata or alter their parser. Recipe parameters
are smoke inputs, not capability acquire parameters. Use the existing resolved
target, provider catalog and `RuntimeCapabilityProofRequirement` contract for
acquisition. Missing target, proof mode or provider parameters MUST produce an
explicit refusal and an owner handoff, never guessed values or another schema.

Declaration, read-only dispatch admission and capability display remain Goal 3
responsibilities. Admission MUST NOT acquire a lease as a side effect. Acquisition
integration MUST wait for that contract to merge and its owner to acknowledge
the consumer boundary. ADR-062 supplies its canonical package validator and
claim verdicts; ADR-063 supplies review policy and result validation. This spec
only composes their outcomes.

## Gate prerequisites

The gateway MUST evaluate the following prerequisites before making any action
that advances work available, including ready/complete, publication and QA
output acceptance. Apply each prerequisite only where the selected flow declares
it. A static-review flow does not acquire an invented UI/HUD obligation.

| Prerequisite        | Required result                                                                                                               | Incomplete/invalid result                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Deterministic steps | Every required declared step has an observed successful result for the selected inputs/revision                               | Missing, skipped, still running, failed, stale or unknown prevents advancement                                                     |
| AC ledger           | Every registered AC has a valid current verdict; required occurrences and exceptions satisfy ADR-062 and existing flow policy | Missing ledger, unassessed/unknown IDs, unresolved verdicts or invalid override prevents advancement                               |
| Evidence            | ADR-062's validator accepts the selected immutable package and required dependencies                                          | Missing media/HUD, stale digest/index, interrupted proof or unresolved required visual judgment prevents advancement under ADR-062 |
| Review results      | Every reviewer required by ADR-063 policy has a valid current result artifact satisfying that policy                          | Missing, malformed, foreign-session, stale-head or non-passing required result prevents advancement                                |

The gateway MUST return all failed prerequisite reasons, with a stable code,
prerequisite category, safe message, current artifact/step/claim reference when
available, and an existing permitted next action. A pending result is not a pass.
No worker-authored completion message or client-local checkbox can replace these
checks. Flow obligations remain effective if template prose forgets an AC step.
An empty required-step declaration is a configuration error when the owning flow
requires deterministic checks; do not infer obligations from prose.

The proposal adds `RunGateReadiness` with `state` equal to `collecting`,
`not-ready` or `ready`, the checked input identity and `reasons`. Only `ready`
permits an applicable advancing action. The current decision owns this derived
projection; the run DTO exposes it for inspection. Recompute it when its inputs
change and never treat the stored projection as approval authority. Reuse
existing action definitions; do not add a second decision store.

When project policy skips code review, the shared gate projection and published PR MUST disclose "No code review ran" without withholding approval solely for that skip.

Inspection, hold, evidence selection/judgments, review requests and authorized
fix/recovery actions MUST remain usable as appropriate. A `collecting` gate may
gather the visual judgments and reviewer artifacts it still needs. It MUST NOT
appear ready for approval or publication. A human's final approval is not an
implicit proof judgment for every claim. A visual error banner blocks a claim
when ADR-062's required judgment rejects it; artifact validation alone MUST NOT
claim to understand arbitrary pixels.

Within the serialized decision-resolution path, the gateway MUST recompute
readiness against the selected identities immediately before applying the
advancing action. Stale client requests, replay and non-UI RPC callers get the
same refusal and reasons. The decision remains unresolved on refusal. Existing
publication package/freshness checks remain in place. Finalization MUST use the
same prerequisite evaluator so direct finalize/replay paths cannot bypass the
gate. Successful deterministic steps do not bypass those checks.

## Automatic acquisition

After core prepare and target binding, and before dispatch or proof execution,
the gateway MUST reconcile the admitted resources through the existing
`prepareRunPostureForValidation`/posture reconciler and capability registry.
The exact existing entry point may be extended for dispatch; its authority and
ownership do not change. No worker request or operator lease is needed for an
already declared, authorized resource.

1. Consume the selected Goal 3 requirement identities and existing proof plan.
   Resolve only catalog-declared dependencies and slot/target bindings.
2. Acquire in existing dependency order with run ownership. Reuse a matching
   healthy lease; reject ambiguity, a foreign holder, unavailable provider or
   missing authority with the existing structured reason.
3. Require acquired ownership and passing provider health for every required
   resource before worker/proof dispatch. A created lease or exited acquire
   command alone is insufficient.
4. On partial failure, release only leases newly acquired by this operation in
   reverse dependency order, preserving pre-existing valid and foreign leases.
   Retain failed cleanup identities and reasons for reconciliation. Never claim
   stopped when the provider is still running or its state is unknown.
5. Replay and gateway restart reconcile existing owned leases before acquiring
   again. Do not duplicate a provider or rebind to another device. Before a fix
   or validation pass, reacquire resources released at an operator wait.
6. Cancel and terminal cleanup follow the existing transition/posture contracts.
   Gate-held worker retention remains governed by ADR-038. Lease contention
   cannot justify taking a device, killing a holder or widening mutation policy.

Normal acquisition MUST NOT ask the operator to perform the same declaration
manually. A real contention, missing declaration or authorization decision still
needs the corresponding wait/refusal; show the resource, holder and permitted
recovery without exposing credentials.

## Truthful run state

Keep the existing run state machine. Add `fixing`, `review-failed`,
`reconciling` and `needs-decision` where the existing status vocabulary cannot
state the fact. Extend shared active/terminal/settled-blocked helpers in the same
change. `review-failed` is nonterminal and retains recoverable review context.
`needs-decision` is nonterminal, active and not working (ADR-065 Amendment 7).

| Observed facts                                                                                                  | Required state                                                  |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Current structured worker/step operation is progressing                                                         | Existing active state, or `fixing` for a gate correction        |
| Reviewer is executing in its separate session                                                                   | Existing reviewing state with the reviewer role visible         |
| Reviewer exits/fails or finishes without its required result artifact                                           | `review-failed`, with reviewer reason and retry/repair action   |
| Correction request has verified worker acceptance and the turn is active                                        | `fixing`; advancing gate actions unavailable                    |
| Complete prerequisites, worker idle and operator decision pending                                               | `human-gating`, readiness `ready`                               |
| Structured state confirms all operations idle/stopped and a prerequisite/resource failure prevents continuation | `blocked`, with reason                                          |
| Prompt delivery, owned operation or runner activity is uncertain                                                | `reconciling`, advancing actions disabled, worker/slot retained |
| A delivered result: review findings remain and no fix can run, or COMPLETE/FINALIZE was refused                 | `needs-decision`, one result decision, worker/slot retained     |

The gateway MUST derive these transitions from structured runner receipts,
operation identities, step events and validated result artifacts. A process
existing is not proof that a turn progresses; missing a monitor acknowledgment
is not proof that work stopped. Pane text and worker assertions MUST NOT establish
idle, complete or blocked state. A pending human choice uses the gate state,
not blocked. Reviewer failure can coexist with a worker operation: progressing
worker state wins and review failure stays attached to its review record.

Late receipts and recovery MUST update the run through the existing lifecycle
routes so run, backlog/queue/graph and ownership consumers agree. Existing
settled-blocked archive/release guards MUST refuse uncertain or progressing
work. A fix result creates a new review/evidence identity as required by the
owning contracts; it cannot silently reuse the prior ready approval.

### Project-owned scripted command receipts

The runner capability layer MAY establish idle for a completed command-mode task.
It MUST read the current primary task's command result, runner provenance and
terminal signal through the existing slot transport. Their project, command
reference, checkout and task context MUST match the admitted execution. The
provenance MUST be current for dispatch; the result MUST be newer than that
invocation and precede its matching terminal signal. A successful result requires
exit code zero, no signal and no timeout, together with the current monitor's
terminal success receipt. Missing, malformed, stale, mismatched or unsuccessful
evidence MUST remain unproven. Pane text and a worker success signal alone MUST
NOT establish idle.

This observation MUST pass through the existing aggregate run-progress reader,
so another active or uncertain context retains its normal precedence. It MUST NOT
bypass acceptance, evidence, deterministic checks or resource ownership. Scenario
mode and runners without this capability retain their existing observations.

### Waiting for an operator

Accepted by the lead, 2026-10-15, under ADR-065 Amendment 3. ADR-045 remains the terminal-contract owner.

`@farmslot/agent-runtime` exports experimental
`buildOperatorWaitInstructions(taskDir)`. The shared `buildTaskDocument` producer
and the gateway's lightweight interactive TASK writer consume this single
instruction definition. Interactive tasks MUST teach wait and resume in both
document layouts. Harnesses inherit it through task initialization; they add no
instruction copy or writer. This additive SDK helper ships with runtime 0.24.0.

`./mark wait --who <name> --reason <text>` MUST write a nonterminal `running`
signal through the existing atomic, role-owned writer. Its optional
`waitingForOperator` object contains nonempty `who` and `reason` strings and an
ISO `since` timestamp. It MUST retain the context, attempt, checklist events and
unchecked rows. An identical repeated wait MUST retain its original timestamp;
it is not a heartbeat or progress receipt. It MUST refuse a terminal signal.

`./mark resume` MUST clear the wait and preserve the execution attempt and
checklist. `start`, numeric checklist marks and terminal marks MUST also clear
it. Clearing a wait MUST NOT imply completion, a checked row, approval or a new
worker. Existing artifact and terminal-contract checks still apply.

The signal retains closed waits in `operatorWaitIntervals`, ordered nonoverlapping
`{ since, until }` ISO intervals within the signal timestamp and owned attempt.
A new attempt MUST discard the preceding attempt's intervals. The monitor uses
these intervals to recover excluded wait time across restart. Its persisted
`operatorWaitMs` and `operatorResumedAt` are accounting and inactivity clocks,
not worker-progress receipts. A stored `Run.waitingForOperator` MUST be cleared
on load until the monitor revalidates live ownership.
The latest validated interval's `until` MUST restore the inactivity resume clock
even when the worker resumed while the gateway was offline. Re-reading that
interval MUST NOT extend the clock.

The gateway MUST validate shape, freshness, role/context and execution attempt
before accepting a wait. A valid wait is healthy operator dependency, not
making-progress or worker-done. The healthy waiting label and monitoring
suspension also require structured confirmation that the same owned worker is
still live. While both conditions hold the monitor MUST keep observing the
owned signal and worker, retain the worker/slot, and suppress inactivity nudges,
`monitor_max_nudges` and elapsed execution timeout. Worker failure, exit or
uncertain liveness MUST retain existing guarded recovery and MUST NOT remain
labelled healthy on the authority of a stored wait signal alone. Explicit
cancellation and independent resource/credential safety checks remain available.
Wait time MUST be excluded from the monitor's execution timeout, including
across restart. Clearing it starts a fresh inactivity window while retaining
execution time already consumed. A missing, invalid, stale or foreign signal
MUST NOT suspend monitoring; a stored display label is never authority.

The existing run DTO MUST project only the validated wait. The shared lifecycle
view MUST expose `Waiting on operator: <who>` to CLI, Command Center and Companion
while retaining the current nonterminal run status. Terminal settlement removes
the activity label. Waiting MUST NOT satisfy COMPLETE, publish, output review or
any human decision prerequisite.

Acceptance MUST cover mark/resume and repeated-wait idempotence; stale/foreign
signals; monitor nudges and timeout across a restart; resumed monitoring; shared
client labels; and completion/publication remaining guarded. Live acceptance
MUST use the production mark command and monitor with an owned native worker
waiting for an operator, then resume that same execution without a replacement.

## Recovery invariants and six CI scenarios

Restart MUST NOT resume the engine or reconcile the runtime of a `needs-decision`
run; it re-presents the run's result decision (ADR-065 Amendment 7).

Slot re-selection MUST retain the device capabilities of the requested or previously
selected slot. Before `run.replayStep` clears that binding, the gateway records
the available device providers from its configured capability catalog in
`Run.engineState.slotCapabilityRequirements`. This placement intent survives
further replays and is distinct from an authored proof plan or acquisition.
`find-slot` MUST reject candidates whose catalog cannot provide every retained
capability before scoring, explicit or affinity selection, and slot claim. It
MUST retain caller `allowedSlots` filters. The registry remains the capability
availability authority; health penalties and task prose cannot replace this check.
Catalog reads MUST use the retained run's pinned sources, each candidate's
planned node sources, and the admitted sources at claim. If an old slot or
project definition was removed before a snapshot existed, replay MUST preserve
legacy re-selection and infer no missing device requirement. Saved requirements
remain authoritative. Other catalog failures MUST refuse replay and release any
replacement queue claim immediately.

All scenarios use production gateway RPC/engine paths, isolated stores,
temporary checkouts/remotes and controlled structured runtime/transport
fixtures. Observe state and side effects, not just successful return values.
No test starts or kills a real tmux server, calls a paid model, takes a device,
uses stored credentials or edits a runtime checkout. Controlled fixtures are
CI regression evidence; they do not prove real runner acceptance.

| Scenario                    | Trigger and observable success check                                                                                                                                                                                                                                         |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1 Published branch replay  | Replay preparation after publication. Published branch/remote SHA and unique commits survive; unsafe replacement refuses before any destructive branch or runner effect                                                                                                      |
| R2 Release during live work | Release/recovery overlaps a structured active worker or uncertain delivery. Worker, slot and required leases remain owned; release resumes only after verified eligibility, and repeated cleanup is harmless                                                                 |
| R3 Prompt targets a shell   | Dispatch/recovery resolves a shell or foreign session. Shared runner transport rejects before typing; uncertain accepted delivery stays reconciling, and a later exact receipt returns the run to active work without duplicate delivery                                     |
| R4 Stale sandbox            | Replay finds an isolated runtime with stale credential/session identity. Existing credential/readiness checks refuse reuse, owned replacement passes health, declared resources acquire before dispatch, and a partial acquire failure preserves foreign/pre-existing leases |
| R5 Idle branch holder       | A clean idle checkout pins the requested branch. Existing release guard detaches it safely; active, parked or dirty holders remain protected, and published commits survive                                                                                                  |
| R6 Orphan runtime           | An owned orphan runtime prevents slot readiness. Existing provider/process ownership cleanup removes only the owned orphan, preserves an unrelated runtime, and allows replay; failed cleanup leaves an explicit unhealthy/unknown reason                                    |

Reuse existing scenario fixtures and repairs. Each new default test MUST finish
within five seconds; the workspace default/CI suite MUST stay under five minutes.
Use condition-driven completion and teardown every child/server/store. The six
scenarios form a bounded CI entry in the gateway's existing test collection;
there is no platform/runner/target matrix.

Focused contract checks additionally MUST cover each gate refusal and its passing
control, changed-head/package refusal through decision resolution, consistent
web/native/CLI projections, absent reviewer output, a worker progressing despite
a missed acknowledgment, accepted correction state, and acquisition
dependency/rollback/restart ownership. Exercise dev, interactive-dev, fix and QA
flow obligations from the canonical selector without copying templates. These
checks consume the deterministic-step and evidence implementations owned by
their lanes.

Manual live acceptance MUST use real gateway operations and the matching existing
runner-validation scenario. Prove one declared device/runtime acquisition without
an operator lease, safe worker retention, refusal of incomplete AC/evidence or
review output, and a correction pass visible as fixing in both clients. Retain
RPC/state/ownership receipts and visible HUD evidence where supported. Make a
negative control fail before restoring each claimed behavior. No fixture-only
result counts as live acceptance.

## Human publication adoption

**Status:** Accepted under ADR-065 Amendment 2, 2026-10-14, following paired review in #1047.

`run.adoptPublishedPr` records a human-reviewed revision already published outside
the run's normal gate. It MUST NOT create, push, promote, rewrite or comment on a
PR. It MUST NOT force-complete the run, manufacture evidence/review results or
reset review budgets. This operation serves `dev` and `fix-bug` publication runs;
QA, review-only, PR-bound and artifact-only runs MUST be refused.

### Request and verification

The operator CLI is `farmslot run adopt-published-pr <runId> --pr <url>
--head <full-sha> --reason <text> --attest-reviewed-publication`. Its typed request
contains `runId`, `prRef`, `headSha`, a written `reason`, and
`attestReviewedPublication: true`. No client actor identity confers authority.

Reuse the credential-backed person/global-admin authorizer for existing human
attestations. Missing credentials, synthetic loopback identities, services, nodes,
background callers, blank reasons and absent explicit attestation MUST refuse.
The person attests that this exact head was reviewed and its publication was
approved, including any external review used after the pipeline's round cap.

The gateway MUST verify the PR against the run's declared repository and branch,
using retained project/source context without requiring its old slot. The full
supplied commit MUST equal the observed PR head or be verifiably in that PR's
history. In the historical case, record the newer observed head separately;
ancestry does not transfer approval to it. Unavailable or inconsistent GitHub
facts, foreign repositories/branches, unrelated commits and conflicting existing
PR/publication identity MUST refuse before mutation. Another in-flight publication
MUST be reconciled before adoption.

An older frozen package or exhausted internal review budget MUST remain visible.
They MUST NOT be rewritten to match the attested head, counted as external
approvals, or treated as a package approved for that head. The receipt records
their available identities as prior context. Normal gate approval remains subject
to its existing prerequisites.

### Receipt, persistence and lifecycle

`HumanPublicationAdoptionReceipt` MUST retain its schema version, run/generation
identity, trusted approver and credential identifiers, reason, adoption time,
canonical repository/PR URL/number, exact reviewed/published head, observed PR
head/branch and draft state, and available prior gate/package identity.
For active gate adoption it MUST also retain the pending decision identity and
the typed unmet-prerequisite findings from its readiness evaluation. Unavailable
evaluation MUST remain an explicit unknown finding, not an empty passing list.
Derive `published_draft` or `published_ready` from the verified PR state. These
describe publication, not proof that the current PR head or worker is complete.

The existing publication owner MUST durably record the receipt, publication
status and PR linkage together, through the run store and serialized lifecycle
route. Normal publication and adoption MUST share that recorder. Recheck the
run's generation, archival location and publication identity after asynchronous
verification, and reauthorize the person inside the serialized mutation.
Persistence failure MUST leave no published projection or started
continuation. Retries of the same run/repository/PR/head MUST return the first
receipt without recounting publication or changing its approver/time. A different
tuple MUST refuse rather than replace provenance. Surface projection failures
through existing repair/effect reporting.

Archived runs MUST remain archived, with execution status, completion time,
generation, sources, steps, packages and reviews preserved. Adoption MUST NOT
claim a slot, restart an engine/worker, or overwrite a successor's backlog/graph
association. Publish/link projections MUST respect their existing ownership guards.

For active runs, adoption is an explicit authenticated exception to ordinary
publication readiness because the verified PR already exists. Inside the existing
serialized decision-resolution route, it MUST supersede only the pending
`engine_human_gate` publication decision with
`superseded-by-publication-adoption`, retaining that decision and its unmet
prerequisite findings in the receipt. It MUST NOT call the ordinary
`approve-publish` action, relabel its old package approved, leave that publication
decision available for a second approval, or resolve unrelated waits.

Existing post-publication entry points MUST recognize the receipt as fulfilment
of the publication stage. They MUST skip creation, promotion, body/title/media
mutation and old-package approval checks that would repeat that stage. All
unrelated source, progress, resource and continuation guards remain enforced;
publication does not establish worker idle/completion or release ownership.
When these guards prevent continuation, expose that refusal with the PR linkage
retained. Ordinary approval and finalization without an adoption receipt keep
their existing prerequisite evaluator and package-approval requirements.

CI-watch and review-fix target selection MUST use the canonical adopted repository/PR.
Archived history may supply this target to normal follow-up flows, without
replaying or reviving its retired execution.

Adoption grants no evidence/body/title refresh authority. Such operations MUST
have their own package/head authorization and freshness checks; an older frozen
package MUST NOT overwrite a manually published or newer PR. Later commits need
their own reviews and evidence. Existing PR-link repair remains repair of an
already trusted publication, not an unauthenticated adoption fallback.

### Public contract and acceptance

`@farmslot/protocol` owns the request/result/receipt and method registry;
`@farmslot/cli` owns the operator command. `RunAdoptPublishedPrResult` exposes the
retained receipt, canonical PR target, updated active/archived run and existing
effect/continuation refusals. The gateway owns the only verifier and writer.
These additive experimental contracts ship with coordinated minor versions.
Harnesses and existing clients consume the canonical run identity; no new
harness hook, verdict writer or parallel package format is introduced.

Regression coverage MUST exercise authenticated active/archived adoption,
historical head with an older package and exhausted budget, unauthorized callers,
foreign/mismatched PR identity, same-tuple retry, concurrency/persistence refusal,
retained successor ownership, protected QA/evidence, and canonical CI/fix target
selection. Use isolated stores and structured GitHub/runtime fixtures; no real
tmux server or worker. Live acceptance MUST apply the public action to the
retained reported run and real PR at the explicitly attested head, read back the
durable publication/link and preserved execution/package state, and show that
follow-up target resolution uses that PR. A newer PR head MUST remain distinct
from the historical attestation. Never recreate the run for this proof.

The active exhausted-budget case MUST verify that unmet findings are retained,
only its publication wait is superseded, ordinary publication is never invoked,
other waits remain pending and unconfirmed work/ownership stays guarded. Its
post-publication target MUST be the adopted PR without reuse of the older package.

## Pipeline settlement

Pipeline entry and restart recovery MUST use the same step-to-status projection.
A refused COMPLETE or FINALIZE prerequisite ends the pipeline as `needs-decision`
when the run delivered a result, otherwise as `failed`; it MUST NOT leave the run
labelled `completing` after the step stops. This failure alone
MUST NOT release a worker, slot or runtime whose shutdown is unconfirmed.
Dispatch occupancy, orphan cleanup and automatic recovery MUST retain this failed
gate for explicit operator recovery.
Retention follows the slot's current ownership; it MUST NOT make an explicitly
released slot unavailable. Ticket and PR admission retain the unfinished execution
until operator settlement. A linked backlog item and work-graph node observe the
pipeline failure through the existing ordered transition effects.
Restart MUST skip engine startup and runtime reconciliation for this retained
failure, and MUST re-project a `failed` one that delivered a result to
`needs-decision`. Slot release and recycle MUST refuse its slot; only a release that names the
run with `expectedRunId` and passes `forceReset:true` discards it (Amendment 6). A
replay rolling back the claim it took at its own epoch is the only other exception;
a failed replay MUST restore the retained claim it took over rather than release it.
Replay MUST start at the refused step or earlier, refused before any mutation.
A replay from `find-slot` or earlier selects a fresh slot, so it is refused the same
way while the run's slot row still names the run. Any other run replayed from there
MUST release the slot it still holds before dropping its binding; nothing frees a
slot whose owner no longer names it. A release guard that would refuse refuses before
the replay changes the run, and a restart release never bypasses this retention.
Release must confirm the old worker stopped on the slot's machine, so a slot whose
machine is offline stays refused; the refusal names the exits: bring the machine
back, then replay again or make the named discard.
After that explicit discard, archive/delete MAY evict it only when native
bindings and owner capability cleanup are confirmed released. Archive preserves
the failed verdict, step history and evidence; unresolved provider cleanup still
refuses eviction.
QA completion replay MUST accept the same task title or change reference as QA
creation, preserving the existing execution, frozen scope and recorded verdict.

Supersede, force-complete and output close use named ADR-053 transitions. Their
single settled write precedes publication, awaited backlog settlement and graph
scheduling. Resource release stays outside machine/run locks and checks ownership.
Output close MUST persist its settled write successfully before resource release.
Force-complete still refuses QA. Output close preserves the recorded verdict,
step history and evidence, including partial or failed results.

Acknowledging an output snapshot MUST retain a pending close-only action for that
snapshot. Recapture of the same bytes keeps it; changed bytes require a new review.
Acknowledgement does not approve proof, publish work or resume execution.

A `needs-decision` run holds one result decision: send back (needs a review round,
never grants one; after a refused completion, its completion replay), accept
(artifact-only runs after REVIEW; the named `accept-result` transition; a written
reason) and close (the named `close-result` transition). Each records a
result-decision receipt; `metrics.outcome` is unchanged. While the run is held, its
output review keeps its snapshot but its actions MUST be refused; changed bytes
re-present the result decision on the new snapshot and an action on the old one is
refused. `accept-result` resolves the output review as reviewed and `close-result`
as `close-run`, keeping no close-only action. Cancel MUST refuse a held run; the
named discard performs Close.

## Public surface

`run.replayStep` retains device placement intent, and `run.get` exposes the
optional `Run.engineState.slotCapabilityRequirements` snapshot. Its
`RunSlotCapabilityRequirements` type belongs to `@farmslot/protocol`; the gateway
replay and `find-slot` consumers own this internal recovery state. Callers do not
supply new CLI flags or capability acquire inputs. Harnesses continue using the
existing registry proof-plan, health and lease contracts.

| Interface                                                                                              | Owner and named consumers                                                                                                      |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Existing `farmslot run get`, `run gate`, `--action`, `--decision` and machine output                   | `@farmslot/cli`; operators, recovery tooling and CI inspect the same readiness/state DTOs                                      |
| Existing `farmslot recipe artifacts --validate`                                                        | Goal 3 CLI routing and ADR-062 validator; gateway/artifact consumers use the canonical evidence result                         |
| Proposed `RunGateReadiness`, `RunGatePrerequisiteReason`, `RunLifecycleView`, `deriveRunLifecycleView` | `@farmslot/protocol`; gateway, CLI, Command Center and Companion share fields and presentation without a second evidence model |
| Existing `GatewayClient` with extended run/decision DTOs                                               | `@farmslot/sdk`; both clients and downstream integrations inspect and request authorized actions                               |
| Goal 3 declarations and existing provider acquire/health/release callbacks                             | Provider/harness authors declare resources once; gateway posture/registry enforces their use                                   |

The portable lifecycle view MUST select labels, reasons and action availability
from gateway facts. Web/native wrappers only render it; ADR-062's shared review
model retains claim/evidence selection. No additional flag/export is proposed
without these consumers. The shared SDK, wire contracts, schemas and generated
CLI reference MUST match the shipped implementation. Proposed names remain
experimental until conformance and a documented release.

## Migration and acceptance

The approved ADR path inventory governs implementation scope. Integrate merged
dependency contracts before reserving shared implementation paths. Coordinate a
breaking release if state/DTO changes require it. Convert persisted records once;
unknown prerequisite facts remain unknown. Do not leave alias handlers or dual
declaration/evidence writers. Restart reconstructs readiness from its canonical
inputs rather than trusting a stored ready label.

Acceptance requires the six CI scenarios, focused contract checks and live
acceptance above, independent exact-head reviews and green relevant CI. An
approved implementation head is frozen. Documentation approval alone authorizes
none of implementation completion, publication, merging or rollout.

## Current-head publication recovery

**Status:** Accepted (lead, 2026-10-15) under ADR-065 Amendment 4.

The existing package owner MUST reconcile the live owned branch head with the
publication package at review completion, review-fix completion, gate refresh,
gate inspection and approval. Every detected head change MUST prepare a new
current package through the canonical preparation/refresh path. Reuse an
unchanged package idempotently. Unknown head, missing ownership, ongoing work
or failed preparation MUST show collecting/not-ready and refuse publication.

Refresh MUST run under the existing lifecycle/decision coordinator. Recheck the
run generation, ownership, source head and selected evidence after asynchronous
reads and immediately before installing the package/decision. A concurrent
head or evidence change MUST refuse or retry preparation, never install a
package for a mixed snapshot. Persist the current package and decision before
exposing an advancing action; restart reconstructs the same authoritative facts.

Preserve prior packages, review attempts and gate decisions as provenance.
Old-head reviews MUST remain stale. Rebind a review only when its validated
immutable final snapshot matches the new package's review subject under existing
rules. An old decision/package id submitted by a client MUST refuse and show
the refreshed gate; its approval MUST NOT transfer to the replacement package.
Approval rechecks live head, required reviews, deterministic receipts, selected
evidence and package/body identity before any public PR mutation.

An unpublished failed or interrupted run MAY replay review after its actual
source/worker ownership and prerequisites are established. Use the same run,
branch and retained review lineage, with ADR-063's persisted admissions and
extension scope. No replacement run, invented completion, private state edits
or out-of-band result import may establish success. If a recoverable gate lacks
its package reference, canonical preparation MUST reconstruct it from current
owned artifacts before offering publication. A missing source or artifact
remains an explicit refusal; the receipt alone is not evidence of a current pass.

The configured PR-body renderer MUST consume the existing canonical evidence
declaration and selected recording. The artifacts owner uploads declared media,
and the shared renderer embeds hosted per-AC before/after `<img>` tables and the
video link. Missing or stale selected media MUST remain an explicit gap under
the owning evidence policy; no fabricated baseline or sibling-run media may
fill it. The package and published body MUST retain the selected evidence
identity. Terminal consumes the same renderer/declaration as Mobile, with no
parallel template, uploader or publication path.

Validation MUST cover fix/Bugbot head changes, stale approval requests, refresh
races and restart, an absent pending-package reference, same-run failed-review
replay after a bounded budget extension, and current-head required reviews.
Live acceptance MUST publish the original run through its gate, verify its
linked PR head and hosted per-AC images/video, and retain all earlier attempts.
No hand-created PR or adoption may substitute for that publication receipt.

## Adopted publication evidence delivery

**Status:** Accepted under ADR-065 Amendment 5, 2026-10-16. Delivery requires the
implementation PR; the person-only adoption restrictions remain unchanged.

`run.refreshPublishedEvidence` MAY deliver retained media for an adopted
publication under its existing scoped authorization for run mutations. Adoption itself
remains person-only. This operation MUST NOT impersonate the adopter or treat
their code-publication attestation as a new review or evidence verdict.

### Binding and selection

- Resolve the same active or archived run through the canonical store. Refuse
  imported/read-only records, nonterminal execution or an active task.
- Require the immutable adoption receipt, its recorded prior decision/package
  identity and the matching retained frozen package. Validate its hash and
  evidence manifest through the existing owners. Missing identity or bytes
  MUST refuse; do not prepare a replacement package or widen its selection.
- Deliver only media selected in that package, or a requested subset under the
  existing selection rules. Validate original bytes and provenance. A package
  from an older head MAY supply historical media, but its head and known capture
  identities MUST remain visible separately from the attested PR head. Unknown
  provenance remains unknown; no current-head pass, coverage or baseline is
  inferred. Existing evidence-policy refusals remain enforced.
- The live repository, PR and branch MUST match the receipt, and the live head
  MUST equal `receipt.headSha`, not `observedHeadSha`.
  Historical adoption does not authorize writing to an advanced head. Refuse
  unknown identity and closed-unmerged PRs before media delivery.

### Mutation and persistence

Use the current PR body as the base. Extend the shared renderer to append a
run-specific delimited evidence/provenance block. Replace it only when its bytes
match this run's last recorded farm delivery; edited or unproven markers MUST
refuse. A template heading alone establishes no ownership. Human media under
existing evidence headings and all text outside the owned block MUST survive
byte-for-byte. Body-wide sanitization and whole-body LLM rewriting are forbidden
in this operation; existing rendering may process only the owned block.

This supplies the separate package/head authorization and freshness checks
required by the accepted adoption contract. It does not authorize restoring an
older draft body or changing source, title, publication state, review budget,
verdicts or frozen QA.

Serialize through the existing lifecycle owner. Recheck the generation, receipt,
archive location, frozen selection and live head/body after asynchronous work
and immediately before editing the body. Observed drift MUST refuse without
replaying a worker, gate or publication action. Retain already uploaded artifacts
on refusal; never invent successful delivery or silently retry a public write.

Extend the description recorder through archive-capable `commitRunPublication`,
retaining the adoption and package identities. Derive the body hash from the
recorded body; no new protocol field is required. Archived records MUST
stay archived with status, completion time, generation and successor ownership
preserved. Repeated refreshes MUST replace the owned section without duplicating
it or changing the original adoption/package receipt.

### Public contract and acceptance

Keep `RunRefreshPublishedEvidenceParams` and `RunRefreshPublishedEvidenceResult`
compatible. The existing raw RPC CLI is the operator consumer; harnesses inherit
the common uploader and renderer with no new hook or parallel writer.

Regression and public-RPC proof MUST cover exact-head and historical-package
delivery, subset selection, source labels, changed/missing media, foreign or
advanced PR heads, concurrent body/head changes, idempotent rendering and
archived persistence. Human media inside template evidence headings and relative
links elsewhere MUST survive unchanged; an edited or unproven farm marker MUST
refuse. Assert original receipts, packages, QA and execution state remain
unchanged. Use a fixture person for adoption setup, never a real person's
credential held by automation.
