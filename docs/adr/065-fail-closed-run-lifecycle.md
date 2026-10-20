# ADR-065: Fail-closed run lifecycle

**Status:** Accepted
**Date:** 2026-10-12
**Owner:** Farmslot maintainers
**Scope:** Gateway gate prerequisites, recovery, declared-resource acquisition and run state
**Related:** [ADR-037](037-prepare-profiles.md), [ADR-038](038-gate-held-worker-session.md), [ADR-049](049-agent-execution-template-selection.md), [ADR-053](053-run-lifecycle-transition-routing.md), [ADR-054](054-run-resource-posture.md), [ADR-057](057-structured-runner-transports.md), ADR-062 recorded run evidence, ADR-063 review modes
**Specification:** [Fail-closed run lifecycle](../reference/fail-closed-run-lifecycle.md)

## Context

Recovery can destroy a published branch, stop an active worker, deliver a prompt
to a shell, reuse stale runtime credentials, leave an idle checkout holding a
branch, or strand an orphan runtime. Existing repairs need regression coverage.
They do not justify another lifecycle or resource manager.

Gate actions can appear available despite unassessed acceptance criteria,
incomplete evidence or missing reviewer output. Template instructions cannot
enforce these requirements. A run can also report blocked while work continues,
or show a human gate while the worker fixes review findings.

## Alternatives considered

- Template instructions only. Rejected because prompts cannot prevent gateway
  advancement when required results or evidence are missing.
- A new lifecycle or resource manager. Rejected because existing lifecycle
  routes, the posture reconciler and capability registry already own this work.
- Per-client gate logic. Rejected because clients could disagree and RPC callers
  could bypass their checks. The gateway must enforce one set of prerequisites.

## Decision

The gateway enforces prerequisites before offering advancement and checks them
again when resolving a decision. It requires successful declared deterministic
steps, a complete registered AC ledger, valid evidence under ADR-062, and the
required ADR-063 reviewer result artifacts for the selected revision. Unknown,
missing, stale and failed prerequisites prevent advancement. Both clients show
the gateway's reasons and progress through one shared presentation contract. When project policy skips code review, the gate and published PR disclose "No code review ran" without blocking approval (lead, 2026-10-16).
Inspection, evidence judgments, hold and authorized recovery remain available
while prerequisites are incomplete. Collecting reviews is distinct from a gate
ready for approval; prerequisite checks must not prevent the reviews needed to
complete those prerequisites.

Consume ADR-062's package validator, ledger and review model. Consume ADR-063's
review identity, eligibility and exact-head results. Neither contract is
redefined here. Successful validation cannot detect an arbitrary error banner in
pixels; visual claims still need the judgment ADR-062 requires.

Acquire a task's declared device and runtime resources automatically after core
prepare and before dispatch, and reacquire them before validation or a fix pass
that needs them. Consume the project recipe contract's resolved requirements and existing target,
proof-plan and provider contracts. Reuse the capability registry and posture
reconciler. No new requirement syntax, resource picker, provider or lease store
is introduced. Preview stays read-only; acquisition cannot steal a foreign lease
or grant mutation authority. This work starts only after the project recipe declaration
contract merges.

Structured operation and runner receipts determine progress. `blocked` requires
confirmed absence of progressing work. Uncertain delivery remains reconciling;
a missing reviewer result is `review-failed`; an acknowledged worker correction
is `fixing`. Gateway state and client labels agree. Preserve the live worker and
its slot until existing ownership rules permit release.

Add six bounded recovery scenarios in CI, covering published-branch replay,
live-worker release, shell delivery refusal, stale-runtime recovery, idle branch
contention and orphan-runtime cleanup. Use production gateway paths, temporary
Git repositories and controlled provider/transport fixtures. These are regression
checks; separate live acceptance proves actual runner and device behavior.

## Public surface

- CLI consumers use existing `farmslot run get <runId>`, `farmslot run gate
<runId>` and its `--action`/`--decision` options. Their normal and machine
  output expose prerequisite reasons and truthful state. Existing
  `farmslot recipe artifacts --validate` consumes ADR-062; no parallel recipe
  command or bypass flag is added.
- `@farmslot/protocol` owns proposed `RunGateReadiness`,
  `RunGatePrerequisiteReason`, `RunLifecycleView` and `deriveRunLifecycleView`.
  Gateway RPCs, the CLI, Command Center and Companion consume these exports.
  Extend existing run/decision DTOs and state helpers rather than introducing a
  separate status API. `@farmslot/sdk`'s existing `GatewayClient` reads those DTOs
  and resolves decisions; it gains no local approval authority.
- ADR-062 owns its evidence SDK exports. ADR-063 owns its review exports.
  ADR-068 owns `RecipeFlowRequirements`, `recipeFlowRequirements` and target
  resolution. Proposed names do not imply that these dependencies have shipped.
- Downstream harnesses declare project/provider requirements through ADR-068 and
  implement the existing provider acquire, health and release extension points.
  They inherit prerequisite checks, acquisition, ownership, state and recovery.
  They do not implement another gate validator or resource manager.
- New DTO fields and statuses remain proposed until approved and released.
  Coordinate protocol, gateway, node, SDK and client versions. An incompatible
  change requires a breaking release and one-time persisted-data migration.
  Historical records retain their provenance; missing facts never become passes.

## Security and data handling

Apply existing gateway authorization, target scoping and runner ownership on
every mutation. Recheck identity inside the serialized decision-resolution path.
Recovery uses owned process and lease identities, never a broad kill or branch
reset. Credentials stay in the existing secret store and isolated runtime
environment. Public reasons contain safe artifact identifiers, not secrets or
private paths. Acquisition does not authorize funding, resets or external writes.

## Consequences

- Incomplete work stays inspectable with a reason for each prevented action.
- Replay and cleanup keep published commits, active workers and foreign resources.
- Workers can use declared resources without requesting an operator lease.
- Stale and uncertain records may require recovery before advancement. This is
  preferable to treating absent evidence as success.
- Integration waits for the owning contracts. Shared files require a recorded
  ownership handoff before implementation.

## Delivery status

This design is Accepted. Delivery is incremental; acceptance does not certify all lifecycle paths. The [implementation plan](../plans/fail-closed-run-lifecycle.md) tracks the remaining integration and scenario gates.

## Non-goals

- Another declaration schema, lease manager, recorder, reviewer policy or picker.
- Reimplementing deterministic steps or copying template instructions.
- Guessing visual correctness from artifact existence or transport success.
- Destructive automatic recovery, operator lease stealing or global process cleanup.
- A new workflow engine, combinatorial test matrix or fleet deployment before approval.

## Amendment 1: scripted command completion, 2026-10-14

**Status:** Accepted by the lead, 2026-10-14. Delivery is included in
[PR #1035](https://github.com/deeeed/farmslot/pull/1035), with paired review required.

The runner capability layer may establish idle for a project-owned scripted
command from its current task's structured execution receipt. The command result,
runner provenance and terminal signal must agree with the admitted command,
project, checkout and current dispatch. Missing, stale, mismatched, failed or
incomplete receipts remain unproven. A worker success assertion alone cannot
establish idle. Other active contexts still prevent completion.

This repairs command-mode completion under the existing lifecycle gate. It does
not approve task acceptance or evidence, change scenario-mode execution, or add
a completion bypass. Existing gate prerequisites and resource ownership remain
authoritative.

### Public surface

`@farmslot/gateway` owns the internal `RunnerDefinition.taskProgress` capability
and `readRunnerTaskProgress` adapter, consumed by `readRunProgress`. Existing
run, gate and replay RPCs and their CLI clients inherit the result. No public DTO,
SDK export, command or flag changes. Harnesses keep using their declared project
command references and existing task artifacts. The internal adapter ships with
the gateway revision and has no independent compatibility contract.

## Amendment 2: attested human publication adoption, 2026-10-14

**Status:** Accepted, 2026-10-14. Maintainer accepted the paired-reviewed amendment in #1047 at `e596473a18c1f26e82668b97d101cf48adab734a`.
**Specification:** [Human publication adoption](../reference/fail-closed-run-lifecycle.md#human-publication-adoption).
**Implementation:** [#1048](https://github.com/deeeed/farmslot/pull/1048).

### Decision

Allow a credential-backed person with the existing human-attestation authority
to adopt an already published PR for a run. Verify the repository, branch and
exact human-reviewed commit through GitHub. Record the trusted person, written
reason, reviewed/published head and observed PR identity in existing run
provenance, then link the PR through the canonical publication owner.

This records an external publication fact. It neither publishes code nor grants
the run a fabricated passing review, completed worker, reset review budget or
approved evidence package. Preserve the original gate/package and review
history when they describe an older revision. An advanced PR may be adopted for
its verified historical head; approval does not extend to its newer commits.

The operation supports active and archived publication runs. Archive adoption
keeps the record archived and its execution status unchanged. It must not revive
the worker, take its old slot or replace a successor's backlog/graph ownership.
For an active run, adoption is an explicit authenticated exception to normal
publication readiness for an already fulfilled publication wait. The serialized
decision resolver records unmet prerequisites and supersedes only that publish
decision. Other waits and worker/resource guards remain intact. Finalization
recognizes the verified external publication without publishing the old package;
CI and review-fix use the adopted PR target. Ordinary publication still requires
its normal readiness and package approval.

### Rationale and consequences

An operator can publish a reviewed revision after the internal review budget is
exhausted. PR discovery cannot authorize publication, while force-completion
marks execution terminal and disables normal recovery without recording the
publication. A distinct, authenticated receipt preserves both the external fact
and the original incomplete pipeline. CI and review-fix consumers use the linked
PR; current-head checks remain authoritative for later work.

Normal publication and adoption share one publication recorder. Existing
evidence/review writers, frozen package formats and slot cleanup remain unchanged.
Adoption does not authorize editing PR content or reusing an older package for a
newer head. Exact retries retain the first receipt; conflicting adoption refuses.

### Public surface

- `farmslot run adopt-published-pr <runId> --pr <url> --head <full-sha>
--reason <text> --attest-reviewed-publication` is the operator CLI consumer.
- `run.adoptPublishedPr` and proposed `RunAdoptPublishedPrParams`,
  `RunAdoptPublishedPrResult`, and `HumanPublicationAdoptionReceipt` belong to
  `@farmslot/protocol`. The CLI and existing gateway-client RPC transport consume
  them; the gateway owns verification, authorization and persistence.
- These are additive experimental contracts, versioned with protocol and CLI
  minor releases after implementation. Consumers must check method support.
  Existing readers tolerate the optional receipt without changing old records.
- Harnesses inherit the published PR identity through normal run/CI/follow-up
  APIs. They add no recorder, recipe action, hook or local publication authority.

## Amendment 3: explicit operator wait, 2026-10-15

**Status:** Accepted by lead, 2026-10-15, after paired review at `918415164e639f4a7c0a751cd04a7ee96353b825`.
**Specification:** [Waiting for an operator](../reference/fail-closed-run-lifecycle.md#waiting-for-an-operator).
**Related:** [ADR-045](045-worker-terminal-contract.md).

### Decision

A worker may declare a nonterminal wait for a named operator through the existing
task signal writer. The gateway validates the signal against its current worker
context and projects it into the shared lifecycle view. The execution keeps its
current run status, worker and slot. The view says `Waiting on operator: <who>`.

A validated wait suspends inactivity nudges, their escalation and the monitor's
elapsed execution timeout only while structured observation confirms the same
owned worker remains live. It does not count as worker progress. Worker failure,
exit and uncertain liveness retain existing guarded recovery. The existing
monitor continues observing signals and cancellation. Resumed marks clear the
wait; normal monitoring resumes with a fresh inactivity window and the remaining
execution timeout. Restart reconstructs the wait from the same owned signal.

### Rationale and consequences

Interactive work can correctly stop at an approach gate until a person responds.
An idle native turn alone cannot distinguish this from a stuck worker. An
explicit, owned signal records the dependency without ending execution or
inventing progress. Missing, stale or foreign signals retain normal monitoring.
Waiting grants no gate approval, completion, publication or resource authority.

### Public surface

- `@farmslot/agent-runtime` adds `./mark wait --who <name> --reason <text>` and
  `./mark resume`. Interactive task workers consume both. Numeric checklist
  marks, `start` and terminal marks also clear the wait without ticking an extra
  checklist row or rewriting evidence.
- `@farmslot/protocol` owns `WorkerOperatorWait` and optional
  `WorkerSignal.waitingForOperator` and `Run.waitingForOperator`. The existing
  task watcher and monitor validate/project the signal. `deriveRunLifecycleView`
  supplies the activity label to the CLI, Command Center and Companion.
- These additive experimental contracts ship through coordinated runtime,
  protocol, gateway and client releases. Older records with no wait field keep
  their existing meaning. Harnesses use the shared mark command and signal
  contract; no new recipe action, heartbeat or local monitor is introduced.

## Amendment 4: current-head publication recovery, 2026-10-15

**Status:** Accepted (lead, 2026-10-15).
**Specification:** [Current-head publication recovery](../reference/fail-closed-run-lifecycle.md#current-head-publication-recovery).
**Related:** ADR-063 Amendment 1; ADR-038's gate-held publication contract.

### Decision

Publication stays in the original run. Whenever its owned branch head changes,
the canonical package owner refreshes the publication package and gate from
current source, deterministic receipts and selected recorded evidence. The
previous package, reviews and decision remain historical provenance. Approval
of a superseded package cannot authorize the replacement.

Supported review replay on an unpublished run uses the existing lifecycle owner
and ADR-063's recorded budget, including approved extensions. Missing package
references are repaired by canonical preparation from owned source and artifacts,
never by fabricating a passing step, terminal state or adopted publication.

The publication body uses the project's configured shared renderer and evidence
declaration. Its per-AC before/after images and selected recording video are
uploaded through the existing artifacts owner and embedded by that renderer.
Terminal and Mobile consume one definition. Public PR mutation occurs only
after the current gate's explicit Approve Publish action passes all checks.

### Rationale and consequences

An old package can survive review fixes or a later push, making an otherwise
reviewed run impossible to publish. Refresh must retain strict source/review
binding while keeping the supported gate usable. Human publication adoption
remains an external-fact recovery operation; it is not the publication workflow.
Head uncertainty or failed preparation keeps the run non-publishable and exposes
the existing recovery action without discarding earlier evidence.

### Public surface

- Existing `run.replayStep`, `run.refreshPublishPackage`, run/gate inspection and
  `run.resolveDecision` are the CLI, Command Center and Companion consumers.
  Extend these owners; add no parallel publish or package-refresh command.
- `@farmslot/protocol` retains package, readiness and gate DTO ownership.
  Changes are additive and versioned with protocol/runtime consumers.
- Harnesses provide their existing PR-body renderer and evidence declaration.
  They inherit media upload and publication enforcement; no second template,
  adoption action, direct PR creation or review-result importer is added.

## Amendment 5: evidence delivery after human publication adoption, 2026-10-15

**Status:** Accepted for implementation under the lead continuation, 2026-10-16, after paired R2 approval at `62e73a1a486ed5454fe272b6116a8bef8120e229`.
**Specification:** [Adopted publication evidence delivery](../reference/fail-closed-run-lifecycle.md#adopted-publication-evidence-delivery).

### Decision

Extend the existing published-evidence refresh owner to adopted publications.
This grants limited authority to deliver media under the existing authorization
for run mutations, separately from Amendment 2's person-only adoption authority.
Bind delivery to the receipt's repository, PR and exact attested head, and to
the frozen package identity recorded at adoption. Only its previously selected,
integrity-checked media may be delivered.

Keep an older package and its evidence provenance historical. Display its head
separately from the attested publication head; never promote old or unknown
evidence into a passing result for that head. The shared renderer appends a
delimited block owned by this run and replaces it only when it still matches the
last recorded farm delivery. Human sections and links remain unchanged. This is
the separate package/head authorization required by Amendment 2, not permission
to overwrite the manually published body. Code, title, publication state,
reviews and frozen QA stay unchanged.

### Rationale and consequences

Adoption currently blocks all evidence refresh, leaving retained media stranded
after a human publishes the reviewed code. An exception bound to that head fixes
that gap while preserving the incomplete or older pipeline. Active and archived
records use the same owner; archive location and execution state stay unchanged.
Missing retained authority or observed head/body changes refuse explicitly.

### Public surface

- Reuse `run.refreshPublishedEvidence` and its existing `@farmslot/protocol`
  request/result. The operator consumer is `farmslot rpc
run.refreshPublishedEvidence '{"runId":"<run-id>"}'`.
- The gateway owns authorization, freshness, media delivery and persistence.
  Existing run/decision readers consume the recorded description. No new CLI
  command, protocol field, package format or harness hook is introduced.
- This additive experimental eligibility change ships with the gateway. The
  person-only adoption contract and normal publication approval remain intact.

## Amendment 6: retained completion slot release, 2026-10-17

**Status:** Accepted (lead, 2026-10-17), approved at `2e5cd7a53822c91c0d7c12ddf48d1af30ede56de` after paired review.
**Specification:** [Pipeline settlement](../reference/fail-closed-run-lifecycle.md#pipeline-settlement).

### Decision

A run whose COMPLETE or FINALIZE prerequisite was refused is terminal `failed`
but keeps its slot and checkout for a completion replay. `slot.release` and
`slot.recycle` refuse that slot. Only a `slot.release` that names the run in
`expectedRunId` and passes `forceReset:true` discards it. Replaying the completion,
or force-completing a non-QA run, settles the run and lifts the refusal. A replay
must start at the refused step or earlier, because a later-step retry would mark
the refusal done and drop the retention. A replay undoing its own epoch-pinned
claim may still release it; a failed replay restores the retained claim it took
over instead of releasing it.

### Rationale and consequences

The owner guard refused only non-terminal runs. A QA worker released its own
slot after the refused completion turned the run `failed`. The checkout was then
gone, so a later completion replay could not validate the deterministic receipt
or confirm the runner idle. Cancel refuses terminal runs and archive requires
the slot released first, so the named force discard is the explicit operator
exit. It reuses the existing discard form for a slot held by a missing run.

### Public surface

- No new RPC, protocol field or CLI command. `slot.release` and `slot.recycle`
  gain one refusal whose message names the replay and discard routes, and
  `run.replayStep` refuses a target after the refused step. The orphaned-slot
  recovery card no longer proposes releasing such a slot.
- Archive and delete of such a run still require the slot released first; that
  release is now the named force discard.

## Amendment 7: a delivered result that is not accepted needs a decision, 2026-10-18

**Status:** Accepted (owner and lead, 2026-10-18), approved at `2ddaab1f37e1ed1a628da480c96c907eb5df7ec2` after paired review.
**Trigger:** runs whose worker delivered a result still end `failed`. Examples: 8cff6e80 (review findings left when no further fix could run) and 3e2f400a (refused QA completion).
**Specification:** on acceptance, [Truthful run state](../reference/fail-closed-run-lifecycle.md#truthful-run-state), [Recovery invariants](../reference/fail-closed-run-lifecycle.md#recovery-invariants-and-six-ci-scenarios) (restart of a held run) and [Pipeline settlement](../reference/fail-closed-run-lifecycle.md#pipeline-settlement) (including the output-review close-only and changed-bytes rules) are updated to match.
**Changes:** Amendment 6 labels every refused completion `failed`. Under this amendment, a refused completion that delivered a result ends `needs-decision`; one that did not stays `failed` under Amendment 6, unchanged.

### Decision

**Delivered result.** One predicate decides `needs-decision` versus `failed`, both
when a refusal happens and when a run is re-projected on restart. A run has a
delivered result when all of these recorded facts hold:

- `steps.monitor.outputs.workerSignal.status` is `complete` or `done`;
- when `completionVerificationMode(run)` is `push` or `commit`,
  `steps.monitor.outputs.pushVerification.verified` is true (for `none`, such as
  QA, the signal and the capture decide);
- `run.output` was captured, with a `manifestDigest` and no `captureError`.

The delivered head is `steps.review.outputs.reviewSnapshot.headSha` when a review
ran. Otherwise the decision shows the captured report, `output.reportPath`; a QA
run has no branch head.

**When it applies, and precedence.** Each case is decided at the step where the
run stops:

| Where the run stops                                                                                                                | Delivered result | Status                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| REVIEW: the reviewer returned no result                                                                                            | either           | `review-failed` (unchanged)                                                                                                       |
| REVIEW: the review returned issues and no further fix can run (fix attempts used, review budget spent, or the fix relaunch failed) | yes              | `needs-decision`                                                                                                                  |
| REVIEW: the same                                                                                                                   | no               | `failed` (unchanged)                                                                                                              |
| Publish gate, including a budget spent at the gate                                                                                 | either           | existing gate decision (`human-gating` or held `blocked`), unchanged. `needs-decision` never applies once a gate decision exists. |
| COMPLETE or FINALIZE prerequisite refused                                                                                          | yes              | `needs-decision`                                                                                                                  |
| COMPLETE or FINALIZE prerequisite refused                                                                                          | no               | `failed` under Amendment 6 (unchanged)                                                                                            |
| Worker failed, exited or blocked before delivering                                                                                 | no               | unchanged                                                                                                                         |

`needs-decision` is nonterminal. It holds one result decision showing the
reason, the findings or the refused prerequisite, and the delivered head or
report. Its actions:

- **Send back for another fix.**
  - After REVIEW, it resumes the review-fix loop and needs an available review
    round. It never grants one. When the budget is spent, the action is shown
    unavailable and names `run.extendReviewBudget` (ADR-063 Amendment 1, admin
    only). Once a grant exists it becomes available.
  - After a refused completion, it is the existing completion replay from the
    refused step (Amendment 6), once the prerequisite is fixed.
- **Accept.** Offered only after REVIEW, and only on an artifact-only run, such
  as a comparison lane or eval. It settles `done` through a new named ADR-053
  transition, `accept-result`. A refused completion prerequisite cannot be
  accepted away.
  - On a publishing run, Accept is shown unavailable with the reason. The
    publish gate does not offer publication while review findings remain at
    the delivered head (`review-fix-required` has no override), so an accepted
    result could not be published. Its exits are Send back and Close; this
    amendment does not change the gate.
- **Close.** Settles `done` through a new named ADR-053 transition,
  `close-result`, without accepting the result. This is not output-close, whose
  eligibility rules differ. For a retained refused completion, Close is the
  Amendment 6 named discard and releases the slot the same way.

**Output review.** An artifact-only run that captured a report keeps its
output-review decision (`engine_output_review`) as the carrier of that snapshot.
Claim overrides and visual judgments still bind to it, and the completion replay
reads it as today; no gate reader changes.

- While the run is held, the output review's Close run and Mark reviewed actions
  are hidden, so the result decision is the run's only actionable decision.
- The result decision shows the current output review's snapshot. A recapture
  follows the existing rule. The same bytes keep the output review and the result
  decision. Changed bytes replace the output review, the result decision is
  re-presented on the new snapshot, and an action taken on the old snapshot is
  refused as stale.
- `close-result` resolves the output review as `close-run`.
- `accept-result` resolves it as reviewed by the accepting principal. No
  close-only action is kept, because the run is already settled.
- Send back leaves it pending; its actions show again once the run leaves
  `needs-decision`.

Every action records a result-decision receipt on the run: action, principal,
written reason, time, delivered head or report, and a digest of the findings.
`metrics.outcome` keeps the worker's recorded verdict. Actions resolve under
the serialized decision path; a stale or repeated action is refused.

**What each settlement means downstream.**

- An **accepted artifact-only result** counts as success: `isSuccessfulRun`
  reads the acceptance receipt, the backlog item closes, the work-graph family
  outcome is `success`, family readiness counts it as succeeded, and analytics
  record "accepted with findings", not a failure.
- A **closed result** is terminal but not a success: the backlog item returns
  to needs-attention, the family outcome is `partial`, and analytics record
  "closed, not accepted", not a failure.
- **While `needs-decision`**, the run counts as active in run lists, family views
  and work-graph edges, as a retained refused completion does today, and
  analytics do not count it as a failure.

**Exits and guards.**

- `run.cancel` refuses a `needs-decision` run and names the three actions. The
  slot-release refusal for its slot names the pending decision rather than
  cancel.
- The Amendment 6 named discard performs Close.
- Archive and delete wait until the decision settles.
- One protocol helper, `isHeldForResultDecision(run)`, is true for every
  `needs-decision` run, whatever step it stopped at. Restart, automatic
  recovery, dispatch occupancy and orphan cleanup key on it.
- On restart, startup recovery skips engine startup and runtime reconciliation
  for every such run and re-presents its result decision. It never resumes the
  engine at REVIEW or the refused step; only Send back does that.
- Every guard that Amendment 6 keys on a refused step accepts `needs-decision`
  as well as `failed`: replay from the refused step or earlier, the restart
  release refusal, the restart engine skip, dispatch occupancy, orphan cleanup
  and automatic recovery. These guards check status alongside the refused step.
- After REVIEW, the run keeps its worker branch, checkout and slot under the
  ADR-054 operator-wait boundary until it is decided.

### Rationale and consequences

Operators see `failed` on runs whose worker did the work, but whose review or
gate was not satisfied. `failed` hides that a usable result exists and that a
person has a choice. It also counts these runs as failures in failure rates and
retrospectives.

Three alternatives were rejected:

- **Reuse `blocked`.** It means idle work that cannot continue, with different
  exits.
- **Reuse `human-gating`.** It means the prerequisites are complete.
- **Keep `failed` with a decision attached.** The status is what people read.

The publish gate keeps its own decision, and a held run's output review has no
actions of its own, so a run never has two actionable decisions. A refused completion without a delivered result keeps Amendment 6's
`failed` retention exactly. So `isCompletionPrerequisiteFailure` and
`isSettledCompletionFailure` stay; they gain the `needs-decision` case.

The cost:

- a new status every client must show;
- slots held while a decision is pending, including several comparison lanes
  until someone decides;
- one coordinated protocol, gateway and client release.

Runs already recorded `failed` keep their status, except that restart
re-projects a retained refused completion with the same delivered-result
predicate.

### Public surface

- `@farmslot/protocol`:
  - `RunStatus` gains `needs-decision`, nonterminal and not counted as working;
  - `RunDecisionPayload` gains kind `result-decision`, with reason, findings,
    delivered head or report, and the three actions with their availability and
    reasons;
  - a result-decision receipt field;
  - `hasDeliveredResult(run)` and `isHeldForResultDecision(run)` helpers; the
    output-review decision's actions are unavailable while a run is held;
  - `RunAnalyticsRecord` gains the result decision (`accepted` or `closed`),
    with an `ANALYTICS_RECORD_SCHEMA_VERSION` bump; neither counts in
    `failureByStep` or `failureByReason`;
  - `isSuccessfulRun`, `isActiveListRun`, the terminal and settled helpers, and
    the refused-completion helpers are updated in the same change;
  - `deriveRunLifecycleView` labels the status "Needs decision".
- The gateway adds the named ADR-053 transitions `accept-result` and
  `close-result`, and routes the REVIEW and COMPLETE/FINALIZE refusals through
  them. Actions resolve through the existing `run.resolveDecision`. No new RPC is
  added; extensions stay with `run.extendReviewBudget`.
- `farmslot run get` and `farmslot run gate --action`, Command Center and
  Companion show the findings and actions through the shared view.
- Compatibility: client builds older than this release show a blank status
  badge in the working tone for `needs-decision`, because `deriveRunLifecycleView`
  has no label for it there. So the gateway, CLI, Command Center and Companion
  ship together, and Companion users must update. There is no persisted data
  migration beyond the restart re-projection.

## Amendment 8: accepting review findings at publication, 2026-10-20

**Status:** Proposed.
**Related:** Amendments 2 and 7, [ADR-063](063-review-modes-warm-cold.md) Amendment 4, [ADR-062](062-recorded-run-evidence.md) Amendments 3 and 18.
**Specification:** [Gate prerequisites](../reference/fail-closed-run-lifecycle.md#gate-prerequisites).

### Decision

"Accept Review Findings and Publish" (`approve-publish-unresolved`) publishes the
package head while review findings at that head remain open. Only a person with
the human-attestation authority of ADR-062 Amendment 3 may take it, with a
written reason (non-empty after trimming, the rule evidence attestation uses).
Service, node and unauthenticated callers never can. This narrows the action:
today any principal may use it where it applies.

It yields exactly the review prerequisites `review-fix-required` and
`review-result-required`. Every other prerequisite still blocks it, including
`review-result-invalid`, `review-document-missing`, deterministic steps, the AC
ledger, evidence and lifecycle. Post-publication CI is unchanged. It is
available only when all of these hold:

- the package's required number of reviews returned a valid structured result
  (verdict `pass` or `issues`) for the prepared package, under the existing
  session and freshness checks;
- at least one finding is open at the package head;
- no fix or review is in progress.

It is available whether or not a review round remains, alongside Continue
Fixing, and it does not combine with evidence attestation. Accepted findings do
not certify ADR-062 Amendment 18 `review`-mode criteria, so a run with such a
criterion and an open finding stays refused.

The decision's publication approval records the reason, the package head, the
approver as evidence attestation records it, and the accepted findings. For each
finding it keeps the review id and the finding as the review recorded it (file,
line, description), plus one digest of the accepted set. Resolve refuses when the
findings at the head differ from that set. The acceptance binds to that head
only. The published PR body discloses the accepted findings and the reason, as
ADR-062 Amendment 3 does for waivers. Normal Approve Publish is unchanged:
findings at the package head still block it (ADR-063 Amendment 4).

One shared protocol rule decides availability. The gateway applies it when it
lists gate actions and when it resolves, and the CLI, Command Center and
Companion apply it to their listings, so a listed action is one that resolve
accepts.

A publishing run held at REVIEW under Amendment 7, before any gate exists, is
out of scope. Accept stays unavailable there.

### Rationale and consequences

A review can end with findings a person decides not to act on, for example an
owner's decision to descope part of a criterion, when no code change answers
them and the review budget is spent. The gate then offered Hold and Request
Review. "Accept Review Findings and Publish" was listed among the gate's
definitions but was always refused, because `review-fix-required` allowed no
override. Adoption (Amendment 2) records an external publication and is not the
publication workflow.

Accepting findings becomes an explicit, attributed decision. The approval keeps
what was accepted, by whom and why, and the PR shows it. The other prerequisites
still protect what a reviewer cannot judge.

### Public surface

- No new action id or RPC. `run.resolveDecision` with `approve-publish-unresolved`
  requires `reason`. Older clients that send no reason are refused. The CLI
  `--reason` help names this action.
- `@farmslot/protocol` exports the availability rule, moving the gateway's
  per-action readiness filter there. It also adds optional `acceptedFindings`
  (with their digest), `reason` and `headSha` fields on the decision's
  publication approval.
- The CLI, Command Center and Companion list the action through that rule and
  ask for the reason before submitting.
