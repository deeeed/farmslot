import { createHash } from 'node:crypto';

import type { ChatMessage } from '@farmslot/protocol';

import { redactCopilotValue } from './session-store.js';

const ANSI_ESCAPE = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const MEANINGFUL_TEXT = /[\p{L}\p{N}]/u;

export function normalizeTmuxTranscript(raw: string): string {
  const lines = raw
    .replace(ANSI_ESCAPE, '')
    .replace(CONTROL_CHARACTERS, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => !line || MEANINGFUL_TEXT.test(line));
  const compact: string[] = [];
  for (const line of lines) {
    if (line === compact.at(-1)) continue;
    if (!line && !compact.at(-1)) continue;
    compact.push(line);
  }
  return compact.join('\n').trim().slice(-40_000);
}

export function tmuxTranscriptMessage(input: {
  runtimeId: string;
  offsetStart: number;
  offsetEnd: number;
  content: string;
  timestamp?: string;
}): ChatMessage | null {
  const normalized = normalizeTmuxTranscript(input.content);
  if (!normalized) return null;
  const id = createHash('sha256')
    .update(`${input.runtimeId}:${input.offsetStart}:${input.offsetEnd}`)
    .digest('hex');
  return {
    id: `tmux-${id.slice(0, 24)}`,
    role: 'assistant',
    content: String(redactCopilotValue(normalized)),
    timestamp: input.timestamp ?? new Date().toISOString(),
    source: 'tmux',
  };
}
