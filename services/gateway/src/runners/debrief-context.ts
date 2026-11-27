import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

import { type AgentContext, isRecord, type ManagedTaskDebrief, type Run } from '@farmslot/protocol';

import { confinedArchiveTranscript, SESSION_ARCHIVE_MAX_BYTES } from './session-archive.js';
import {
  getRunnerSessionHistoryProvider,
  runnerHistorySessionFilePath,
} from './worker-session-history.js';

export interface DebriefModelRoute {
  provider: string;
  model: string;
}

interface DebriefConversation {
  sha256: string;
  lines: string[];
  route?: DebriefModelRoute;
}

function record(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : undefined;
  } catch (error) {
    // An archived JSONL tail may end in a partial runner event.
    if (!(error instanceof SyntaxError)) throw error;
    return undefined;
  }
}

export function piDebriefRoute(lines: readonly string[]): DebriefModelRoute | undefined {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const row = record(lines[index]!);
    if (row?.type !== 'model_change') continue;
    if (typeof row.provider === 'string' && typeof row.modelId === 'string')
      return { provider: row.provider, model: row.modelId };
    return undefined;
  }
  return undefined;
}

export function codexDebriefRoute(lines: readonly string[]): DebriefModelRoute | undefined {
  const meta = record(lines[0] ?? '');
  if (meta?.type !== 'session_meta' || !isRecord(meta.payload)) return undefined;
  const provider = meta.payload.model_provider;
  // "openai" alone is ambiguous between OpenAI API and ChatGPT authentication.
  if (provider !== 'codex-lb' && provider !== 'openai-codex') return undefined;
  for (let index = lines.length - 1; index > 0; index -= 1) {
    const row = record(lines[index]!);
    if (row?.type === 'turn_context' && isRecord(row.payload))
      return typeof row.payload.model === 'string'
        ? { provider, model: row.payload.model }
        : undefined;
  }
  return undefined;
}

export function projectPiDebriefText(lines: readonly string[]): { role: string; text: string }[] {
  return lines.flatMap((line) => {
    const row = record(line);
    const message = row?.message;
    if (row?.type !== 'message' || !isRecord(message)) return [];
    const role = message.role;
    if (role !== 'user' && role !== 'assistant') return [];
    const text =
      typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .flatMap((block: unknown) =>
                isRecord(block) && block.type === 'text' && typeof block.text === 'string'
                  ? [block.text]
                  : [],
              )
              .join('\n')
          : '';
    return text.trim() ? [{ role, text }] : [];
  });
}

export async function readRetainedDebriefConversation(
  run: Run,
  context: AgentContext,
  journal: ManagedTaskDebrief,
): Promise<DebriefConversation | undefined> {
  const { getRunnerDefinition, isKnownRunner } = await import('./registry.js');
  const archive = context.runnerSessionArchive;
  if (
    context.runId !== run.id ||
    context.signalAttemptId !== journal.attemptId ||
    !journal.sessionId ||
    context.runnerSessionId !== journal.sessionId ||
    !journal.runner ||
    !isKnownRunner(journal.runner) ||
    context.runner !== journal.runner ||
    !archive?.sha256 ||
    archive.status !== 'captured' ||
    archive.runner !== journal.runner ||
    archive.sessionKey !== journal.sessionId ||
    !context.runnerSessionPath ||
    archive.originalPath !== runnerHistorySessionFilePath(context.runnerSessionPath, journal.runner)
  )
    return undefined;
  const file = await confinedArchiveTranscript(run.id, context.id, archive);
  if (!file) throw new Error('Retained runner transcript is missing.');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const bytes = await (async () => {
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > SESSION_ARCHIVE_MAX_BYTES)
        throw new Error('Retained runner transcript exceeds its file limits.');
      const buffer = Buffer.alloc(info.size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const read = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (read.bytesRead === 0) break;
        offset += read.bytesRead;
      }
      if (offset !== info.size)
        throw new Error('Retained runner transcript changed while reading.');
      return buffer.subarray(0, offset);
    } finally {
      await handle.close();
    }
  })();
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== archive.sha256) throw new Error('Retained runner transcript digest changed.');
  const lines = bytes.toString('utf8').split('\n');
  const provider = getRunnerSessionHistoryProvider(journal.runner);
  const definition = getRunnerDefinition(journal.runner);
  const route = definition.debriefModelRoute?.(lines);
  const tail = lines.slice(-64).filter((line) => line.length <= 12_000);
  const messages = definition.debriefText?.(tail) ?? provider?.project(tail).messages ?? [];
  const excerpts = messages
    .filter(({ text }) => text)
    .slice(-8)
    .map(({ role, text }) => JSON.stringify({ role, text: text.slice(-900) }));
  return { sha256, lines: excerpts, ...(route && { route }) };
}
