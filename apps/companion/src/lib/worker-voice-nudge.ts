import type { CopilotFormatInstructionParams, TmuxWorkerRef } from '@farmslot/protocol';

export interface WorkerVoiceFormatRequestInput {
  transcript: string;
  worker: TmuxWorkerRef;
  terminalTail?: string[];
}

export function buildWorkerVoiceFormatRequest({
  transcript,
  worker,
  terminalTail = [],
}: WorkerVoiceFormatRequestInput): CopilotFormatInstructionParams {
  return {
    transcript: transcript.trim(),
    worker,
    terminalTail: terminalTail.slice(-20),
  };
}

export function workerVoiceInstructionInput(text: string): string {
  const trimmed = text.trim();
  return trimmed ? `${trimmed}\r` : '';
}
