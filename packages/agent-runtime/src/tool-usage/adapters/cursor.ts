// Cursor agent transcript: ~/.cursor/projects/<workspace>/agent-transcripts/<id>/<id>.jsonl with
// assistant `tool_use` blocks. Its records carry no times, so calls count in the totals only.
// The farm's Cursor usage path is the headless `--output-format json` stdout, which names the
// session; the transcript is found from that id.
import { access, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ToolCallEvent, ToolUsageAdapter } from '../stream.js';

import { isRecord, readJsonLines, text } from './jsonl.js';

async function transcriptPath(sessionPath: string, home: string): Promise<string> {
  if (sessionPath.endsWith('.jsonl')) return sessionPath;
  const stdout: unknown = JSON.parse(await readFile(sessionPath, 'utf8'));
  const id = isRecord(stdout) ? (text(stdout.session_id) ?? text(stdout.sessionId)) : undefined;
  if (!id) throw new Error('Cursor output names no session id');
  const projects = path.join(home, '.cursor', 'projects');
  for (const project of await readdir(projects)) {
    const candidate = path.join(projects, project, 'agent-transcripts', id, `${id}.jsonl`);
    try {
      await access(candidate);
      return candidate;
    } catch (error) {
      // Each workspace is checked in turn; only the one that ran the session has it.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  throw new Error(`Cursor transcript for session ${id} was not found`);
}

export const cursorToolUsage: ToolUsageAdapter = {
  runner: 'cursor',
  async read(sessionPath, options) {
    const file = await transcriptPath(sessionPath, options?.home ?? os.homedir());
    const tools: ToolCallEvent[] = [];
    for (const record of await readJsonLines(file)) {
      const message = record.message;
      if (record.role !== 'assistant' || !isRecord(message)) continue;
      for (const block of Array.isArray(message.content) ? message.content : [])
        if (isRecord(block) && block.type === 'tool_use')
          tools.push({ name: text(block.name) ?? 'unknown' });
    }
    return { tools, tokens: null };
  },
};
