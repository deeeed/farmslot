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

export const HUMAN_GATE_DECISION_TYPE = 'engine_human_gate';

const NEEDS_YOUR_DECISION = 'Needs your decision';

/** The fields of a run decision the lifecycle view reads. */
type GateDecisionFields = { type: string; resolvedAt?: string; payload?: unknown };

/** The run's latest unresolved human gate, if any. */
export function openHumanGateDecision<D extends GateDecisionFields>(
  run: { decisions?: readonly D[] } | null | undefined,
): D | null {
  const decisions = run?.decisions ?? [];
  for (let index = decisions.length - 1; index >= 0; index -= 1) {
    const decision = decisions[index]!;
    if (decision.type === HUMAN_GATE_DECISION_TYPE && !decision.resolvedAt) return decision;
  }
  return null;
}

/**
 * A blocked run whose human gate is open waits for a person's decision, not on a
 * fault: it reads as needing one, with the gate's first readiness reason.
 */
function gateDecisionWait(run: {
  status: RunStatus;
  decisions?: readonly GateDecisionFields[];
}): { reason?: string } | undefined {
  if (run.status !== 'blocked') return undefined;
  const decision = openHumanGateDecision(run);
  if (!decision) return undefined;
  const readiness = isRecord(decision.payload) ? decision.payload.gateReadiness : undefined;
  const reason = isGateReadiness(readiness) ? readiness.reasons[0]?.message : undefined;
  return reason ? { reason } : {};
}

/** A run's status as a badge shows it: a blocked run at its open human gate needs a decision. */
export function runDisplayStatus(run: {
  status: RunStatus;
  decisions?: readonly GateDecisionFields[];
}): string {
  return gateDecisionWait(run) ? NEEDS_YOUR_DECISION : run.status;
}

/** Both clients and the CLI present the gateway's state and prerequisite reasons. */
export function deriveRunLifecycleView(input: {
  status: RunStatus;
  gateReadiness?: unknown;
  waitingForOperator?: WorkerOperatorWait;
  error?: string | null;
  decisions?: readonly GateDecisionFields[];
}): RunLifecycleView {
  const blockedReason = blockedRunReason(input.error);
  const gateWait = gateDecisionWait(input);
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
    label: gateWait ? NEEDS_YOUR_DECISION : labels[input.status],
    ...(gateWait
      ? {
          activityLabel: gateWait.reason
            ? `${NEEDS_YOUR_DECISION}: ${gateWait.reason}`
            : NEEDS_YOUR_DECISION,
        }
      : input.status === 'blocked'
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
 * (the last one neither pending nor skipped) shows as blocked. A run waiting at its
 * open human gate keeps that step as it is.
 */
export function runStepDisplayStatus(
  run: {
    status: RunStatus;
    steps: readonly Pick<RunStep, 'name' | 'status'>[];
    decisions?: readonly GateDecisionFields[];
  },
  step: Pick<RunStep, 'name' | 'status'>,
): RunStepDisplayStatus {
  if (
    run.status === 'blocked' &&
    !gateDecisionWait(run) &&
    step.name ===
      [...run.steps].reverse().find((s) => s.status !== 'pending' && s.status !== 'skipped')?.name
  )
    return 'blocked';
  if (run.status === 'cancelled' && (step.status === 'running' || step.status === 'pending'))
    return 'skipped';
  return step.status;
}

/**
 * A step's detail as clients show it: a blocked run's reason on the step it stopped
 * at, and the gate's readiness reason on a human gate that waits for a decision.
 */
export function runStepDisplayDetail(
  run: {
    status: RunStatus;
    steps: readonly Pick<RunStep, 'name' | 'status'>[];
    error?: string | null;
    decisions?: readonly GateDecisionFields[];
  },
  step: Pick<RunStep, 'name' | 'status' | 'detail'>,
): string | undefined {
  const gateWait = step.name === 'human-gate' && step.status === 'running' && gateDecisionWait(run);
  if (gateWait) return gateWait.reason ?? step.detail;
  return runStepDisplayStatus(run, step) === 'blocked'
    ? (blockedRunReason(run.error) ?? step.detail)
    : step.detail;
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
