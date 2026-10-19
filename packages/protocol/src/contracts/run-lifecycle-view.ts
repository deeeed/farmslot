import { isRecord } from '../recipe/common.js';
import type { WorkerOperatorWait } from '../transport/signal.js';

import type { RunGatePrerequisiteReason, RunGateReadiness } from './run-gate-readiness.js';
import type { RunStatus, RunStep, RunStepStatus } from './runs.js';

/** A step as the clients show it: `blocked` marks the step a blocked run stopped at. */
export type RunStepDisplayStatus = RunStepStatus | 'blocked';

export interface RunLifecycleView {
  status: RunStatus;
  label: string;
  activityLabel?: string;
  tone: 'ok' | 'running' | 'warn' | 'fail' | 'muted';
  gateLabel?: string;
  canAdvance: boolean;
  reasons: readonly RunGatePrerequisiteReason[];
}

const labels: Record<RunStatus, string> = {
  created: 'Created',
  grading: 'Grading',
  'writing-task': 'Writing task',
  'slot-finding': 'Finding slot',
  preparing: 'Preparing',
  dispatching: 'Dispatching',
  monitoring: 'Working',
  reviewing: 'Reviewing',
  fixing: 'Fixing',
  'review-failed': 'Review failed',
  reconciling: 'Reconciling',
  completing: 'Completing',
  'human-gating': 'Awaiting decision',
  'needs-decision': 'Needs decision',
  'ci-watching': 'Watching CI',
  paused: 'Paused',
  done: 'Done',
  blocked: 'Blocked',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/** Both clients and the CLI present the gateway's state and prerequisite reasons. */
export function deriveRunLifecycleView(input: {
  status: RunStatus;
  gateReadiness?: unknown;
  waitingForOperator?: WorkerOperatorWait;
  error?: string | null;
}): RunLifecycleView {
  const blockedReason = blockedRunReason(input.error);
  const readiness = isGateReadiness(input.gateReadiness) ? input.gateReadiness : undefined;
  const canAdvance = readiness?.state === 'ready' && input.status === 'human-gating';
  const tone =
    input.status === 'done'
      ? 'ok'
      : input.status === 'failed'
        ? 'fail'
        : [
              'blocked',
              'paused',
              'review-failed',
              'reconciling',
              'needs-decision',
              'cancelled',
            ].includes(input.status)
          ? 'warn'
          : input.status === 'created'
            ? 'muted'
            : 'running';
  return {
    status: input.status,
    label: labels[input.status],
    ...(input.status === 'blocked'
      ? { activityLabel: blockedReason ? `Blocked: ${blockedReason}` : labels.blocked }
      : input.waitingForOperator && ['monitoring', 'reviewing', 'fixing'].includes(input.status)
        ? { activityLabel: `Waiting on operator: ${input.waitingForOperator.who}` }
        : ['fixing', 'review-failed', 'reconciling', 'needs-decision'].includes(input.status)
          ? { activityLabel: labels[input.status] }
          : {}),
    tone,
    ...(readiness
      ? {
          gateLabel:
            readiness.state === 'ready'
              ? canAdvance
                ? 'Ready for decision'
                : labels[input.status]
              : readiness.state === 'collecting'
                ? 'Collecting prerequisites'
                : 'Prerequisites incomplete',
        }
      : {}),
    canAdvance,
    reasons: readiness?.reasons ?? [],
  };
}

/** A blocked run's reason on one line: the first non-empty line of its error. */
export function blockedRunReason(error?: string | null): string | undefined {
  return error
    ?.split('\n')
    .map((line) => line.trim())
    .find(Boolean);
}

/**
 * The status a client shows for a run's step. A cancelled run's unfinished steps
 * read as skipped. The engine records the step a blocked run stopped at as done
 * and every later step as skipped, which reads as a finished run, so that step
 * (the last one neither pending nor skipped) shows as blocked.
 */
export function runStepDisplayStatus(
  run: { status: RunStatus; steps: readonly Pick<RunStep, 'name' | 'status'>[] },
  step: Pick<RunStep, 'name' | 'status'>,
): RunStepDisplayStatus {
  if (
    run.status === 'blocked' &&
    step.name ===
      [...run.steps].reverse().find((s) => s.status !== 'pending' && s.status !== 'skipped')?.name
  )
    return 'blocked';
  if (run.status === 'cancelled' && (step.status === 'running' || step.status === 'pending'))
    return 'skipped';
  return step.status;
}

function isGateReadiness(value: unknown): value is RunGateReadiness {
  return (
    isRecord(value) &&
    ['collecting', 'not-ready', 'ready'].includes(String(value.state)) &&
    isRecord(value.identity) &&
    typeof value.identity.runId === 'string' &&
    typeof value.identity.generation === 'number' &&
    Array.isArray(value.reasons) &&
    value.reasons.every(
      (reason) =>
        isRecord(reason) &&
        typeof reason.code === 'string' &&
        typeof reason.message === 'string' &&
        ['deterministic', 'acceptance', 'evidence', 'review', 'lifecycle'].includes(
          String(reason.prerequisite),
        ),
    )
  );
}
