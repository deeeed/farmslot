import {
  isRecord,
  type NativeSessionEvent,
  type NativeSessionTool,
  type ProcessEventRef,
  type ProcessMarkCall,
} from '@farmslot/protocol';

import { claudeToolKind, isClaudeToolCallBlock } from './claude.js';
import { codexCommandLine } from './codex.js';
import { piTool } from './pi.js';
import type { ProcessToolObservation } from './process-tools.js';

export type ProcessHistoryFormat = 'claude-jsonl' | 'pi-jsonl' | 'codex-jsonl';

export interface ProcessHistoryProjection {
  events: ProcessToolObservation[];
  malformed: number;
}

export interface ProcessPromptBoundary {
  at: number;
  line: number;
}

/** An explicit first structured task request can bind a fresh legacy conversation. */
export function processTaskPromptBoundary(
  format: ProcessHistoryFormat,
  lines: readonly string[],
  repo: string,
  taskDir: string,
): ProcessPromptBoundary | undefined {
  const relative = taskDir.startsWith(`${repo}/`) ? taskDir.slice(repo.length + 1) : undefined;
  const targets = [taskDir, relative]
    .filter((value): value is string => Boolean(value))
    .flatMap((directory) => [`${directory}/TASK.md`, `${directory}/CHECKLIST.md`]);
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].trim()) continue;
    const row: unknown = JSON.parse(lines[index]);
    if (!isRecord(row)) continue;
    const payload = format === 'codex-jsonl' && isRecord(row.payload) ? row.payload : row;
    const message = isRecord(payload.message) ? payload.message : payload;
    const isUser =
      format === 'pi-jsonl'
        ? message.role === 'user'
        : format === 'claude-jsonl'
          ? row.type === 'user' && row.isMeta !== true
          : payload.type === 'message' && message.role === 'user';
    if (!isUser) continue;
    const content =
      typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .flatMap((block: unknown) =>
                isRecord(block) && typeof block.text === 'string' ? [block.text] : [],
              )
              .join('\n')
          : '';
    const at = Date.parse(timestamp(row.timestamp ?? message.timestamp));
    // A prior unrelated user request makes this a reused conversation, not a fresh boundary.
    return Number.isFinite(at) && targets.some((target) => content.includes(target))
      ? { at, line: index + 1 }
      : undefined;
  }
  return undefined;
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;
const timestamp = (value: unknown): string =>
  typeof value === 'number' && Number.isFinite(value)
    ? new Date(value).toISOString()
    : (text(value) ?? '');

function resultStatus(failed: unknown): ProcessMarkCall['status'] {
  return failed === true ? 'failed' : failed === false ? 'succeeded' : 'unknown';
}

/** Preserve native protocol correlation and locators without deriving state from rendered text. */
export function nativeProcessEvents(
  events: NativeSessionEvent[],
  sourceId: string,
): ProcessToolObservation[] {
  return events.flatMap((event) => {
    if ((event.type !== 'tool.started' && event.type !== 'tool.completed') || !event.nativeId)
      return [];
    const status = event.tool?.status;
    return [
      {
        id: event.nativeId,
        at: event.at,
        phase: event.type === 'tool.started' ? ('request' as const) : ('result' as const),
        tool: event.tool,
        status:
          status === 'completed' || status === 'success'
            ? ('succeeded' as const)
            : status === 'failed' || status === 'error'
              ? ('failed' as const)
              : ('unknown' as const),
        ref: { sourceId, sequence: event.sequence, toolId: event.nativeId },
      },
    ];
  });
}

function codexLegacyTool(name: string, argumentsValue: unknown): NativeSessionTool {
  const input = typeof argumentsValue === 'string' ? JSON.parse(argumentsValue) : argumentsValue;
  const record = isRecord(input) ? input : {};
  const shell = [
    'exec_command',
    'shell_command',
    'shell',
    'functions.exec_command',
    'functions.shell_command',
    'functions.shell',
  ].includes(name);
  const command = shell ? (text(record.cmd) ?? text(record.command)) : undefined;
  return {
    name,
    input,
    kind: command ? 'command' : 'other',
    ...(command ? { command: codexCommandLine(command) } : {}),
  };
}

/** Existing structured JSONL formats only. Unknown formats or text never become actions. */
export function projectProcessHistory(
  format: ProcessHistoryFormat,
  lines: readonly string[],
  sourceId: string,
  startAt: number,
  endAt: number,
  lineOffset = 0,
): ProcessHistoryProjection {
  const events: ProcessToolObservation[] = [];
  let malformed = 0;
  const requests = new Set<string>();
  const locatedRequests = new Set<string>();
  const unlocatedRequests = new Set<string>();
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      malformed++;
      continue;
    }
    if (!isRecord(row)) {
      malformed++;
      continue;
    }
    const message = isRecord(row.message) ? row.message : row;
    const at = timestamp(row.timestamp ?? message.timestamp);
    const ms = Date.parse(at);
    const inWindow = Number.isFinite(ms) && ms >= startAt && ms <= endAt;
    const reference = (toolId: string): ProcessEventRef => ({
      sourceId,
      line: index + 1 + lineOffset,
      toolId,
    });
    if (format === 'codex-jsonl') {
      const payload = isRecord(row.payload) ? row.payload : row;
      const type = payload.type;
      const id = text(payload.call_id);
      if (!id) continue;
      if (type === 'function_call') {
        if (Number.isFinite(ms)) {
          locatedRequests.add(id);
          unlocatedRequests.delete(id);
        } else if (!locatedRequests.has(id)) unlocatedRequests.add(id);
      }
      if (type === 'function_call' && inWindow && typeof payload.name === 'string') {
        try {
          events.push({
            id,
            at,
            phase: 'request',
            tool: codexLegacyTool(payload.name, payload.arguments),
            ref: reference(id),
          });
          requests.add(id);
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          malformed++;
        }
      } else if (type === 'function_call_output' && requests.has(id)) {
        // Only structured machine exit codes establish success, never stdout prose.
        let output: unknown = payload.output;
        if (typeof output === 'string') {
          try {
            output = JSON.parse(output);
          } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
            output = null;
          }
        }
        const status =
          inWindow && isRecord(output) && typeof output.exit_code === 'number'
            ? resultStatus(output.exit_code !== 0)
            : 'unknown';
        if (!Number.isFinite(ms) || ms <= endAt)
          events.push({ id, at, phase: 'result', status, ref: reference(id) });
      }
      continue;
    }
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content.filter(isRecord)) {
      const isRequest =
        format === 'pi-jsonl' ? block.type === 'toolCall' : isClaudeToolCallBlock(block);
      const id = text(block.id);
      if (isRequest && id) {
        if (Number.isFinite(ms)) {
          locatedRequests.add(id);
          unlocatedRequests.delete(id);
        } else if (!locatedRequests.has(id)) unlocatedRequests.add(id);
      }
      if (isRequest && id && inWindow && typeof block.name === 'string') {
        const input = format === 'pi-jsonl' ? block.arguments : block.input;
        const tool =
          format === 'pi-jsonl'
            ? piTool(block.name, input)
            : { name: block.name, input, ...claudeToolKind(block.name, input) };
        events.push({ id, at, phase: 'request', tool, ref: reference(id) });
        requests.add(id);
      } else if (format === 'claude-jsonl' && block.type === 'tool_result') {
        const request = text(block.tool_use_id);
        if (request && requests.has(request) && (!Number.isFinite(ms) || ms <= endAt))
          events.push({
            id: request,
            at,
            phase: 'result',
            status: inWindow ? resultStatus(block.is_error === true) : 'unknown',
            ref: reference(request),
          });
      }
    }
    if (format === 'pi-jsonl' && message.role === 'toolResult') {
      const id = text(message.toolCallId);
      if (id && requests.has(id) && (!Number.isFinite(ms) || ms <= endAt))
        events.push({
          id,
          at,
          phase: 'result',
          status: inWindow ? resultStatus(message.isError) : 'unknown',
          ref: reference(id),
        });
    }
  }
  return { events, malformed: malformed + unlocatedRequests.size };
}
