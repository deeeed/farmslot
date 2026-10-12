import { isRecord } from '../recipe/common.js';

import type { RunGatePrerequisiteReason, RunGateReadiness } from './run-gate-readiness.js';
import type { RunStatus } from './runs.js';

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
}): RunLifecycleView {
  const readiness = isGateReadiness(input.gateReadiness) ? input.gateReadiness : undefined;
  const canAdvance = readiness?.state === 'ready' && input.status === 'human-gating';
  const tone =
    input.status === 'done'
      ? 'ok'
      : input.status === 'failed'
        ? 'fail'
        : ['blocked', 'paused', 'review-failed', 'reconciling', 'cancelled'].includes(input.status)
          ? 'warn'
          : input.status === 'created'
            ? 'muted'
            : 'running';
  return {
    status: input.status,
    label: labels[input.status],
    ...(['fixing', 'review-failed', 'reconciling'].includes(input.status)
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
