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
}

export interface RunTransitionEffect {
  name: string;
  severity: RunTransitionEffectSeverity;
  /** Return 'skipped' when the effect does not apply to this run. */
  apply(context: RunTransitionEffectContext): Promise<RunTransitionEffectStatus | void>;
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
  context: RunTransitionEffectContext,
  outcomes: RunTransitionEffectOutcome[],
): Promise<void> {
  for (const effect of effects) {
    try {
      const status = (await effect.apply(context)) ?? 'ok';
      outcomes.push({ name: effect.name, status });
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
 * Applies one lifecycle transition: guard, before-effects, single mutation,
 * `onMutated` publish, then after-effects awaited in declared order.
 */
export async function routeRunTransition(
  request: RunTransitionRequest,
  deps: RunTransitionDeps,
): Promise<RunTransitionResult> {
  const existing = deps.getRun(request.runId);
  if (!existing) throw new Error(`Run not found: ${request.runId}`);
  if (isTerminalRunStatus(existing.status)) {
    throw new Error(`Run ${request.runId} already in terminal state: ${existing.status}`);
  }

  const plan = deps.planFor(request, existing);
  const effects: RunTransitionEffectOutcome[] = [];

  await runEffects(plan.before, { run: existing, request }, effects);

  const run = deps.updateRun(request.runId, plan.mutate(existing));
  deps.onMutated?.(run);

  // Awaited and ordered: a later effect (the scheduler tick) must never observe an
  // earlier one (the backlog settle) half-applied.
  await runEffects(plan.after, { run, request }, effects);

  return { run, effects };
}
