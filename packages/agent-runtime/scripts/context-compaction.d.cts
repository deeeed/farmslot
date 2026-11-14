import type { NativeContextCompactionEvidence } from '@farmslot/protocol';

export function claudeCompactionBoundary(
  message: unknown,
  nativeSessionId: string,
): NativeContextCompactionEvidence | undefined;
export function claudeCompactionArgs(sessionId: string, model: string): string[];
