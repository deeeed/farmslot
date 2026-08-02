# ADR-052: Run Lifecycle Transition Routing

**Status:** Proposed
**Date:** 2026-08-02
**Relates to:** [ADR-013](013-gateway-mediated-orchestration.md), [ADR-024](024-run-lanes-and-run-family-model.md), [ADR-027](027-unified-gateway-state.md), [ADR-040](040-work-graph-orchestration.md)

## Context

A run's lifecycle is not owned by the run store alone. When a run reaches a terminal state, four other aggregates must agree: the backlog item that owns the work, the dispatch queue, the work-graph node that scheduled it, and the slot that executed it.

Today that agreement is reached through the **event bus**, via an interceptor installed in the composition root (`services/gateway/src/index.ts`):

```ts
const observedBroadcast = (event, payload) => {
  originalBroadcast(event, payload);
  routeEventToObserver(event, payload);
  routeEventToAutoRecovery(event, payload);
  if (event === Events.RUN_UPDATED || event === Events.RUN_COMPLETED) {
    const run = payload.run;
    if (run) {
      markBacklogRunObserved(run);
      if (run.workGraphId) schedulerTick({ graphId: run.workGraphId }).catch(...);
    }
  }
};
```

This works — for the transitions that happen to flow through it. The gateway has **three** emit paths with the same TypeScript signature, `(event: string, payload: unknown) => void`, and only one reaches the fan-out:

| Path                                                            | Where it comes from                                                                                                                        | All sockets            | Backlog + work-graph fan-out |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- | ---------------------------- |
| `observedBroadcast`                                             | Injected into engine subsystems: `initRunEngine`, `initRunMonitor`, `initRunCompletion`, `initCIMonitor`, `initAutoRecovery`, …            | yes                    | **yes**                      |
| `broadcastEvent` / `broadcast({type:'event'})`                  | Autonomous `runCreate` (`index.ts:421`); `DECISION_RESOLVE` and `RUN_RESOLVE_DECISION` in `server/route-method.ts` + `server/run-route.ts` | yes                    | **no**                       |
| per-request `emit` = `sendEvent(state.ws, …)` (`server.ts:557`) | Every RPC handler routed through `routeMethod` — including `run.cancel`, `run.forceComplete`, `run.pause`, `run.resume`                    | requesting socket only | **no**                       |

Consequences that are live today:

1. **Operator cancel does not propagate.** `run.cancel` receives the per-request `emit`. Its `emit(Events.RUN_UPDATED, { run })` reaches one WebSocket. The backlog item keeps `status: 'running'` and the work-graph node is never told. Nothing corrects this until the next gateway restart runs `reconcileBacklogLinks()`.
2. **The scheduler has to re-derive intent by polling.** Because no one tells the graph that an operator stopped a run, `work-graph/store.ts` infers it during `schedulerTick` from `status === 'cancelled' && !redirectedToRunId`. That inference is the entirety of the #466 fix (`0f161cbe`), which touched five modules to express one lifecycle rule.
3. **Fan-out is unordered.** `markBacklogRunObserved(run)` returns `void` and does not await its internal `withBacklogMutation`; `schedulerTick` is invoked on the following line. The scheduler can therefore read backlog state before the settle has landed.
4. **Intent is erased at the boundary.** The interceptor sees "a run changed", never "an operator cancelled this run". Every consumer that needs intent must reconstruct it from field combinations.
5. **Cross-store propagation is untestable.** `observedBroadcast` is a closure built inside `startGateway()`. No unit test can construct it, so no test asserts that a terminal transition settles the backlog or ticks the graph.

Thirteen modules write a terminal run status through `updateRun()`. Which of them propagate depends entirely on which of the three `emit` values they were handed — a distinction invisible at every call site.

## Decision Drivers

- Propagation must not depend on remembering to emit, or on which emit tier a caller received.
- Ordering between dependent stores must be explicit, not incidental.
- Operator intent must survive to the consumers that need it, instead of being re-derived.
- Must be unit-testable without booting the gateway.
- Incremental — one transition at a time, with the existing interceptor left in place as a backstop until every transition has migrated.
- No silent failures: an effect that cannot complete must be reported, per the repo's no-swallowed-exceptions rule.

## Options Considered

### A. Status quo — event-bus fan-out (rejected)

Keep the interceptor and fix bugs where they surface.

**Pros:** Zero work. Decoupled in the abstract.
**Cons:** The coupling is real but implicit, so it is invisible until it breaks. #466 is the second incident of this class; the cost of the next is unbounded. Does not address the three-tier emit split, which is the actual defect.

### B. Make every emit path go through `observedBroadcast` (rejected)

Normalize the three tiers into one, so the interceptor always fires.

**Pros:** Small diff. Fixes propagation reach.
**Cons:** Forces every per-request `emit` to become a global broadcast, changing socket semantics for unrelated events. Leaves ordering incidental and intent erased. Still untestable.

### C. Explicit transition router (chosen)

Lifecycle transitions become a first-class call. Call sites declare **intent**; a router applies the guard, performs the run-store mutation, then runs an ordered list of effects, awaiting each one.

**Pros:**

- Propagation is a function call, not a side effect of remembering to emit. Independent of emit tier.
- Ordering is declared and awaited.
- Intent (`kind`, `actor`) reaches every effect, so consumers stop re-deriving it.
- Collaborators are injected, so the whole fan-out is unit-testable.
- Migratable one transition at a time.

**Cons:** A second propagation path exists until migration completes. Mitigated because every effect is idempotent — for an already-settled run the interceptor's pass is a no-op.

## Decision

Add `services/gateway/src/run-lifecycle/` owning a `routeRunTransition(request, deps)` entry point.

```ts
interface RunTransitionRequest {
  kind: RunTransitionKind; // 'cancel' first; extended per slice
  runId: string;
  actor: 'operator' | 'engine' | 'recovery';
  reason?: string;
}
```

The router:

1. **Guards** — rejects a missing run or an already-terminal run before mutating anything.
2. **Runs `before` effects**, awaiting each. These are the steps that must happen while the run is
   still non-terminal (stopping the engine, invalidating warm reviewer sessions).
3. **Mutates** the run store once, through `updateRun`.
4. **Publishes** the terminal state immediately through `onMutated`, _before_ the `after` effects.
   The UI must not wait on slow teardown; slot release alone can take seconds of tmux work.
5. **Runs `after` effects in declared order**, awaiting each — this is where the other aggregates
   are settled. Effects are `required` (failure aborts the transition) or `advisory` (failure is
   recorded on the result and logged, never swallowed). An effect may inspect earlier outcomes and
   refuse to act on state a prior effect failed to settle.

Effect ordering for `cancel`:

| #   | Effect            | Severity | Rationale                                                                                                                                                                   |
| --- | ----------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `engine-cancel`   | required | Stop the engine before publishing a terminal state, so no step writes after it.                                                                                             |
| 2   | `warm-sessions`   | required | A cancelled run's warm reviewer sessions must never be resumable.                                                                                                           |
| 3   | _(core mutation)_ | —        | Terminal status, skipped steps, `outcome: 'cancelled'`.                                                                                                                     |
| 4   | `backlog-settle`  | advisory | Awaited, so the graph cannot read a pre-settle backlog. Propagates failure.                                                                                                 |
| 5   | `work-graph-tick` | advisory | Only when `run.workGraphId`, and skipped outright if the settle failed — scheduling against a backlog we know is stale is the redispatch bug this router exists to prevent. |
| 6   | `slot-release`    | advisory | tmux/window cleanup is slow and must not block the terminal state.                                                                                                          |

`markBacklogRunObserved` changes its return type from `void` to `Promise<void>` **and stops
catching its own rejection**, so `backlog-settle` can distinguish a failed settle from a successful
one. Without that, the effect always reported `ok` and `work-graph-tick` scheduled against state that
never settled. The one fire-and-forget caller — the `observedBroadcast` interceptor — attaches its
own handler.

Transitions are serialized per run. The terminal guard is only meaningful if nothing interleaves
between it and the mutation, and `before` effects await; without the lock, two concurrent cancels
both pass the guard and both run the chain, including a stale second slot release that can free a
slot another run has already claimed.

Publication is owned by the transition, not the caller. Passing an emitter in made a cancel's reach
depend on which entry point invoked it: the RPC route's per-request `emit` reaches one socket, while
`chat.confirmAction` and `run.interactiveDevResolve` hold their own. `runCancel` now takes no
emitter and broadcasts globally.

**Scope of this ADR's first slice:** `cancel` only. `dispatch`, `complete`, `fail`, `block` and `resume` keep their current paths until migrated. The `observedBroadcast` interceptor stays until every transition has moved, then is deleted.

## Consequences

**Positive**

- Operator cancel settles the backlog and ticks the work graph immediately, instead of waiting for a gateway restart.
- The scheduler's cancel inference (#466) becomes a backstop rather than the only signal, and can be removed once the graph is notified with intent.
- Cross-store propagation gains unit tests for the first time.
- New lifecycle rules land in one file instead of five.

**Negative**

- Two propagation paths coexist during migration. Effects are idempotent, so the overlap is redundant work, not incorrect state.
- `RUN_UPDATED` for cancel now fires after the in-memory fan-out rather than before it. Slot release still happens after the emit, preserving the responsiveness the original comment protects.

**Neutral**

- No protocol change. `RunTransitionRequest` is gateway-internal; nothing crosses the wire.

## Follow-ups

1. Migrate the remaining transitions (`dispatch`, `complete`, `fail`, `block`, `resume`), then delete
   the `RUN_UPDATED` branch of the `observedBroadcast` interceptor in `index.ts`.
2. Once the work graph is told about cancellation with intent, replace the scheduler's
   `status === 'cancelled' && !redirectedToRunId` inference with the routed signal.
3. Revisit `Run.backlogReconcilePending`. It is a write-ahead marker for a settle that had no
   transactional path; routed transitions should make it removable.
4. **Run attempt ordering is not deterministic under equal timestamps.** `nodeRuns` in
   `work-graph/store.ts` sorts on `createdAt`, then terminal-ness, then `updatedAt`, then
   `run.id.localeCompare`. `createdAt`/`updatedAt` are millisecond-resolution ISO strings, so two
   attempts on the same node created inside one millisecond fall through to comparing random UUIDs
   and "latest attempt" flips between runs. This surfaced while removing the `setTimeout(25)` waits
   that `work-graph/store.test.ts` used to compensate for the un-awaited backlog settle: with the
   waits gone the suite runs fast enough to tie. The test now pins an explicit older `createdAt`, but
   the production ordering still needs a monotonic tiebreak (a per-node attempt counter, or reusing
   the existing `launchAttempt`) rather than uuid comparison.

## References

- `services/gateway/src/index.ts` — `observedBroadcast` interceptor
- `services/gateway/src/server.ts` — `broadcastEvent`, per-request `emit`
- `services/gateway/src/methods/run/lifecycle-control.ts` — `runCancel`
- `services/gateway/src/work-graph/store.ts` — operator-cancel inference added by #466
- Commit `0f161cbe` — "fix(gateway): stop redispatching cancelled graph runs (#466)"
