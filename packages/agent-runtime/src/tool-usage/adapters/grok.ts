// Grok session directory: events.jsonl records `tool_started` / `tool_completed` per call; token
// usage is per inference in ~/.grok/logs/unified.jsonl, keyed by session id. Context compactions
// are `auto_compact_completed` session updates in the directory's updates.jsonl.
import { access, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { CompactionEvent, ToolCallEvent, ToolUsageAdapter } from '../stream.js';

import { count, isoTime, isRecord, readJsonLines, text, tokensBefore } from './jsonl.js';

async function sessionDirectory(sessionPath: string): Promise<string> {
  return (await stat(sessionPath)).isDirectory() ? sessionPath : path.dirname(sessionPath);
}

export const grokToolUsage: ToolUsageAdapter = {
  runner: 'grok',
  async read(sessionPath, options) {
    const directory = await sessionDirectory(sessionPath);
    const tools: ToolCallEvent[] = [];
    // tool_started carries no call id; calls of one tool complete in the order they started.
    const open = new Map<string, ToolCallEvent[]>();
    for (const record of await readJsonLines(path.join(directory, 'events.jsonl'))) {
      const at = text(record.ts);
      const name = text(record.tool_name) ?? 'unknown';
      if (!at) continue;
      if (record.type === 'tool_started') {
        const call: ToolCallEvent = { name, issuedAt: at };
        tools.push(call);
        open.set(name, [...(open.get(name) ?? []), call]);
      } else if (record.type === 'tool_completed') {
        const call = open.get(name)?.shift();
        if (call) {
          call.completedAt = at;
          call.id = text(record.tool_call_id);
        }
      }
    }
    const sessionId = path.basename(directory);
    const home = options?.home ?? os.homedir();
    const tokens = [];
    for (const record of await readJsonLines(path.join(home, '.grok', 'logs', 'unified.jsonl'))) {
      if (record.sid !== sessionId || record.msg !== 'shell.turn.inference_done') continue;
      const at = text(record.ts);
      const context = record.ctx;
      if (!at || typeof context !== 'object' || context === null) continue;
      // Cached and reasoning tokens are details inside prompt and completion, as in the totals.
      tokens.push({
        at,
        tokens:
          count(Reflect.get(context, 'prompt_tokens')) +
          count(Reflect.get(context, 'completion_tokens')),
      });
    }
    const updates = path.join(directory, 'updates.jsonl');
    try {
      await access(updates);
    } catch (error) {
      // Older sessions keep no update log: their compactions are unknown, not zero.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return {
        tools,
        tokens,
        compactions: null,
        compactionsUnavailable: 'The Grok session has no updates.jsonl',
      };
    }
    const compactions: CompactionEvent[] = [];
    for (const record of await readJsonLines(updates)) {
      const params = isRecord(record.params) ? record.params : {};
      const update = isRecord(params.update) ? params.update : {};
      if (update.sessionUpdate !== 'auto_compact_completed') continue;
      const meta = isRecord(record._meta)
        ? record._meta
        : isRecord(params._meta)
          ? params._meta
          : {};
      const at = isoTime(meta.agentTimestampMs) ?? isoTime(record.timestamp);
      if (at) compactions.push({ at, ...tokensBefore(update.tokens_before) });
    }
    return { tools, tokens, compactions };
  },
};
