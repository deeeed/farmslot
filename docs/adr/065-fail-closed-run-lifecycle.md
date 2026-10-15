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
the gateway's reasons and progress through one shared presentation contract.
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
