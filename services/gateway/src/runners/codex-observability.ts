import path from 'node:path';

import { execOnSlot } from '../core/exec.js';
import { shellQuote } from '../core/tmux.js';

import { claudeHookObservability } from './claude-observability.js';
import type { ObservabilityReading, RunnerObservability } from './observability-types.js';

const SESSION_TAIL_BYTES = 2 * 1024 * 1024;

interface JsonRecord {
  [key: string]: unknown;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function userPrompt(record: JsonRecord): string | null {
  if (record.type !== 'response_item' || !isRecord(record.payload)) return null;
  if (record.payload.type !== 'message' || record.payload.role !== 'user') return null;
  if (!Array.isArray(record.payload.content)) return null;
  const parts = record.payload.content
    .filter(isRecord)
    .filter((part) => part.type === 'input_text' && typeof part.text === 'string')
    .map((part) => String(part.text));
  return parts.length > 0 ? parts.join('\n') : null;
}

export function promptAcceptedFromCodexSession(
  raw: string,
  expectedPrompt: string,
  sinceMs: number,
): ObservabilityReading<boolean> | null {
  let latestMatch = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      // A bounded tail can begin inside one JSONL record; later complete records remain valid.
      continue;
    }
    if (!isRecord(record) || userPrompt(record) !== expectedPrompt) continue;
    const observedAt = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
    if (Number.isFinite(observedAt) && observedAt >= sinceMs) latestMatch = observedAt;
  }
  return latestMatch > 0
    ? {
        value: true,
        source: 'signal',
        confidence: 'high',
        observedAt: latestMatch,
        exactPromptMatch: true,
      }
    : null;
}

export const codexSessionObservability: RunnerObservability = {
  ...claudeHookObservability,
  async promptAcceptedInSession(vars, _target, sessionId, sessionPath, promptText, sinceMs) {
    if (!path.basename(sessionPath).endsWith(`${sessionId}.jsonl`)) return null;
    const result = await execOnSlot(
      vars,
      `tail -c ${SESSION_TAIL_BYTES} ${shellQuote(sessionPath)} 2>/dev/null`,
      vars.remoteRepo,
    );
    if (result.exitCode !== 0) return null;
    return promptAcceptedFromCodexSession(result.stdout, promptText, sinceMs);
  },
};
