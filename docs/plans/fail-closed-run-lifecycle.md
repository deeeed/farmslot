# Fail-closed lifecycle implementation plan

**Status:** Accepted supporting plan; delivery is incremental.
**Scope:** Remaining integration and regression gates for [ADR-065](../adr/065-fail-closed-run-lifecycle.md), supporting the [runner execution PRD](../PRD-runner-execution-canonical.md).
**Owner:** Farmslot maintainers. Keep this plan while integration remains open, then delete it under [docs governance](../DOCS-GOVERNANCE.md). Source paths identify owners; they are not permission to edit an active branch.

Recovery scenarios shipped in [#950](https://github.com/deeeed/farmslot/pull/950); prerequisite enforcement shipped in [#961](https://github.com/deeeed/farmslot/pull/961). Declared resource acquisition shipped in [#990](https://github.com/deeeed/farmslot/pull/990). Consolidating remaining state transitions and requirement consumers still needs validation. The ordering below records the accepted delivery plan; already shipped steps are not future work. No statement below establishes deployment or full feature closure.

## Implementation order

1. Independent ADR/spec review, ADR-068 conflict review and lead approval are
   complete. ADR-065 and its specification were accepted on 2026-10-12.
2. PR 2 may start immediately after ADR/spec approval. It adds the six recovery
   scenarios and only repairs their demonstrated gaps. Reuse existing branch,
   runner, sandbox and release protections.
3. PR 1 starts only after the owning maintainer's ADR-063 implementation PR merges,
   because both touch the gate and pipeline UI. It implements prerequisite
   enforcement and truthful state, including shared DTOs, CLI and thin client
   consumers. It consumes merged ADR-062/ADR-063 work and the existing
   acceptance-completion guard; it does not replace them.
4. PR 3 waits for ADR-068's declaration contract to merge, then consumes those
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

| Expected paths                                                                                                                                                                                                                                                                       | Purpose and overlap owner                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `docs/adr/065-fail-closed-run-lifecycle.md`; `docs/reference/fail-closed-run-lifecycle.md`                                                                                                                                                                                           | This proposal/spec; the owning maintainer                                                                                                                          |
| `packages/protocol/src/contracts/run-gate-readiness.ts`, new; `packages/protocol/src/contracts/run-lifecycle-view.ts`, new; their `.test.ts` files                                                                                                                                   | Shared readiness DTO and lifecycle presentation; the owning maintainer, coordinate the owning maintainer's evidence model and the owning maintainer's review types |
| `packages/protocol/src/contracts/runs.ts`; `packages/protocol/src/contracts/index.ts`; `packages/protocol/src/rpc/run.ts`; `packages/protocol/CHANGELOG.md`                                                                                                                          | Run/decision fields, states, RPC DTOs and exports; overlap the owning maintainer, the owning maintainer, the owning maintainer and the owning maintainer           |
| `services/gateway/src/run-engine/gate-prerequisites.ts`, new; its `.test.ts` file                                                                                                                                                                                                    | Compose owning validators and deterministic results; the owning maintainer, consume the owning maintainer/the owning maintainer contracts                          |
| `services/gateway/src/run-engine/ready-gate.ts`; `review-gate.ts`; `review-artifacts.ts` in that directory                                                                                                                                                                           | Gate assembly and reviewer-result failure projection; overlaps the owning maintainer, the owning maintainer and the owning maintainer                              |
| `services/gateway/src/methods/run.ts`; `services/gateway/src/run-engine/decision-replay.ts`; `run-monitor.ts`; `recovery.ts`; `engine-decisions.ts`; `finalize-step.ts` in that directory; `services/gateway/src/runs/store.ts`                                                      | Resolve/replay/finalize freshness and persisted structured progress; overlaps the owning maintainer and the owning maintainer                                      |
| `services/gateway/src/methods/dispatch/execute.ts`; `services/gateway/src/run-engine/dispatch-lifecycle-steps.ts`; `services/gateway/src/run-engine/resource-posture.ts`; `services/gateway/src/runtime-capabilities/posture.ts`                                                     | Consume admitted requirements and existing acquisition; overlaps the owning maintainer and the owning maintainer                                                   |
| `services/gateway/src/run-engine/run-recovery-scenarios.test.ts`, new; `services/gateway/src/run-engine/gate-prerequisite-integration.test.ts`, new; `services/gateway/CHANGELOG.md`                                                                                                 | Gateway-path regression coverage and release notes; the owning maintainer                                                                                          |
| `services/gateway/src/methods/slot/prepare.ts`; `release.ts`; `unmerged-work.ts`; `release-run-ownership.ts` in that directory; `services/gateway/src/methods/dispatch/branch-checkout.ts`; `services/gateway/src/run-engine/deferred-slot-release.ts`                               | Only scenario-proven recovery gaps; existing repair owner the owning maintainer                                                                                    |
| `services/gateway/src/methods/runtime-capabilities.ts`; `services/gateway/src/runtime-capabilities/registry.ts`; `services/gateway/src/fleet/resource-manager.ts`; `resource-process.ts` in that directory                                                                           | Only demonstrated lease/owned-orphan cleanup gaps; overlaps the owning maintainer, no second manager                                                               |
| `services/gateway/src/runners/registry.ts`; `session-process.ts`; `launch-command.ts` in that directory; `scripts/dev.sh`; `scripts/lib/sandbox-home.cjs`                                                                                                                            | Only demonstrated transport/sandbox recovery gaps; the owning maintainer owns existing repairs, shared runner adapter remains authoritative                        |
| `packages/cli/src/commands/run.ts`; `packages/cli/CHANGELOG.md`                                                                                                                                                                                                                      | Existing run/gate output; coordinate the owning maintainer's CLI work, no recipe command changes                                                                   |
| `apps/command-center/ui/src/components/workspace/ready-workspace-action-presenter.ts`; `ready-workspace-state.ts`; `ready-workspace-shell-renderers.ts` in that directory; `apps/command-center/ui/src/utils/review-gate-display.ts`; `apps/command-center/ui/CHANGELOG.md`          | Render shared reasons and action availability; overlaps the owning maintainer and the owning maintainer                                                            |
| `apps/command-center/ui/src/components/runs/run-utils.ts`; `run-pipeline-status.ts`; `run-pipeline-model.ts`; `run-detail-model.ts` in that directory                                                                                                                                | State labels and colors consume the shared projection; coordinate the owning maintainer                                                                            |
| `apps/companion/src/features/decision-workspace/DecisionWorkspaceScreen.tsx`; `apps/companion/src/lib/decision-presentation.ts`; `apps/companion/src/features/run-detail/run-detail-model.ts`; `RunDetailScreen.tsx` in that directory; `apps/companion/CHANGELOG.md`                | Same reasons/state in thin native consumers; overlaps the owning maintainer and the owning maintainer                                                              |
| `apps/companion/src/components/RunPipeline.tsx`; `apps/companion/src/lib/task-progress.ts`; `apps/companion/src/app/(tabs)/runs.tsx`; `apps/companion/src/features/slot-workspace/slot-workspace-model.ts`; `apps/companion/src/features/family-workspace/family-workspace-model.ts` | Exhaustive new-status consumers; coordinate the owning maintainer                                                                                                  |
| `packages/protocol/package.json`; `services/gateway/package.json`; `packages/cli/package.json`; `apps/command-center/ui/package.json`; `apps/companion/package.json`; `yarn.lock`                                                                                                    | Only required scripts/dependency version changes; lead coordinates shared manifests                                                                                |

ADR-068 retains ownership of
`packages/protocol/src/contracts/recipe-conformance.ts`,
`services/gateway/src/tasks/recipe-dispatch-check.ts`, ProjectRuntime declaration
and capability display. ADR-062 retains ledger, recording, package validation and
evidence review. ADR-063 retains review policy, results and the shared picker.
the owning maintainer retains deterministic CI-parity steps and pack/template AC wiring.
This lane requests an owner edit if those contracts lack a required input.

The six gateway `.test.ts` scenarios use the existing CI test collection, so no
new workflow or root command is expected. If isolation or the runtime budget
requires a separate CI entry, first coordinate/reserve root `package.json` and
`.github/workflows/farmslot-quality.yml` with the lead. Do not silently omit the
scenarios from CI.
