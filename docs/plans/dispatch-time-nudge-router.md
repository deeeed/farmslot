# Farmslot — Dispatch-Time Nudge Router PRD

**Status:** Proposed
**Date:** 2026-05-21
**Owner:** TBD
**Relates to:** [ADR-024 §7](../adr/024-run-lanes-and-run-family-model.md), [ADR-032](../adr/032-runner-observability-via-hooks.md)

## Scope

Collapse the wizard-time "Nudge vs Fresh dispatch" decision into a single non-throwing router predicate at the DISPATCH step. The wizard becomes a _hint provider_; DISPATCH decides based on live slot state. Replay, auto-recovery, and gateway-restart paths stop needing flag-clearing patches because the router re-evaluates from current state on every entry.

In scope:

- New advisory `Run.nudgeEligible: 'hint' | undefined` and `Run.forceFresh: boolean` fields.
- New `chooseDispatchKind(run, liveSlot)` router that returns `{kind: 'nudge' | 'fresh', reason, demotedFromHint}`.
- Convert `verifyBranchAffinityNudgeStillEligible` from a throwing gate into a non-throwing predicate `isBranchAffinityNudgeViable`.
- Three-phase migration ending with retirement of `engineState.flags.nudgeReuse`.

Out of scope:

- Changes to `RunnerObservability` (lives in [ADR-032](../adr/032-runner-observability-via-hooks.md); optional liveness signal here).
- Non-PR flows.
- Wizard UI changes beyond surfacing `dispatchKind` + `demotedFromHint` on the run-detail card.

## User Outcome

Operators dispatching nudge-eligible runs see them succeed across replay, auto-recovery, and restart boundaries without manual intervention. When a wizard-hinted nudge becomes infeasible (slot drifted off-branch, agent flipped, runner crashed), DISPATCH transparently falls back to fresh and the operator sees a visible "demoted to fresh: <reason>" indicator on the run-detail card. The 2026-05-21 mm-3 regression class — wizard says nudge, replay re-runs, eligibility gate throws — becomes structurally impossible.

## Canonical Current State

The wizard pre-commits `engineState.flags.nudgeReuse` at `run.create` time (`services/gateway/src/methods/run.ts:407-446`). FIND_SLOT short-circuits on it (`run-engine/find-slot-step.ts:117-147`). DISPATCH branches on it (`run-engine/dispatch-lifecycle-steps.ts:231-307`). `verifyBranchAffinityNudgeStillEligible` (`methods/dispatch/preview.ts:418-445`) throws on `agent !== 'working'`. Replay re-claims with `agent='orchestrator'` and the throw is unrecoverable — patched tactically at `run.ts:837-855` by clearing the flag on every replay. The tactical patch shipped 2026-05-21; this PRD replaces it with the structural fix.

## Requirements

### 1. Advisory hint, not directive

`run.create` writes `Run.nudgeEligible = 'hint'` when the wizard surfaced a nudge candidate the operator accepted. The field is advisory — DISPATCH consults it but is not bound by it. `Run.forceFresh = true` is set when the operator explicitly picked "kill & dispatch fresh"; DISPATCH honors this unconditionally.

### 2. Non-throwing router predicate

New file `services/gateway/src/run-engine/dispatch-routing.ts` exports:

```typescript
export type DispatchKind = 'nudge' | 'fresh';
export interface DispatchRoutingDecision {
  kind: DispatchKind;
  reason: string;
  hintAcknowledged: boolean;
  demotedFromHint: boolean;
}
export async function chooseDispatchKind(ctx: {
  run: Run;
  liveSlot: SlotStatus | undefined;
  triggeredBy: 'operator' | 'auto-recovery';
}): Promise<DispatchRoutingDecision>;
```

Routing rules in order:

1. `run.forceFresh === true` → `{kind: 'fresh', reason: 'operator override'}`.
2. `run.lane === 'comparison'` → `{kind: 'fresh', reason: 'comparison lane disallows nudge'}` (defense-in-depth; the wizard already gates this).
3. `run.nudgeEligible !== 'hint'` → `{kind: 'fresh', reason: 'no nudge hint'}`.
4. `isBranchAffinityNudgeViable(liveSlot, run)` is false → `{kind: 'fresh', demotedFromHint: true, reason: <predicate-reason>}`.
5. Optional liveness check via `RunnerObservability.getActivity()` when provider exists; gated on `agent === 'working'` from fleet state for `'pane-only'` runners.
6. Return `{kind: 'nudge', reason: 'predicate viable', hintAcknowledged: true}`.

### 3. DISPATCH-step routing

`executeDispatchStep` (`run-engine/dispatch-lifecycle-steps.ts:209-321`) replaces the `if (current.engineState?.flags?.nudgeReuse)` branch with a single `chooseDispatchKind` call. The decision's `kind` selects between `nudgeDispatch` and `dispatchExecute`; the decision is recorded on the step output as `dispatchKind`, `dispatchReason`, `demotedFromHint`.

### 4. Predicate replaces throwing gate

`verifyBranchAffinityNudgeStillEligible` is split into a pure predicate `isBranchAffinityNudgeViable(...)` that returns `{ viable: boolean; reason: string }`. The throwing facade is kept temporarily for back-compat callers and deleted in Phase 3. The duplicate re-eligibility throw inside `nudge.ts:207-224` is deleted — `nudgeDispatch` trusts the router.

### 5. Operator visibility

Run-detail card (`ui/src/components/runs/run-detail.ts`) renders a chip on the DISPATCH step output when `demotedFromHint === true`:

```
nudge demoted → fresh: <decision.reason>
```

Run timeline emits a `run.event` with kind `dispatch.routed` carrying the decision, so the operator sees the routing choice in the timeline regardless of whether it matched the hint.

### 6. Replay / auto-recovery / restart parity

The existing flag-clearing patch at `run.ts:845-855` is deleted as part of Phase 2. Replay re-enters DISPATCH with whatever live slot state exists; the router decides. `triggeredBy` is threaded through the call but the router's _default_ behavior does not branch on it — operator replays and auto-recovery replays produce the same routing.

## Non-goals for V1

- No new wizard control. The "abort on demotion" UX (`forceFresh=false, nudgeEligible='hint', abortOnDemotion=true`) is captured for V2.
- No change to the `freshReuse → prepareSlotForFreshReuse` teardown semantic. Only the _naming_ of the operator-intent field changes (`freshReuse` → `forceFresh`).
- No changes to `RunnerObservability` interface or to ADR-032's migration plan. The router treats observability as optional input.
- No changes to non-PR flows. `fix-bug`, `dev`, and eval lanes continue to call `dispatchExecute` directly.
- No new chokidar watches. The router reads existing `liveSlot` state at the moment of DISPATCH; no event-driven re-routing.

## Acceptance Criteria

1. Replay of a previously-nudged run that's now failed routes through `dispatchExecute` (fresh) without operator intervention. Verified by the owner-scoped run-engine test suite exercising the 2026-05-21 regression shape.
2. `engineState.flags.nudgeReuse` is no longer present on newly-created runs after Phase 3. Verified by schema test.
3. Comparison-lane runs that somehow carry `nudgeEligible='hint'` (e.g. via a malformed `run.create` payload) still route to fresh. Verified by defense-in-depth test.
4. Wizard-hinted nudge against a slot that drifts off the PR branch between create and DISPATCH demotes to fresh with `demotedFromHint=true`, surfaced on the run-detail chip. Verified end-to-end via dispatch wizard CDP probe.
5. Auto-recovery triggered DISPATCH against a slot that's now busy on the right branch routes to nudge (the original wizard intent restored automatically). Verified by integration test simulating gateway restart.
6. No new `NudgeTimeoutError` (the regression's symptom) traceable to flag/state divergence; `Run.metrics.nudgeTimeoutCount` (introduced in ADR-032 Phase 1 telemetry) stays at zero for replays specifically.

## Migration Phases

**Phase 1 — additive predicate, no behavior change.** Introduce `isBranchAffinityNudgeViable` as a non-throwing wrapper, `chooseDispatchKind` as unused, `nudgeEligible` / `forceFresh` / `dispatchKind` fields populated alongside existing flags. Ships independently of ADR-032 — the liveness branch is optional. Verifiable: existing tests stay green; new tests cover the predicate-only path.

**Phase 2 — flip the router.** DISPATCH reads `chooseDispatchKind`. FIND_SLOT short-circuit deleted. Replay flag-clearing patch deleted. In-flight Runs at deploy: read-path adapter maps `engineState.flags.nudgeReuse=true → nudgeEligible='hint'` so persisted state stays interpretable. Operator visibility (run-detail chip, `dispatch.routed` event) ships in this phase.

**Phase 3 — retire legacy flags.** Remove `nudgeReuse` from the engine flags type. Rename `freshReuse → forceFresh`. Update `start-ref-policy.ts:23,84` mutual-exclusion rules. Delete the throwing facade `verifyBranchAffinityNudgeStillEligible` and the inner throw at `nudge.ts:207-224`.

## Boundaries

This PRD owns: wizard hint, run-state schema, DISPATCH-step routing, predicate, operator visibility. Does not own: runner observability (ADR-032), comparison-lane semantics (ADR-024), nudge mechanics inside `nudgeDispatch` (unchanged), or `prepareSlotForFreshReuse` teardown.

## Supporting Evidence

- 2026-05-21 mm-3 regression: nudge to `runner-mobile-3` timed out; replay couldn't recover (`agent='orchestrator'` after re-claim, eligibility gate threw). Tactical fix at `methods/run.ts:837-855` clears the flag on every replay. PR #30125 unblocked once the patch landed.
- Critic review of ADR-032 noted: "the router predicate cleanly solves a regression class that the observability hooks alone do not address" — the two changes compose but are independent.

## Open Questions

Tracked in the brainstorm plan; resolved before Phase 1 ships:

1. **Demotion policy default.** Demote-to-fresh by default (proposed) or hard-fail (throw)? Demotion preserves operator workflow; hard-fail surfaces drift more loudly.
2. **Liveness threshold.** What "N minutes idle" qualifies as "worker dead"? Defer until ADR-032 lands real activity data; predicate's liveness branch returns `viable: true` until then.
3. **Replay UX.** Should replay surface "your original run was nudge; replay will be fresh" before executing, or is the post-routing chip sufficient?
4. **`forceFresh` durability across replay.** Survives (operator picked kill-and-fresh; replay honors it) vs resets (replay defaults to wizard-time hint).
5. **Audit retention.** `dispatchKind` + `demotedFromHint` on step output sufficient? Or separate `runHistory` table entry needed?

## Success Condition

A replay of a previously-failed nudge run, dispatched against the same slot whose agent state has drifted, succeeds end-to-end with the run-detail card showing `nudge demoted → fresh` for the operator. The legacy `engineState.flags.nudgeReuse` is gone from the codebase. The `run.ts:runReplayStep` flag-clearing patch is deleted. Zero `NudgeTimeoutError` from replay paths over a 7-day rolling window after Phase 2 ships.
