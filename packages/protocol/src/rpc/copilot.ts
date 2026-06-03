import { Methods } from './registry.js';
import type { TmuxWorkerRef } from './tmux.js';

export const CopilotMethods = {
  formatInstruction: Methods.COPILOT_FORMAT_INSTRUCTION,
} as const;

export interface CopilotFormatInstructionParams {
  transcript: string;
  slotId?: string;
  runId?: string;
  terminalTail?: string[];
  targetHint?: string;
  worker?: TmuxWorkerRef;
}

export interface CopilotFormatInstructionResult {
  originalTranscript: string;
  draftText: string;
  targetSuggestion?: {
    slotId?: string;
    runId?: string;
    worker?: TmuxWorkerRef;
  };
  warnings: string[];
}
