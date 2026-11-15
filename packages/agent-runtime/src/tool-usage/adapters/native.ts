// Native session journal: `tool.started` / `tool.completed` events are already the stream's
// shape, paired by nativeId. The journal has no token usage; that comes from the runner transcript.
import type { ToolCallEvent, ToolUsageAdapter } from '../stream.js';

import { isRecord, readJsonLines, text } from './jsonl.js';

export const nativeToolUsage: ToolUsageAdapter = {
  runner: 'native',
  async read(sessionPath) {
    const tools: ToolCallEvent[] = [];
    const byId = new Map<string, ToolCallEvent>();
    for (const record of await readJsonLines(sessionPath)) {
      const event = record.event;
      if (!isRecord(event)) continue;
      const at = text(event.at);
      const id = text(event.nativeId);
      if (event.type === 'tool.started') {
        if (id && byId.has(id)) continue;
        const tool = isRecord(event.tool) ? event.tool : {};
        const call: ToolCallEvent = { id, name: text(tool.name) ?? 'unknown', issuedAt: at };
        tools.push(call);
        if (id) byId.set(id, call);
      } else if (event.type === 'tool.completed' && id && at) {
        const call = byId.get(id);
        if (call) call.completedAt ??= at;
      }
    }
    return { tools, tokens: null };
  },
};
