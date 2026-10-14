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

**Status:** Proposed. Implementation requires maintainer acceptance after paired review.
**Specification:** [Human publication adoption](../reference/fail-closed-run-lifecycle.md#human-publication-adoption).

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
Active continuations use existing lifecycle guards and the adopted PR target.

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
