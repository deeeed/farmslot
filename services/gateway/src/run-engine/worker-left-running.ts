import { randomUUID } from 'node:crypto';

import {
  Events,
  PipelineSteps,
  type Run,
  type RunDecision,
  type RunStep,
} from '@farmslot/protocol';

import { pendingDecisionForRun } from './decision-projection.js';

/** The card a failing run waits on while its agents may still be running (F328). */
export const WORKER_LEFT_RUNNING_DECISION = 'engine_worker_left_running';
export const REPLAY_STEP_ACTION = 'replay-step';
export const CANCEL_RUN_ACTION = 'cancel-run';

export function workerLeftRunningDecision(
  run: Run,
  stepName: string,
  reason: string,
  running: readonly string[],
): RunDecision {
  return {
    id: randomUUID(),
    type: WORKER_LEFT_RUNNING_DECISION,
    title: `${run.ticketOrPr || `Run ${run.id.slice(0, 8)}`} — worker left running after ${stepName} error`,
    description: `${reason}\n\nStill running: ${running.join(', ')}. No signal file or exit shows they finished, so nothing was stopped.`,
    actions: [
      {
        id: REPLAY_STEP_ACTION,
        label: 'Replay step',
        style: 'primary',
        // Only the monitor just observes; any other step may restart what it launched.
        description:
          stepName === PipelineSteps.MONITOR
            ? 'Watch the running agents again. They are kept.'
            : `Run ${stepName} again. It may restart the running agents.`,
      },
      {
        id: CANCEL_RUN_ACTION,
        label: 'Cancel run',
        style: 'danger',
        description: 'Cancel the run and stop its agents.',
      },
    ],
    createdAt: new Date().toISOString(),
    context: { step: stepName, agents: [...running] },
  };
}

/**
 * Block the run on the card, its failed step keeping the worker and slot. The card's Replay step
 * resumes the run at that step. The engine's failing step and restart recovery both land here.
 */
export function holdRunOnWorkerLeftRunningCard(
  deps: {
    updateRunStep: (runId: string, stepName: string, fields: Partial<RunStep>) => unknown;
    updateRun: (runId: string, fields: Partial<Run>) => unknown;
    getRun: (runId: string) => Run | undefined;
    broadcast: (event: string, payload: unknown) => void;
  },
  run: Run,
  stepName: string,
  reason: string,
  running: readonly string[],
  stepOutputs?: Record<string, unknown>,
): void {
  const decision = workerLeftRunningDecision(run, stepName, reason, running);
  deps.updateRunStep(run.id, stepName, {
    status: 'failed',
    detail: reason,
    ...(stepOutputs ? { outputs: stepOutputs } : {}),
  });
  deps.updateRun(run.id, {
    status: 'blocked',
    error: reason,
    decisions: [...run.decisions, decision],
  });
  deps.broadcast(Events.RUN_DECISION_NEW, {
    runId: run.id,
    decision: pendingDecisionForRun(deps.getRun(run.id) ?? run, decision),
    slotId: run.slotId,
  });
  deps.broadcast(Events.RUN_UPDATED, { run: deps.getRun(run.id) });
}

/** A replay of the run answers its open "worker left running" card. */
export function answerWorkerLeftRunningCards(decisions: RunDecision[], at: string): RunDecision[] {
  return decisions.map((decision) =>
    decision.type === WORKER_LEFT_RUNNING_DECISION && !decision.resolvedAt
      ? { ...decision, resolvedAt: at, resolvedAction: REPLAY_STEP_ACTION }
      : decision,
  );
}
