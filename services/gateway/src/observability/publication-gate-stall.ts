import { type AgentContext, isTerminalRunStatus, type Run } from '@farmslot/protocol';

import { loadSlotVars } from '../core/config.js';
import { resolveExactTmuxWindowPane } from '../core/tmux.js';
import {
  nativeWorkerLiveStatus,
  readNativeWorkerSnapshot,
} from '../runners/native/worker-control.js';
import { probeRunnerDescendantPid } from '../runners/session-process.js';

export type ReviewerLiveness = 'present' | 'absent' | 'unknown';
export type ReadReviewerLiveness = (run: Run, context: AgentContext) => Promise<ReviewerLiveness>;

/** Only preparation promises a reviewer. A presented operator decision may wait indefinitely. */
export function publicationGateIsOverdue(run: Run, now: number): boolean {
  const gate = run.steps.find(({ name }) => name === 'human-gate');
  const started = Date.parse(gate?.startedAt ?? '');
  return (
    !isTerminalRunStatus(run.status) &&
    run.status !== 'paused' &&
    gate?.status === 'running' &&
    Number.isFinite(started) &&
    now - started > 10 * 60_000 &&
    !run.decisions.some((decision) => !decision.resolvedAt && decision.type === 'engine_human_gate')
  );
}

export async function readReviewerLiveness(
  run: Run,
  context: AgentContext,
): Promise<ReviewerLiveness> {
  if (context.nativeSession?.closedAt) return 'absent';
  try {
    if (context.nativeSession) {
      const state = nativeWorkerLiveStatus(
        await readNativeWorkerSnapshot(run.id, 'review', context.id, { failurePolicy: 'observe' }),
      );
      return state === 'working' ? 'present' : state === 'idle' ? 'absent' : 'unknown';
    }
    if (!run.slotId || !context.target) return 'unknown';
    const vars = await loadSlotVars(run.slotId);
    const pane = await resolveExactTmuxWindowPane(
      vars,
      context.target.paneId ?? context.target.target,
    );
    if (!pane) return 'absent';
    return (await probeRunnerDescendantPid(vars, pane.panePid, context.runner)).state;
  } catch {
    // A disconnected node or unverified session proves neither presence nor absence.
    return 'unknown';
  }
}

/** Read-only stall evidence. Old verdicts cannot complete a newer warm attempt. */
export async function publicationGateStallReason(
  run: Run,
  now: number,
  read: ReadReviewerLiveness = readReviewerLiveness,
): Promise<string | undefined> {
  if (!publicationGateIsOverdue(run, now)) return undefined;
  const reviews = run.engineState?.publishGate?.reviews ?? [];
  const contexts = (run.agentContexts ?? []).filter(({ role }) => role === 'review');
  const active = contexts.filter(({ status }) =>
    ['launching', 'working', 'waiting'].includes(status),
  );
  // A review's worker-fix phase legitimately has no live reviewer.
  if (
    run.agentContexts?.some(
      ({ role, status }) =>
        role === 'review-fix' && ['launching', 'working', 'waiting'].includes(status),
    )
  )
    return undefined;
  const activeReviewWithoutVerdict = active.some(
    (context) =>
      !reviews.some((review) => {
        if (review.verdict === 'pending') return false;
        const completed = Date.parse(
          review.completedAt ?? review.attempts?.at(-1)?.completedAt ?? '',
        );
        const launched = Date.parse(context.startedAt ?? '');
        const lineage = review.session?.reviewId ?? review.id;
        return (
          (context.artifactScope === review.id || context.reviewId === lineage) &&
          Number.isFinite(completed) &&
          Number.isFinite(launched) &&
          completed >= launched
        );
      }),
  );
  if (!activeReviewWithoutVerdict && reviews.some(({ verdict }) => verdict !== 'pending'))
    return 'gate review verdict is recorded but publication preparation has not reached an operator decision';
  if (!reviews.length && !contexts.length && !run.engineState?.publishGate?.reviewSequence?.length)
    return undefined;
  const readings = await Promise.all(active.map((context) => read(run, context)));
  if (readings.every((state) => state === 'absent'))
    return 'no live reviewer process or session remains for the gate review';
  return undefined;
}
