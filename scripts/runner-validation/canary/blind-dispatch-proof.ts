import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import type {
  WorkerSessionHistorySource,
  WorkerSessionHistoryTool,
} from '../../../packages/protocol/src/index.js';

export interface BlindToolMessage {
  role?: string;
  tools?: WorkerSessionHistoryTool[];
}

/** Provider events recorded by the existing fullflow Pi extension. */
export interface CanaryTurnReceipt extends BlindToolMessage {
  at: string;
  cwd: string;
  usage?: { totalTokens?: number };
  stopReason?: string;
}

interface BlindToolObservation {
  source: WorkerSessionHistorySource | 'structured-hook';
  messages: readonly BlindToolMessage[];
}

/** Pane output and unavailable history cannot prove a model tool call. */
export function firstBlindTool(history: BlindToolObservation): BlindToolMessage | undefined {
  return ['transcript', 'structured-hook'].includes(history.source)
    ? history.messages.find(
        (message) =>
          message.role === 'assistant' && message.tools?.some((tool) => tool.name.trim()),
      )
    : undefined;
}

/** Read complete appended records only; normal fullflow and the smoke share this reader. */
export async function readCanaryTurns(
  file: string,
  cwd: string,
  since = 0,
): Promise<CanaryTurnReceipt[]> {
  if (!existsSync(file)) return [];
  const text = await readFile(file, 'utf8');
  const receipts: CanaryTurnReceipt[] = text
    .slice(0, text.lastIndexOf('\n') + 1)
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return receipts.filter(
    (receipt) => receipt.cwd === cwd && (!since || Date.parse(receipt.at) >= since),
  );
}
