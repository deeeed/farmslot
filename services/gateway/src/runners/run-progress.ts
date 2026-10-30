import {
  ACTIVE_RUN_STATUSES,
  type AgentContext,
  type AgentRole,
  normalizeRunner,
  type Run,
  type RunGateReadiness,
  type RunStatus,
} from '@farmslot/protocol';

import { resolveAgentTarget, selectAgentContext } from '../agents/contexts.js';
import { loadSlotVars } from '../core/config.js';
import { nativeFixTurnIsActive } from '../review/native-fix.js';
import { runnerTurnLeaseIsActive } from '../review/worker-lifecycle.js';

import { readReviewWorkspaceWorker } from './native/review-workspace.js';
import { nativeWorkerLiveStatus, readNativeWorkerSnapshot } from './native/worker-control.js';
import { classifyMonitorProgress, type MonitorProgressKind } from './observability-progress.js';
import type { ObservabilityReading, RunnerTaskProgressReader } from './observability-types.js';
import {
  readRunnerActivityFromObservability,
  readRunnerBackgroundWorkState,
  readRunnerTurnState,
} from './registry.js';
import { readRetainedWorkerProgressTarget } from './retained-worker-progress.js';
import { reviewWorkspaceRunnerVars } from './review-startup.js';

export interface RunProgressObservation {
  kind: MonitorProgressKind;
  activeRole?: AgentRole;
  reason?: string;
}

/** A pending decision does not stop work that the runner still confirms active. */
export function runDecisionWaitingStatus(
  run: Run,
  progress: RunProgressObservation,
  reason: string,
  readiness?: RunGateReadiness,
): RunStatus {
  if (progress.kind === 'making-progress') {
    if (progress.activeRole === 'review-fix') return 'fixing';
    if (progress.activeRole === 'review') return 'reviewing';
    return ACTIVE_RUN_STATUSES.includes(run.status) &&
      !['fixing', 'reviewing', 'reconciling'].includes(run.status)
      ? run.status
      : 'monitoring';
  }
  if (progress.kind === 'unproven') return 'reconciling';
  if (run.engineState?.publishGate?.reviewRecovery?.status === 'operator-required')
    return 'review-failed';
  if (
    readiness?.reasons.some(
      (reason) =>
        reason.code === 'review-document-missing' || reason.code === 'review-result-invalid',
    )
  )
    return 'review-failed';
  if (readiness?.state === 'not-ready') return 'blocked';
  return progress.kind === 'idle' && ['human_gate', 'review_posting', 'no_change'].includes(reason)
    ? 'human-gating'
    : 'blocked';
}

function structured<T>(reading: ObservabilityReading<T> | null): ObservabilityReading<T> | null {
  return reading?.confidence === 'high' && reading.source !== 'pane' && reading.source !== 'unknown'
    ? reading
    : null;
}

interface RunProgressReaders {
  native: typeof readNativeWorkerSnapshot;
  workspace: typeof readReviewWorkspaceWorker;
  nativeFixActive: typeof nativeFixTurnIsActive;
  slot: typeof loadSlotVars;
  workspaceVars: typeof reviewWorkspaceRunnerVars;
  target: typeof resolveAgentTarget;
  activity: typeof readRunnerActivityFromObservability;
  turn: typeof readRunnerTurnState;
  background: typeof readRunnerBackgroundWorkState;
  turnActive: typeof runnerTurnLeaseIsActive;
  taskProgress: RunnerTaskProgressReader;
  retainedTarget: typeof readRetainedWorkerProgressTarget;
}

const progressReaders: RunProgressReaders = {
  native: readNativeWorkerSnapshot,
  workspace: readReviewWorkspaceWorker,
  nativeFixActive: nativeFixTurnIsActive,
  slot: loadSlotVars,
  workspaceVars: reviewWorkspaceRunnerVars,
  target: resolveAgentTarget,
  activity: readRunnerActivityFromObservability,
  turn: readRunnerTurnState,
  background: readRunnerBackgroundWorkState,
  turnActive: runnerTurnLeaseIsActive,
  // Registry and lifecycle consumers form a cycle; look up this capability after initialization.
  taskProgress: async (input) => (await import('./registry.js')).readRunnerTaskProgress(input),
  retainedTarget: readRetainedWorkerProgressTarget,
};

async function observeContext(
  run: Run,
  context: AgentContext | undefined,
  source: RunProgressReaders,
): Promise<RunProgressObservation> {
  const activeRole = context?.role;
  if (run.reviewWorkspace?.cleanedAt) return { kind: 'idle', activeRole };
  if (run.transport === 'native' || context?.nativeSession) {
    const snapshot = run.reviewWorkspace
      ? await source.workspace(run.id, { allowGate: true })
      : await source.native(run.id, context?.role, context?.id);
    const state = snapshot.session.state;
    if (state === 'running' && activeRole === 'review-fix') {
      return {
        kind:
          state === 'running' &&
          context?.nativeCommandId &&
          (await source.nativeFixActive(run.id, context.nativeCommandId))
            ? 'making-progress'
            : 'unproven',
        activeRole,
      };
    }
    return {
      kind:
        state === 'running'
          ? 'making-progress'
          : state === 'idle' || nativeWorkerLiveStatus(snapshot) === 'idle'
            ? 'idle'
            : state === 'waiting'
              ? 'awaiting-input'
              : 'unproven',
      activeRole,
    };
  }
  if (!run.slotId && !run.reviewWorkspace)
    return { kind: context?.target || run.reviewWorkspace ? 'unproven' : 'idle', activeRole };
  const vars = run.reviewWorkspace
    ? await source.workspaceVars(run)
    : await source.slot(run.slotId!);
  if (!vars) return { kind: 'unproven', activeRole };
  const taskProgress = await source.taskProgress({ run, context, vars });
  if (taskProgress !== null) return { kind: taskProgress, activeRole };
  const target = run.reviewWorkspace
    ? context?.target
    : await source.target(run.slotId!, {
        runId: run.id,
        contextId: context?.id,
        role: context?.role ?? 'primary',
      });
  if (!target?.target) return { kind: 'unproven', activeRole };
  const runner = normalizeRunner(context?.runner ?? run.metrics.runner);
  const observeTarget = async (observedTarget: string): Promise<RunProgressObservation> => {
    const [activity, turnState, backgroundWork] = await Promise.all([
      source.activity(vars, observedTarget, runner),
      source.turn(vars, observedTarget, runner),
      source.background(vars, observedTarget, runner),
    ]);
    const kind = classifyMonitorProgress({
      activity: structured(activity),
      turnState: structured(turnState),
      backgroundWork,
    });
    if (kind === 'making-progress' && activeRole === 'review-fix') {
      const receipt = context?.promptAcceptance;
      const accepted =
        receipt?.turnToken &&
        receipt.deliveryStartedAt === context?.promptDeliveryStartedAt &&
        (await source.turnActive(vars, observedTarget, runner, receipt.turnToken));
      return { kind: kind === 'making-progress' && accepted ? kind : 'unproven', activeRole };
    }
    return { kind, activeRole };
  };
  const progress = await observeTarget(target.target);
  // The worker has handed off at a publication gate, COMPLETE or FINALIZE; review fixes are over.
  const handedOff =
    run.decisions.some((decision) => !decision.resolvedAt && decision.payload?.kind === 'ready') ||
    run.steps.some(
      (step) => (step.name === 'complete' || step.name === 'finalize') && step.status === 'running',
    );
  if (progress.kind !== 'unproven' || !context?.target?.paneId || !handedOff) return progress;
  const retained = await source.retainedTarget(vars, context);
  if (retained.state === 'absent')
    return {
      kind: 'idle',
      activeRole,
      reason: 'Recorded worker pane is gone and its slot has no live runner',
    };
  if (retained.state === 'unknown') return { ...progress, reason: retained.reason };
  return observeTarget(retained.target);
}

/** Observe one owned worker without letting an unrelated role mask its state. */
export async function readAgentContextProgress(
  run: Run,
  context: AgentContext | undefined,
  overrides: Partial<RunProgressReaders> = {},
): Promise<RunProgressObservation> {
  try {
    return await observeContext(run, context, { ...progressReaders, ...overrides });
  } catch (error) {
    return { kind: 'unproven', reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Kernel/process existence and pane text cannot establish that a turn progresses. */
export async function readRunProgress(
  run: Run,
  overrides: Partial<RunProgressReaders> = {},
): Promise<RunProgressObservation> {
  const source = { ...progressReaders, ...overrides };
  const ownedRunner = run.agentContexts?.some(
    (context) =>
      context.target ||
      context.nativeSession ||
      context.nativeSessionOwner ||
      context.runnerSessionId,
  );
  const uncertainDelivery = run.steps.some(
    (step) => step.outputs?.promptDeliveryUncertain || step.outputs?.nativeWorkerOperationUncertain,
  );
  if (
    !run.reviewWorkspace &&
    !ownedRunner &&
    !uncertainDelivery &&
    run.steps.some((step) => step.name === 'dispatch' && step.status === 'pending')
  )
    return { kind: 'idle' };
  const primary = selectAgentContext(run, { role: 'primary' });
  const acceptedFix = run.agentContexts?.find(
    (context) =>
      context.role === 'review-fix' &&
      ['working', 'launching', 'waiting'].includes(context.status) &&
      (Boolean(context.nativeCommandId) ||
        (context.promptAcceptance?.deliveryStartedAt === context.promptDeliveryStartedAt &&
          Boolean(context.promptAcceptance?.turnToken))),
  );
  const contexts = [
    ...(acceptedFix ? [acceptedFix] : []),
    ...(!acceptedFix || primary?.id !== acceptedFix.id ? [primary] : []),
    ...(run.agentContexts ?? []).filter(
      (context) =>
        context.id !== primary?.id &&
        context.id !== acceptedFix?.id &&
        ['working', 'launching', 'waiting', 'blocked'].includes(context.status),
    ),
  ];
  const observations = await Promise.all(
    contexts.map((context) => readAgentContextProgress(run, context ?? undefined, source)),
  );
  return (
    observations.find((observation) => observation.kind === 'making-progress') ??
    observations.find((observation) => observation.kind === 'unproven') ??
    observations.find((observation) => observation.kind === 'awaiting-input') ?? { kind: 'idle' }
  );
}
