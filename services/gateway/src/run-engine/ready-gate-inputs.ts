import { readFile } from 'node:fs/promises';

import type { ReadyGatePayload, Run } from '@farmslot/protocol';

type ReadyGateInputs = Pick<ReadyGatePayload, 'acceptanceCriteria' | 'inputSnapshot'>;

export async function buildReadyGateInputs(current: Run): Promise<ReadyGateInputs> {
  let taskPrompt: string | undefined;
  if (current.taskFile) {
    try {
      taskPrompt = await readFile(current.taskFile, 'utf-8');
    } catch (err) {
      // Legacy/recycled runs can point at a task file that has already been
      // removed. The ready gate can still render ticket/input metadata, but
      // operators need the missing prompt surfaced in logs rather than hidden.
      console.warn(
        `[run-engine] ready-gate task prompt read failed for ${current.id.slice(0, 8)} at ${current.taskFile}: ${(err as Error).message}`,
      );
    }
  }

  return {
    acceptanceCriteria: current.ticketData?.acceptanceCriteria?.length
      ? current.ticketData.acceptanceCriteria
      : undefined,
    inputSnapshot: {
      ...(current.ticketData ? { ticketData: current.ticketData } : {}),
      taskFile: current.taskFile,
      ...(taskPrompt ? { taskPrompt } : {}),
      ...(current.engineState?.interactiveDev?.initialContext
        ? { initialContext: current.engineState.interactiveDev.initialContext }
        : {}),
      ...(current.engineState?.interactiveDev?.checklist?.length
        ? { checklist: current.engineState.interactiveDev.checklist }
        : {}),
      ...(current.templateProvenance ? { templateProvenance: current.templateProvenance } : {}),
    },
  };
}
