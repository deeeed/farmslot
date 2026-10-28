import type { Run } from '@farmslot/protocol';

import {
  deliverOperatorInstruction,
  OperatorInstructionNotAttemptedError,
} from './operator-instruction.js';

interface InstructionWindow {
  startedAt: number;
  observeSince?: number;
}
interface InstructionIntent {
  key: string;
  text: string;
  contextId?: string;
  commandId?: string;
}
interface InstructionPersistence {
  /** Select and record the window atomically in the caller's owning store. */
  recordPending(
    begin: (savedStartedAt?: number) => InstructionWindow,
  ): Promise<InstructionWindow | null>;
  clearPending(startedAt: number): Promise<void>;
}

/** One retry contract for both operator messages and completion feedback. */
export async function deliverOperatorInstructionWithIntent(
  currentRun: () => Promise<Run>,
  instruction: InstructionIntent,
  persistence: InstructionPersistence,
): Promise<{
  delivery: Awaited<ReturnType<typeof deliverOperatorInstruction>>;
  startedAt?: number;
}> {
  const proposedStartedAt = Date.now();
  const window = await persistence.recordPending((savedStartedAt) => ({
    startedAt: savedStartedAt ?? proposedStartedAt,
    observeSince: savedStartedAt,
  }));
  if (!window) return { delivery: 'confirmed' };
  let delivery: Awaited<ReturnType<typeof deliverOperatorInstruction>>;
  try {
    delivery = await deliverOperatorInstruction(
      await currentRun(),
      instruction.key,
      instruction.text,
      window.observeSince,
      instruction.contextId,
      instruction.commandId,
    );
  } catch (error) {
    if (error instanceof OperatorInstructionNotAttemptedError) {
      try {
        await persistence.clearPending(window.startedAt);
      } catch (clearError) {
        throw new AggregateError(
          [error, clearError],
          'Instruction failed and its untouched intent could not be reset',
        );
      }
    }
    throw error;
  }
  if (delivery === 'not-attempted') await persistence.clearPending(window.startedAt);
  return { delivery, startedAt: window.startedAt };
}
