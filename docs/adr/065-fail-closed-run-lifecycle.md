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
that needs them. Consume Goal 3's resolved requirements and existing target,
proof-plan and provider contracts. Reuse the capability registry and posture
reconciler. No new requirement syntax, resource picker, provider or lease store
is introduced. Preview stays read-only; acquisition cannot steal a foreign lease
or grant mutation authority. This work starts only after Goal 3's declaration
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
  Goal 3 owns `RecipeFlowRequirements`, `recipeFlowRequirements` and target
  resolution. Proposed names do not imply that these dependencies have shipped.
- Downstream harnesses declare project/provider requirements through Goal 3 and
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

## Implementation order

1. Independent ADR/spec review, Goal 3 conflict review and lead approval are
   complete. ADR-065 and its specification were accepted on 2026-10-12.
2. PR 2 may start immediately after ADR/spec approval. It adds the six recovery
   scenarios and only repairs their demonstrated gaps. Reuse existing branch,
   runner, sandbox and release protections.
3. PR 1 starts only after cx-orchestrator's ADR-063 implementation PR merges,
   because both touch the gate and pipeline UI. It implements prerequisite
   enforcement and truthful state, including shared DTOs, CLI and thin client
   consumers. It consumes merged ADR-062/ADR-063 work and the existing
   acceptance-completion guard; it does not replace them.
4. PR 3 waits for Goal 3's declaration contract to merge, then consumes those
   requirements for automatic acquisition through the existing posture
   reconciler, with target/ownership and recovery proof.
5. Reserve the exact paths before each PR. Keep at most two unmerged PRs, use
   independent exact-head reviews with a five-round maximum, and freeze an
   approved head. The lead owns merging and coordinated rollout.

### Expected paths and owning lanes

These are the anticipated edits, not blanket reservations. New files are marked
`new`. Tests and package changelogs belong to the PR that changes their behavior.
Before implementation, reconcile this list with the owning lane and reserve the
exact paths. Any additional path needs the same check.

| Expected paths                                                                                                                                                                                                                                                                       | Purpose and overlap owner                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `docs/adr/065-fail-closed-run-lifecycle.md`; `docs/reference/fail-closed-run-lifecycle.md`                                                                                                                                                                                           | This proposal/spec; cx-reliability                                                                                                         |
| `packages/protocol/src/contracts/run-gate-readiness.ts`, new; `packages/protocol/src/contracts/run-lifecycle-view.ts`, new; their `.test.ts` files                                                                                                                                   | Shared readiness DTO and lifecycle presentation; cx-reliability, coordinate cx-capture's evidence model and cx-orchestrator's review types |
| `packages/protocol/src/contracts/runs.ts`; `packages/protocol/src/contracts/index.ts`; `packages/protocol/src/rpc/run.ts`; `packages/protocol/CHANGELOG.md`                                                                                                                          | Run/decision fields, states, RPC DTOs and exports; overlap cx-goal3, cx-capture, cx-orchestrator and cx-farmslot                           |
| `services/gateway/src/run-engine/gate-prerequisites.ts`, new; its `.test.ts` file                                                                                                                                                                                                    | Compose owning validators and deterministic results; cx-reliability, consume cx-capture/cx-orchestrator contracts                          |
| `services/gateway/src/run-engine/ready-gate.ts`; `review-gate.ts`; `review-artifacts.ts` in that directory                                                                                                                                                                           | Gate assembly and reviewer-result failure projection; overlaps cx-capture, cx-orchestrator and cx-farmslot                                 |
| `services/gateway/src/methods/run.ts`; `services/gateway/src/run-engine/decision-replay.ts`; `run-monitor.ts`; `recovery.ts`; `engine-decisions.ts`; `finalize-step.ts` in that directory; `services/gateway/src/runs/store.ts`                                                      | Resolve/replay/finalize freshness and persisted structured progress; overlaps cx-orchestrator and cx-farmslot                              |
| `services/gateway/src/methods/dispatch/execute.ts`; `services/gateway/src/run-engine/dispatch-lifecycle-steps.ts`; `services/gateway/src/run-engine/resource-posture.ts`; `services/gateway/src/runtime-capabilities/posture.ts`                                                     | Consume admitted requirements and existing acquisition; overlaps cx-goal3 and cx-farmslot                                                  |
| `services/gateway/src/run-engine/run-recovery-scenarios.test.ts`, new; `services/gateway/src/run-engine/gate-prerequisite-integration.test.ts`, new; `services/gateway/CHANGELOG.md`                                                                                                 | Gateway-path regression coverage and release notes; cx-reliability                                                                         |
| `services/gateway/src/methods/slot/prepare.ts`; `release.ts`; `unmerged-work.ts`; `release-run-ownership.ts` in that directory; `services/gateway/src/methods/dispatch/branch-checkout.ts`; `services/gateway/src/run-engine/deferred-slot-release.ts`                               | Only scenario-proven recovery gaps; existing repair owner cx-farmslot                                                                      |
| `services/gateway/src/methods/runtime-capabilities.ts`; `services/gateway/src/runtime-capabilities/registry.ts`; `services/gateway/src/fleet/resource-manager.ts`; `resource-process.ts` in that directory                                                                           | Only demonstrated lease/owned-orphan cleanup gaps; overlaps cx-farmslot, no second manager                                                 |
| `services/gateway/src/runners/registry.ts`; `session-process.ts`; `launch-command.ts` in that directory; `scripts/dev.sh`; `scripts/lib/sandbox-home.cjs`                                                                                                                            | Only demonstrated transport/sandbox recovery gaps; cx-farmslot owns existing repairs, shared runner adapter remains authoritative          |
| `packages/cli/src/commands/run.ts`; `packages/cli/CHANGELOG.md`                                                                                                                                                                                                                      | Existing run/gate output; coordinate cx-goal3's CLI work, no recipe command changes                                                        |
| `apps/command-center/ui/src/components/workspace/ready-workspace-action-presenter.ts`; `ready-workspace-state.ts`; `ready-workspace-shell-renderers.ts` in that directory; `apps/command-center/ui/src/utils/review-gate-display.ts`; `apps/command-center/ui/CHANGELOG.md`          | Render shared reasons and action availability; overlaps cx-capture and cx-orchestrator                                                     |
| `apps/command-center/ui/src/components/runs/run-utils.ts`; `run-pipeline-status.ts`; `run-pipeline-model.ts`; `run-detail-model.ts` in that directory                                                                                                                                | State labels and colors consume the shared projection; coordinate cx-orchestrator                                                          |
| `apps/companion/src/features/decision-workspace/DecisionWorkspaceScreen.tsx`; `apps/companion/src/lib/decision-presentation.ts`; `apps/companion/src/features/run-detail/run-detail-model.ts`; `RunDetailScreen.tsx` in that directory; `apps/companion/CHANGELOG.md`                | Same reasons/state in thin native consumers; overlaps cx-capture and cx-orchestrator                                                       |
| `apps/companion/src/components/RunPipeline.tsx`; `apps/companion/src/lib/task-progress.ts`; `apps/companion/src/app/(tabs)/runs.tsx`; `apps/companion/src/features/slot-workspace/slot-workspace-model.ts`; `apps/companion/src/features/family-workspace/family-workspace-model.ts` | Exhaustive new-status consumers; coordinate cx-orchestrator                                                                                |
| `packages/protocol/package.json`; `services/gateway/package.json`; `packages/cli/package.json`; `apps/command-center/ui/package.json`; `apps/companion/package.json`; `yarn.lock`                                                                                                    | Only required scripts/dependency version changes; lead coordinates shared manifests                                                        |

Goal 3 retains ownership of
`packages/protocol/src/contracts/recipe-conformance.ts`,
`services/gateway/src/tasks/recipe-dispatch-check.ts`, ProjectRuntime declaration
and capability display. ADR-062 retains ledger, recording, package validation and
evidence review. ADR-063 retains review policy, results and the shared picker.
cx-farmslot retains deterministic CI-parity steps and pack/template AC wiring.
This lane requests an owner edit if those contracts lack a required input.

The six gateway `.test.ts` scenarios use the existing CI test collection, so no
new workflow or root command is expected. If isolation or the runtime budget
requires a separate CI entry, first coordinate/reserve root `package.json` and
`.github/workflows/farmslot-quality.yml` with the lead. Do not silently omit the
scenarios from CI.

## Non-goals

- Another declaration schema, lease manager, recorder, reviewer policy or picker.
- Reimplementing deterministic steps or copying template instructions.
- Guessing visual correctness from artifact existence or transport success.
- Destructive automatic recovery, operator lease stealing or global process cleanup.
- A new workflow engine, combinatorial test matrix or fleet deployment before approval.
