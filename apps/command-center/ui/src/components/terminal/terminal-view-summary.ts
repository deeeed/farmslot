import type { TmuxWorkerRef } from '@farmslot/protocol';

import { getRunForSlot, getState } from '../../state.js';

export interface TerminalRunSummary {
  slot: {
    taskId: string;
    lifecycle: string;
    agent: string;
    runner: string;
    model: string;
  } | null;
  summary: string;
}

export interface TerminalRunSummaryInput {
  slotId: string;
  runId: string;
  worker: TmuxWorkerRef | null;
  currentTaskId: string;
}

interface SlotRunSummary {
  taskId: string;
  lifecycle: string;
  agent: string;
  runner: string;
  model: string;
}

export function readTerminalRunSummary(input: TerminalRunSummaryInput): TerminalRunSummary | null {
  if (input.worker || !input.slotId) return null;

  const fleet = getState().fleet;
  const slot = fleet?.slots.find((candidate) => candidate.slot === input.slotId);
  const slotSummary: SlotRunSummary | null = slot
    ? {
        taskId: slot.taskId || '',
        lifecycle: slot.lifecycle,
        agent: slot.agent,
        runner: slot.runner ?? '',
        model: slot.model ?? '',
      }
    : null;
  const run = input.runId
    ? (getState().runs.find((candidate) => candidate.id === input.runId) ??
      getRunForSlot(input.slotId))
    : getRunForSlot(input.slotId);

  return {
    slot: slotSummary,
    summary: run?.summary || slotSummary?.taskId || input.currentTaskId || '',
  };
}
