import { randomUUID } from 'node:crypto';

import type { Run, RunDecision } from '@farmslot/protocol';

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
        description: `Run ${stepName} again. The running agents are kept.`,
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
