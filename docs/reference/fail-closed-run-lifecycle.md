# Fail-closed run lifecycle

**Status:** Proposed normative specification for [ADR-065](../adr/065-fail-closed-run-lifecycle.md).
**Owner:** Farmslot maintainers.
**Scope:** Gateway enforcement over existing evidence, review, runtime and runner contracts.

MUST and MUST NOT are requirements for the proposed implementation, not claims
about current behavior. Keep this specification with ADR-065 until acceptance
and implementation. ADR-062 and ADR-063 own the referenced evidence/review rules.

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

Keep the existing run state machine. Add `fixing`, `review-failed` and
`reconciling` where the existing status vocabulary cannot state the fact.
Extend shared active/terminal/settled-blocked helpers in the same change.
`review-failed` is nonterminal and retains recoverable review context.

| Observed facts                                                                                                  | Required state                                                  |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Current structured worker/step operation is progressing                                                         | Existing active state, or `fixing` for a gate correction        |
| Reviewer is executing in its separate session                                                                   | Existing reviewing state with the reviewer role visible         |
| Reviewer exits/fails or finishes without its required result artifact                                           | `review-failed`, with reviewer reason and retry/repair action   |
| Correction request has verified worker acceptance and the turn is active                                        | `fixing`; advancing gate actions unavailable                    |
| Complete prerequisites, worker idle and operator decision pending                                               | `human-gating`, readiness `ready`                               |
| Structured state confirms all operations idle/stopped and a prerequisite/resource failure prevents continuation | `blocked`, with reason                                          |
| Prompt delivery, owned operation or runner activity is uncertain                                                | `reconciling`, advancing actions disabled, worker/slot retained |

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

## Recovery invariants and six CI scenarios

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

## Public surface

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
