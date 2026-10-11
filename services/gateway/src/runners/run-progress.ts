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
import { readNativeWorkerSnapshot } from './native/worker-control.js';
import { classifyMonitorProgress, type MonitorProgressKind } from './observability-progress.js';
import type { ObservabilityReading } from './observability-types.js';
import { readRunnerActivityFromObservability, readRunnerTurnState } from './registry.js';
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
  turnActive: typeof runnerTurnLeaseIsActive;
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
  turnActive: runnerTurnLeaseIsActive,
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
          : state === 'idle' || (state === 'closed' && snapshot.session.processStopped)
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
  const target = run.reviewWorkspace
    ? context?.target
    : await source.target(run.slotId!, {
        runId: run.id,
        contextId: context?.id,
        role: context?.role ?? 'primary',
      });
  if (!target?.target) return { kind: 'unproven', activeRole };
  const runner = normalizeRunner(context?.runner ?? run.metrics.runner);
  const [activity, turnState] = await Promise.all([
    source.activity(vars, target.target, runner),
    source.turn(vars, target.target, runner),
  ]);
  const kind = classifyMonitorProgress({
    activity: structured(activity),
    turnState: structured(turnState),
  });
  if (kind === 'making-progress' && activeRole === 'review-fix') {
    const receipt = context?.promptAcceptance;
    const accepted =
      receipt?.turnToken &&
      receipt.deliveryStartedAt === context?.promptDeliveryStartedAt &&
      (await source.turnActive(vars, target.target, runner, receipt.turnToken));
    return { kind: kind === 'making-progress' && accepted ? kind : 'unproven', activeRole };
  }
  return { kind, activeRole };
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
    contexts.map(async (context) => {
      try {
        return await observeContext(run, context ?? undefined, source);
      } catch (error) {
        // A lost transport or ownership binding is uncertainty, never proof of idle.
        return {
          kind: 'unproven' as const,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
  return (
    observations.find((observation) => observation.kind === 'making-progress') ??
    observations.find((observation) => observation.kind === 'unproven') ??
    observations.find((observation) => observation.kind === 'awaiting-input') ?? { kind: 'idle' }
  );
}
