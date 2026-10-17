import { PipelineSteps, type Run, type SourcePinTarget } from '@farmslot/protocol';

export interface SourcePinTargetState {
  knownNodes: readonly string[];
  activatedAt: string;
  run?: Pick<
    Run,
    | 'id'
    | 'createdAt'
    | 'status'
    | 'steps'
    | 'decisions'
    | 'sourcePlan'
    | 'sourceProvenance'
    | 'metrics'
    | 'recoveryAttempts'
  >;
}

type SourcePinRun = NonNullable<SourcePinTargetState['run']>;

/** A run accepts source pins until admission or its first effect. */
export function runSourcesSelectable(run: SourcePinRun): boolean {
  // FIND_SLOT stores its pending slot-picker decision as blocked before admission.
  const waitingForSlot =
    run.status === 'blocked' &&
    run.steps.some((step) => step.name === PipelineSteps.FIND_SLOT && step.status === 'running') &&
    run.decisions.some(
      (decision) =>
        decision.type === 'engine_no_suitable_slot' &&
        !decision.resolvedAt &&
        decision.payload?.kind === 'slot_picker',
    );
  return !(
    !run.sourcePlan ||
    run.sourcePlan.lock.context.runId !== run.id ||
    run.sourceProvenance ||
    (!['created', 'slot-finding', 'human-gating'].includes(run.status) && !waitingForSlot) ||
    run.steps.some(
      (step) =>
        step.name !== PipelineSteps.FIND_SLOT &&
        step.status !== 'pending' &&
        step.status !== 'skipped',
    ) ||
    run.metrics.runnerSessionId ||
    run.recoveryAttempts?.length
  );
}

/** Recheck authoritative target state both before fetching and before publishing a pin. */
export function assertSourcePinTarget(target: SourcePinTarget, state: SourcePinTargetState): void {
  if (target.scope === 'farm' && target.targetId === 'farm') return;
  if (target.scope === 'node') {
    if (!state.knownNodes.includes(target.targetId))
      throw new Error(`Unknown source node target: ${target.targetId}`);
    return;
  }
  if (target.scope !== 'run') throw new Error('Select one source pin scope and its target');
  const run = state.run;
  if (!run || run.id !== target.targetId)
    throw new Error(`Unknown source run target: ${target.targetId}`);
  const created = Date.parse(run.createdAt);
  const activated = Date.parse(state.activatedAt);
  if (!Number.isFinite(created) || !Number.isFinite(activated) || created < activated)
    throw new Error(`Historical source inputs cannot change: ${run.id}`);
  if (!runSourcesSelectable(run))
    throw new Error(`Run source inputs are admitted or have effects: ${run.id}`);
}
