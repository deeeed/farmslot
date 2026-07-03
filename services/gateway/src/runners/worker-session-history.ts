import { createHash } from 'node:crypto';
import path from 'node:path';

import type { WorkerSessionHistoryMessage, WorkerSessionHistoryTool } from '@farmslot/protocol';

import { normalizeRunner } from './registry.js';

export interface RunnerSessionHistoryProjection {
  messages: WorkerSessionHistoryMessage[];
  skippedMalformedLines: number;
}

export interface RunnerSessionHistoryProvider {
  project(rawLines: readonly string[]): RunnerSessionHistoryProjection;
}

interface JsonRecord {
  [key: string]: unknown;
}

const NOISE_TAGS = [
  '<local-command-caveat>',
  '<command-name>',
  '<command-message>',
  '<system-reminder>',
  '<environment_context>',
  '<file_map>',
];

function isObject(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = stringValue(value).trim();
    if (text) return text;
  }
  return '';
}

function cleanText(value: string): string {
  const text = value.replace(/\r\n/g, '\n').trim();
  if (!text) return '';
  if (NOISE_TAGS.some((tag) => text.startsWith(tag) || text.includes(tag))) return '';
  return text;
}

function stableRecordId(runner: string, record: JsonRecord, suffix = ''): string {
  const raw =
    firstString(record.uuid, record.id, record.item_id, record.request_id, record.timestamp) ||
    createHash('sha1').update(JSON.stringify(record)).digest('hex').slice(0, 16);
  const suffixPart = suffix ? `:${suffix}` : '';
  return `${runner}:${raw}${suffixPart}`;
}

function parseJsonl(rawLines: readonly string[]): {
  records: JsonRecord[];
  skippedMalformedLines: number;
} {
  const records: JsonRecord[] = [];
  let skippedMalformedLines = 0;
  for (const line of rawLines) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isObject(parsed)) records.push(parsed);
    } catch {
      // Runner-owned JSONL files can be tailed while the last line is mid-write.
      // Keep projecting the last complete transcript rather than failing the whole panel.
      skippedMalformedLines += 1;
    }
  }
  return { records, skippedMalformedLines };
}

function toolFromBlock(block: JsonRecord): WorkerSessionHistoryTool | null {
  const name = firstString(block.name, block.function_name, block.tool_name, block.command);
  if (!name) return null;
  const id = firstString(block.id, block.tool_use_id, block.call_id);
  return id ? { id, name } : { name };
}

function textFromContent(content: unknown, textKeys: readonly string[]): string {
  if (typeof content === 'string') return cleanText(content);
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      const text = cleanText(block);
      if (text) parts.push(text);
      continue;
    }
    if (!isObject(block)) continue;
    for (const key of textKeys) {
      const text = cleanText(stringValue(block[key]));
      if (text) {
        parts.push(text);
        break;
      }
    }
  }
  return cleanText(parts.join('\n\n'));
}

function toolsFromContent(content: unknown): WorkerSessionHistoryTool[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((block): block is JsonRecord => isObject(block))
    .filter(
      (block) =>
        stringValue(block.type) === 'tool_use' || stringValue(block.type) === 'function_call',
    )
    .map(toolFromBlock)
    .filter((tool): tool is WorkerSessionHistoryTool => tool !== null);
}

function compactMessages(messages: WorkerSessionHistoryMessage[]): WorkerSessionHistoryMessage[] {
  return messages.filter((message) => message.text || (message.tools?.length ?? 0) > 0);
}

function projectClaude(records: readonly JsonRecord[]): WorkerSessionHistoryMessage[] {
  const messages: WorkerSessionHistoryMessage[] = [];
  records.forEach((record) => {
    if (record.isMeta === true) return;
    const type = stringValue(record.type);
    if (type !== 'user' && type !== 'assistant') return;
    const message = isObject(record.message) ? record.message : record;
    const role = type;
    const content = message.content ?? record.content;
    const text = textFromContent(content, ['text', 'content']);
    const tools = role === 'assistant' ? toolsFromContent(content) : [];
    messages.push({
      id: stableRecordId('claude', record),
      role,
      text,
      tools: tools.length > 0 ? tools : undefined,
      at: firstString(record.timestamp, message.timestamp) || undefined,
    });
  });
  return compactMessages(messages);
}

function codexPayload(record: JsonRecord): JsonRecord {
  return isObject(record.payload) ? record.payload : record;
}

function projectCodex(records: readonly JsonRecord[]): WorkerSessionHistoryMessage[] {
  const messages: WorkerSessionHistoryMessage[] = [];
  records.forEach((record) => {
    const payload = codexPayload(record);
    const type = stringValue(payload.type || record.type);
    if (type === 'message') {
      const role = stringValue(payload.role);
      if (role !== 'user' && role !== 'assistant') return;
      const text = textFromContent(payload.content, ['text', 'content']);
      messages.push({
        id: stableRecordId('codex', record),
        role,
        text,
        at: firstString(payload.timestamp, record.timestamp) || undefined,
      });
      return;
    }
    if (type === 'function_call') {
      const tool = toolFromBlock(payload);
      if (!tool) return;
      messages.push({
        id: stableRecordId('codex', record, 'tool'),
        role: 'assistant',
        text: '',
        tools: [tool],
        at: firstString(payload.timestamp, record.timestamp) || undefined,
      });
    }
  });
  return compactMessages(messages);
}

function projectGrok(records: readonly JsonRecord[]): WorkerSessionHistoryMessage[] {
  const messages: WorkerSessionHistoryMessage[] = [];
  records.forEach((record) => {
    const role = stringValue(record.role || record.type);
    if (role !== 'user' && role !== 'assistant') return;
    const text = textFromContent(record.content ?? record.message ?? record.text, [
      'text',
      'content',
    ]);
    const tools = role === 'assistant' ? toolsFromContent(record.content) : [];
    messages.push({
      id: stableRecordId('grok', record),
      role,
      text,
      tools: tools.length > 0 ? tools : undefined,
      at: firstString(record.timestamp, record.created_at) || undefined,
    });
  });
  return compactMessages(messages);
}

const PROVIDERS: Record<string, (records: readonly JsonRecord[]) => WorkerSessionHistoryMessage[]> =
  {
    claude: projectClaude,
    codex: projectCodex,
    grok: projectGrok,
  };

export function getRunnerSessionHistoryProvider(
  runnerId?: string | null,
): RunnerSessionHistoryProvider | null {
  const runner = normalizeRunner(runnerId);
  const project = PROVIDERS[runner];
  if (!project) return null;
  return {
    project(rawLines) {
      const { records, skippedMalformedLines } = parseJsonl(rawLines);
      return { messages: project(records), skippedMalformedLines };
    },
  };
}

export function runnerHistorySessionFilePath(
  sessionPath: string,
  runnerId?: string | null,
): string {
  if (normalizeRunner(runnerId) === 'grok' && path.extname(sessionPath) !== '.jsonl') {
    return path.join(sessionPath, 'chat_history.jsonl');
  }
  return sessionPath;
}
