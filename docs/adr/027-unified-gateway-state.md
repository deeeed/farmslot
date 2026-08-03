# ADR-027: Unified Gateway State Persistence

**Status:** Accepted
**Date:** 2026-04-18
**Relates to:** [ADR-005](005-state-persistence.md), [ADR-013](013-gateway-mediated-orchestration.md), [ADR-024](024-run-lanes-and-run-family-model.md)

## Context

ADR-005 established a clean rule: the gateway owns fleet state in memory and persists snapshots (`.farm-status.json` + per-run `.runs/<id>.json`). Restart recovery rehydrates `Run` and `SlotStatus` objects from disk — `recoverActiveRuns()` covers the happy path for lifecycle and step progress.

That rule is observed for the **canonical** `Run`/`SlotStatus` fields. It is **not** observed for the pile of module-level `Map`/`Set` instances that accrued across subsequent features. A `tsx watch` hot-reload or a crash wipes them. The consequences are small most of the time and occasionally painful:

| Module            | Volatile state                                                                       | What breaks on restart                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci-monitor.ts`   | `inlineCIFixAttempts`, `inlineCIFixTotal`, `inlineFixDedup`, `inlineFixDedupedSkips` | Circuit breaker (6-attempt ceiling) resets. Already-handled bot comments re-trigger CI-FIX.md dispatch. Directly caused the re-dispatch loop on run `86fc84a0` (PROJ-2947 / PR #41919). |
| `ci-monitor.ts`   | `ciDecisionResolvers`                                                                | Pending ci-watch decisions orphan — the `Promise` that was waiting for human resolution is gone; the decision row on disk never completes.                                              |
| `run-engine.ts`   | `runFlags` (`skipPrepare`, `warmRecovery`)                                           | Warm recovery hints vanish; a run that was mid-resume gets replayed as cold.                                                                                                            |
| `run-engine.ts`   | `runGeneration`                                                                      | Step output routing counter resets; in-flight step outputs can collide with post-restart ones.                                                                                          |
| `run-engine.ts`   | `engineDecisionResolvers`                                                            | Same orphan-resolver bug as ci-monitor.                                                                                                                                                 |
| `run-monitor.ts`  | `monitorStates`, `decisionResolvers`                                                 | Loss of nudge-count history and pending-decision resolvers.                                                                                                                             |
| `auto-recycle.ts` | `failureCounts`, `recyclingSlots`                                                    | Consecutive-failure threshold resets; slot already in a recycle-triage loop may re-enter.                                                                                               |
| `self-review.ts`  | `remoteProgressEntries`                                                              | Remote review progress bars restart at 0 even though the remote worker is still running.                                                                                                |
| `task-watcher.ts` | `activeWatches`, `debounceTimers`                                                    | Per-slot file watches must be re-armed. (Handles, not data — acceptable to rebuild, but the gate for rebuilding is lifecycle state that _does_ survive.)                                |

A second class of module-level state is **deliberately** volatile and should stay that way — WebSocket client sockets, node-rpc pending promises, PTY sessions, chokidar watchers, child-process handles, short-lived caches (`ghCache`, `thumbnailCache`, `reportCache`). These are handles to external runtime objects that don't survive restart regardless of what we do.

Three forces push us toward a real fix rather than more per-feature bandages:

1. **`tsx watch` is the default dev loop.** Every gateway code change causes a restart. The probability of catching a hot-reload mid-run is high, not low.
2. **The system increasingly auto-dispatches.** With ADR-021, ADR-025, ADR-026 and the family/validator loops, runs now trigger _other runs_ without human intervention. A restart in the middle of that chain, where volatile dedup state is the only thing stopping a re-dispatch, has compounding cost.
3. **Pattern recurrence.** The 86fc84a0 loop was not novel. It is the third incident (earlier: warm-recovery flag loss, pending-decision orphans) that traces back to module-level `Map` volatility. Each one was fixed with a bespoke patch. The cost of the next one is guaranteed and currently unbounded.

The earlier attempt to mitigate this via GitHub API calls (`reviewThreads.isResolved` as source of truth) was rejected because GitHub rate limits make any API-sourced ground-truth unreliable — under rate limiting, the gateway cannot fetch the state it needs to not re-dispatch, and defaults to the same bad heuristic that caused the incident. Any durable fix must rely on local disk, not an external API.

## Decision Drivers

- Survives arbitrary gateway restart (SIGKILL, `tsx watch`, OOM).
- No external dependency for correctness (no GitHub, no network).
- Atomic writes; never half-written state.
- Does not regress existing `.runs/<id>.json` shape — current recovery continues to work.
- Low blast radius per-feature — migration is incremental, per-module.
- Clear separation between persist-required state and deliberately-volatile runtime handles.

## Options Considered

### A. Per-feature patches on demand (status quo)

Add disk persistence only when a specific bug proves it's needed. Each module picks its own scheme.

**Pros:** Minimal up-front work. No ADR needed.
**Cons:** Guaranteed recurrence. Every incident costs investigation + rewrite. The pattern landed four times before this ADR; it will land a fifth.

### B. Move persist-required state onto existing `Run`/`SlotStatus` objects

Every volatile counter, signature, generation number, and dedup fingerprint becomes an optional field on `Run` (or `SlotStatus` for slot-scoped state). Existing `persist(run)` via `run-store.ts:49` handles the write. Existing `recoverActiveRuns()` handles the read.

**Pros:**

- Reuses the persistence path we already trust.
- Type-driven — field lives where the code that reads it lives.
- Zero new files, zero new atomic-write code.
- Incremental — adopt one module at a time.

**Cons:**

- Grows the `Run` type with ancillary fields (can be grouped under subfields like `Run.ciWatchState`, `Run.engineState`).
- Resolver state (Promises for pending decisions) still cannot live on `Run` directly — decisions persist, resolvers get rehydrated from the persisted decision list on startup.

### C. SQLite-backed state store

Add SQLite as gateway dependency. Move all persist-required state into tables. Run/slot objects become views over the DB.

**Pros:** Query capability; append-only history; atomic multi-row transactions.
**Cons:** Breaks ADR-005 rationale (JSON-file simplicity); migration is big-bang; forces all non-Run writers to use DB or suffer read-your-writes lag. ADR-005 Option B was already rejected for these reasons and none of them have changed.

### D. LMDB / leveldb / sled — embedded KV

Same shape as C but smaller surface. One binary dependency.

**Cons:** Still a new dep and new atomic-write protocol for debatable gain. KV doesn't fit run-family queries any better than the current JSON files.

### E. Fully accept volatile surface; document and move on

Add a CLAUDE.md note: "gateway restart may re-trigger at-most-once dispatches." Add rate-limiting at the dispatch boundary so even if a re-dispatch fires, it's cheap.

**Pros:** Zero code change.
**Cons:** Does not scale as auto-dispatch density grows. Incident 86fc84a0 cost real worker cycles and human review time — "accept volatile" is accepting that cost in perpetuity.

## Decision

Adopt **Option B — move persist-required state onto `Run` / `SlotStatus`**.

### Scope boundary: what persists, what doesn't

**Persist (on the owning `Run` or `SlotStatus`):**

- CI-monitor dedup (`signature`, `commitSha`, `totalAttempts`, `consecutiveAttempts`, `skips`) → `Run.ciWatchState`.
- Run-engine flags (`skipPrepare`, `warmRecovery`) → `Run.engineState.flags`.
- Run-engine generation counter → `Run.engineState.generation`.
- Run-monitor nudge counters and step progress mirrors → `Run.monitorState`.
- Auto-recycle consecutive-failure count per slot → `SlotStatus.recycleState.failureCount`.
- Self-review remote progress snapshots → `Run.selfReviewState.remoteProgress`.

**Do not persist (deliberately volatile, rebuilt from persisted sources):**

- WebSocket clients, node-rpc pending promises, PTY sessions, chokidar watchers, child-process handles, debounce timers.
- Ephemeral caches (`ghCache`, `thumbnailCache`, `reportCache`, `statusCache`) — rebuild on demand; staleness is tolerable.
- Decision resolvers (`ciDecisionResolvers`, `engineDecisionResolvers`, `decisionResolvers`) — the **decision rows** persist as `RunDecision` on `Run`; resolvers get re-attached on startup by `recoverActiveRuns()` scanning pending decisions and registering fresh `Promise` resolvers that tie to the eventual `run.resolveDecision` call.

### Shape

New grouped subfields on `Run` keep the top-level type flat:

```ts
interface Run {
  // existing fields…
  ciWatchState?: {
    dedup?: { signature: string; commitSha: string };
    consecutiveAttempts: number;
    totalAttempts: number;
    skips: number;
  };
  engineState?: {
    flags?: { skipPrepare?: boolean; warmRecovery?: boolean };
    generation?: number;
  };
  monitorState?: {
    nudges?: number;
    lastStepSignature?: string;
  };
  selfReviewState?: {
    remoteProgress?: RemoteProgressEntry;
  };
}

interface SlotStatus {
  // existing fields…
  recycleState?: { failureCount: number; lastFailureAt?: string };
}
```

Fields are **optional**. Old `.runs/<id>.json` files without them remain valid.

### Decision resolvers

For each module holding decision resolvers, on gateway startup:

1. `recoverActiveRuns()` enumerates persisted `RunDecision` rows with status `pending`.
2. For each pending decision, attach a fresh resolver tied to the run's pending-decision Promise chain. The resolver completes when `run.resolveDecision` fires (UI or auto).
3. A pending decision without an attached resolver after startup is a bug and must log loudly; no silent orphan.

This preserves the "decisions live on disk; resolvers are runtime handles" split.

### Migration

Per-module, not big-bang:

| Phase | Module                                                                | Effort                                                                               |
| ----- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1     | `ci-monitor.ts` (dedup + counters)                                    | S — 4 Maps → `Run.ciWatchState`. One mutate/read helper pair.                        |
| 2     | `run-engine.ts` (flags + generation)                                  | S — 2 Maps.                                                                          |
| 3     | `run-monitor.ts` (monitor state)                                      | M — touches nudge-count + step-mirror logic.                                         |
| 4     | Decision-resolver rehydration (ci-monitor + run-engine + run-monitor) | M — single `attachResolver(run, decisionId)` helper called from `recoverActiveRuns`. |
| 5     | `self-review.ts` remote progress                                      | S.                                                                                   |
| 6     | `auto-recycle.ts` failure counts                                      | S — moves onto `SlotStatus`.                                                         |

Each phase is a standalone PR. Phases can ship independently; they do not depend on each other.

### Verification per phase

For each module migrated:

1. `cd apps/command-center && yarn typecheck` — zero errors.
2. Restart test — trigger the class of state the module owns, kill gateway, restart, confirm the state rehydrated from disk (grep for module-specific log lines; `jq` the relevant subfield on `.runs/<id>.json`).
3. Existing tests green (unit tests for that module, if present).

### Non-goals

- Pool JSON config/state mix (cosmetic; deferred — see user feedback 2026-04-17).
- GitHub API-backed ground truth (rejected — rate limits).
- SQLite or embedded KV migration (Option C/D; no driver for the cost).
- Event-log persistence (ADR-005 Option D; still deferred).

## Consequences

### Positive

- The class of "gateway restarted mid-run, volatile state lost, bad thing happened" bug closes. Each phase eliminates one source; four phases cover the known incident surface.
- No new dependencies, no new atomic-write code, no protocol churn.
- `Run.*` becomes the single answer to "what do I need to persist?" — future features have a clear default.
- Incremental migration means any phase can ship + land independently without blocking on the others.

### Negative

- `Run` type grows. Mitigated by grouping under state subfields.
- Each `updateRun()` call that touches these fields triggers an atomic write — slight disk write increase. Already debounced in `run-store.ts`; not expected to be load-bearing at current fleet size.
- Decision-resolver rehydration is subtle; a bug there silently orphans decisions. Mitigation: loud log + integration test on the pending-decision recovery path in phase 4.

## Phase outcomes (2026-04-18)

| Phase                             | Outcome                     | Commit / Rationale                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — ci-monitor dedup + counters   | Shipped                     | `Run.ciWatchState`; 4 Maps removed                                                                                                                                                                                                                                                                                                                                                           |
| 2 — run-engine flags + generation | Shipped                     | `Run.engineState`; setRunFlags/bumpRunGeneration route through `updateRun`                                                                                                                                                                                                                                                                                                                   |
| 3 — run-monitor monitorStates     | Shipped (dead-code removal) | The module-level Map was write-only; real state already persisted on `Run.monitorState`. Deleted the unused Map                                                                                                                                                                                                                                                                              |
| 4 — decision-resolver rehydration | Not needed                  | `methods/run.ts:473-494` already contains a setTimeout fallback: when all decisions resolve but the run stays `blocked`, it resets stale running steps and calls `startRun` to resume the pipeline. This covers the "gateway restart while awaiting a decision resolver" case without rehydrating resolvers on startup. Recording it here so future work doesn't re-invent the same recovery |
| 5 — self-review remote progress   | Not needed (mis-classified) | `remoteProgressEntries` holds `onContent` closures — not serializable state. On restart, self-review either re-runs (new closure) or the progress indicator stays stale until the next file change, at which point `startProgressWatcher` is re-invoked. Runtime-only by necessity, same category as PTY sessions                                                                            |
| 6 — auto-recycle failure counts   | Deferred                    | `SlotStatus` has no equivalent write-through-to-disk path like `Run`. Impact of losing the counter on restart is one extra 5-min scan cycle before hitting `maxFailures`. Below the churn threshold. Revisit if SlotStatus persistence gets a similar `updateSlot → persist` path                                                                                                            |

Net effect: the module-level `Map<string, ...>` instances that were **actually** causing restart-time bugs have been eliminated. The three remaining phases either need no code (Phase 4), can't be persisted structurally (Phase 5), or don't move the needle (Phase 6).

## Follow-ups

1. Add a lint rule (or code review checklist entry) forbidding new module-level `Map<string, …>` state keyed by `runId` or `slotId` in `services/gateway/src/`. Anything so keyed should live on the corresponding canonical object.
2. Revisit ADR-005 Option D (event log) once per-run history grows organically from grouped state fields.
3. If `SlotStatus` gains a durable `updateSlot → persist` path in the future, revisit Phase 6 to move `failureCounts` onto `SlotStatus.recycleState`.

## Amendment: Superseded in part by ADR-053 (2026-08-02)

[ADR-053](053-run-lifecycle-transition-routing.md) makes run lifecycle transitions an explicit
routed call instead of a side effect of emitting `RUN_UPDATED`.

ADR-027 made per-run state durable across restart. ADR-053 addresses the complementary gap: state
that is durable but _not propagated_ at write time, so it is only reconciled on the next restart.
The `Run.backlogReconcilePending` write-ahead marker exists because of that gap and is expected to
be removable once every transition is routed.
