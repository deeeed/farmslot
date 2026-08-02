// transition-router.ts — explicit routing for run lifecycle transitions (ADR-052).
//
// Before this module, a terminal run status only reached the backlog and the work
// graph if the caller happened to hold `observedBroadcast` (the interceptor built in
// index.ts). RPC handlers hold a per-request `emit` that writes to one socket, so
// `run.cancel` from Command Center settled nothing. All three emit values share the
// signature `(event, payload) => void`, so the difference is invisible at the call site.
//
// Here, call sites declare intent and the router performs the fan-out itself, in a
// declared order, awaiting each effect. Propagation no longer depends on which emit
// tier a caller received.

import { isTerminalRunStatus, type Run } from '@farmslot/protocol';

export type RunTransitionKind = 'cancel';

/** Who asked for the transition. Consumers use this instead of re-deriving intent. */
export type RunTransitionActor = 'operator' | 'engine' | 'recovery';

export interface RunTransitionRequest {
  kind: RunTransitionKind;
  runId: string;
  actor: RunTransitionActor;
  reason?: string;
}

export type RunTransitionEffectStatus = 'ok' | 'skipped' | 'failed';

export interface RunTransitionEffectOutcome {
  name: string;
  status: RunTransitionEffectStatus;
  /** Why it was skipped, or the failure message. Never dropped. */
  detail?: string;
}

export interface RunTransitionResult {
  run: Run;
  effects: RunTransitionEffectOutcome[];
}

/**
 * `required` aborts the transition on failure; `advisory` records the failure and
 * continues. Advisory is for work whose failure must not strand a terminal run —
 * never for work whose failure we are willing to lose silently.
 */
export type RunTransitionEffectSeverity = 'required' | 'advisory';

export interface RunTransitionEffectContext {
  /** The run after the core mutation. */
  run: Run;
  request: RunTransitionRequest;
  /**
   * Outcomes of the effects that already ran in this transition. Lets a later
   * effect refuse to act on state an earlier one failed to settle, instead of
   * silently operating on a stale read.
   */
  outcomes: readonly RunTransitionEffectOutcome[];
}

/** Return a bare status, or pair it with a reason worth surfacing on the result. */
export type RunTransitionEffectOutcomeInput =
  | RunTransitionEffectStatus
  | { status: RunTransitionEffectStatus; detail: string }
  | void;

export interface RunTransitionEffect {
  name: string;
  severity: RunTransitionEffectSeverity;
  /** Return 'skipped' when the effect does not apply to this run. */
  apply(context: RunTransitionEffectContext): Promise<RunTransitionEffectOutcomeInput>;
}

/** True when a named effect ran and failed; used by dependent effects to bail. */
export function effectFailed(
  outcomes: readonly RunTransitionEffectOutcome[],
  name: string,
): boolean {
  return outcomes.some((outcome) => outcome.name === name && outcome.status === 'failed');
}

export interface RunTransitionPlan {
  /** Effects that must run before the run reaches a terminal state. */
  before: RunTransitionEffect[];
  /** The single run-store mutation for this transition. */
  mutate(run: Run): Partial<Run>;
  /** Effects that fan the settled state out to the other aggregates. */
  after: RunTransitionEffect[];
}

export interface RunTransitionDeps {
  getRun(runId: string): Run | undefined;
  updateRun(runId: string, partial: Partial<Run>): Run;
  planFor(request: RunTransitionRequest, run: Run): RunTransitionPlan;
  /**
   * Called with the mutated run before the after-effects. Callers publish the
   * terminal state here so the UI reflects it immediately, without waiting on
   * slow teardown further down the effect list.
   */
  onMutated?(run: Run): void;
}

async function runEffects(
  effects: readonly RunTransitionEffect[],
  context: Omit<RunTransitionEffectContext, 'outcomes'>,
  outcomes: RunTransitionEffectOutcome[],
): Promise<void> {
  for (const effect of effects) {
    try {
      const returned = (await effect.apply({ ...context, outcomes })) ?? 'ok';
      const outcome =
        typeof returned === 'string'
          ? { name: effect.name, status: returned }
          : { name: effect.name, status: returned.status, detail: returned.detail };
      // A required effect that *returns* failed must abort exactly like one that
      // throws; otherwise severity is enforced only for the throwing path.
      if (effect.severity === 'required' && outcome.status === 'failed') {
        throw new Error(
          `Run transition effect '${effect.name}' failed: ${outcome.detail ?? 'reported failed'}`,
        );
      }
      outcomes.push(outcome);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (effect.severity === 'required') {
        // A required effect failing means the transition did not happen. Surface it
        // rather than leaving the run in a half-transitioned state.
        throw new Error(`Run transition effect '${effect.name}' failed: ${detail}`);
      }
      outcomes.push({ name: effect.name, status: 'failed', detail });
      console.warn(
        `[run-lifecycle] advisory effect '${effect.name}' failed for ${context.run.id.slice(0, 8)}: ${detail}`,
      );
    }
  }
}

/**
 * Per-run serialization. The terminal guard is only meaningful if nothing can
 * interleave between it and the mutation, and `before` effects await — which
 * yields the event loop. Without this, two concurrent cancels both pass the
 * guard and both run the full effect chain: duplicate mutation, duplicate
 * broadcast, duplicate settle/tick, and a stale second slot release that can
 * free a slot another run has already claimed.
 */
const transitionTails = new Map<string, Promise<unknown>>();

async function withRunTransitionLock<T>(runId: string, operation: () => Promise<T>): Promise<T> {
  const previous = transitionTails.get(runId) ?? Promise.resolve();
  const current = previous.then(operation, operation);
  // Store a settlement-normalized handle so a rejected transition cannot wedge
  // the queue for this run, and so the identity check below is exact.
  const tail: Promise<unknown> = current.then(
    () => undefined,
    () => undefined,
  );
  transitionTails.set(runId, tail);
  try {
    return await current;
  } finally {
    // Only the last transition for this run clears the entry; otherwise the map
    // would grow one entry per run for the process lifetime.
    if (transitionTails.get(runId) === tail) transitionTails.delete(runId);
  }
}

/**
 * Applies one lifecycle transition: guard, before-effects, single mutation,
 * `onMutated` publish, then after-effects awaited in declared order.
 *
 * Serialized per run — see {@link withRunTransitionLock}.
 */
export async function routeRunTransition(
  request: RunTransitionRequest,
  deps: RunTransitionDeps,
): Promise<RunTransitionResult> {
  return withRunTransitionLock(request.runId, async () => {
    // Guard inside the lock: a transition that queued behind another one must
    // observe the state that one left behind, not the state it was queued with.
    const existing = deps.getRun(request.runId);
    if (!existing) throw new Error(`Run not found: ${request.runId}`);
    if (isTerminalRunStatus(existing.status)) {
      throw new Error(`Run ${request.runId} already in terminal state: ${existing.status}`);
    }

    const plan = deps.planFor(request, existing);
    const effects: RunTransitionEffectOutcome[] = [];

    await runEffects(plan.before, { run: existing, request }, effects);

    const run = deps.updateRun(request.runId, plan.mutate(existing));
    // A UI publish must not abort store settlement, but it must not vanish either:
    // record it as a visible outcome instead of throwing or swallowing.
    if (deps.onMutated) {
      try {
        deps.onMutated(run);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        effects.push({ name: 'publish', status: 'failed', detail });
        console.warn(`[run-lifecycle] publish failed for ${run.id.slice(0, 8)}: ${detail}`);
      }
    }

    // Awaited and ordered: a later effect (the scheduler tick) must never observe an
    // earlier one (the backlog settle) half-applied.
    await runEffects(plan.after, { run, request }, effects);

    return { run, effects };
  });
}
