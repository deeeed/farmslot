import { isRecord } from '@farmslot/protocol';

import { execOnSlot } from '../core/exec.js';
import { resolveExactTmuxWindowPane } from '../core/tmux.js';

import { readClaudeProcessState } from './claude-process-observability.js';
import {
  readRunnerPaneObservabilityState,
  readRunnerSessionObservabilityState,
} from './observability-files.js';
import type {
  ObservabilityReading,
  RunnerBackgroundWorkState,
  SlotVars,
} from './observability-types.js';
import { probeRunnerDescendantPid } from './session-process.js';

/** Stream native task identities with bounded records, never tool stdout or prose. */
export function buildClaudeBackgroundProbeCommand(
  sessionId: string,
  transcript: string,
  maxRecordBytes = 32 * 1024 * 1024,
): string {
  return `python3 - <<'PY'
import json, os
import xml.etree.ElementTree as ET

session = ${JSON.stringify(sessionId)}
transcript = ${JSON.stringify(transcript)}
def unknown():
    print(json.dumps({'state': 'unknown'}))
    raise SystemExit(0)
if os.path.basename(transcript) != session + '.jsonl':
    unknown()
launched = set()
finished = set()
stop_calls = set()
stop_results = set()
matched_session = False
try:
    with open(transcript, 'rb') as stream:
        before = os.fstat(stream.fileno())
        consumed = 0
        while True:
            line = stream.readline(${maxRecordBytes} + 1)
            if not line:
                break
            consumed += len(line)
            if len(line) > ${maxRecordBytes} or not line.endswith(b'\\n'):
                unknown()
            try:
                record = json.loads(line)
            except (ValueError, UnicodeError):
                unknown()
            if not isinstance(record, dict) or record.get('sessionId') != session:
                continue
            matched_session = True
            message = record.get('message')
            content = message.get('content', []) if isinstance(message, dict) else []
            blocks = content if isinstance(content, list) else []
            if record.get('type') == 'assistant':
                for block in blocks:
                    if not isinstance(block, dict) or block.get('type') != 'tool_use' or block.get('name') != 'TaskStop':
                        continue
                    tool = block.get('id')
                    inputs = block.get('input')
                    task = inputs.get('task_id') if isinstance(inputs, dict) else None
                    if isinstance(tool, str) and tool and isinstance(task, str) and task:
                        stop_calls.add((tool, task))
            result = record.get('toolUseResult')
            if record.get('type') == 'user' and isinstance(result, dict):
                tools = [block for block in blocks if isinstance(block, dict) and block.get('type') == 'tool_result']
                task = result.get('backgroundTaskId') or (result.get('agentId') if result.get('isAsync') is True else None)
                if isinstance(task, str) and task:
                    if len(tools) != 1 or not isinstance(tools[0].get('tool_use_id'), str) or not tools[0]['tool_use_id']:
                        unknown()
                    launched.add((task, tools[0]['tool_use_id']))
                task = result.get('task_id')
                task_type = result.get('task_type')
                if isinstance(task, str) and task and isinstance(task_type, str) and task_type and len(tools) == 1:
                    tool = tools[0].get('tool_use_id')
                    # Native successful TaskStop results omit is_error or set it to false.
                    if isinstance(tool, str) and tool and ('is_error' not in tools[0] or tools[0]['is_error'] is False):
                        stop_results.add((tool, task))
            if record.get('type') == 'queue-operation' and record.get('operation') == 'enqueue':
                content = record.get('content')
                if not isinstance(content, str):
                    continue
                try:
                    notification = ET.fromstring(content)
                except ET.ParseError:
                    continue  # Ordinary queued prompts are not task notifications.
                if notification.tag != 'task-notification':
                    continue
                task = notification.findtext('task-id')
                tool = notification.findtext('tool-use-id')
                if task and tool and notification.findtext('status') in ('completed', 'failed', 'killed'):
                    finished.add((task, tool))
        after = os.fstat(stream.fileno())
except OSError:
    unknown()
if consumed != before.st_size or (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
    unknown()
if not matched_session:
    unknown()
stopped = {task for tool, task in stop_calls & stop_results}
pending = any(task not in stopped and (task, tool) not in finished for task, tool in launched)
print(json.dumps({'state': 'active' if pending else 'idle', 'observedAt': before.st_mtime_ns / 1000000}))
PY`;
}

interface BackgroundReaders {
  pane: typeof resolveExactTmuxWindowPane;
  paneState: typeof readRunnerPaneObservabilityState;
  sessionState: typeof readRunnerSessionObservabilityState;
  process: typeof probeRunnerDescendantPid;
  exec: typeof execOnSlot;
}

export async function readClaudeBackgroundWorkState(
  vars: SlotVars,
  target: string,
  overrides: Partial<BackgroundReaders> = {},
): Promise<ObservabilityReading<RunnerBackgroundWorkState>> {
  const source = {
    pane: resolveExactTmuxWindowPane,
    paneState: readRunnerPaneObservabilityState,
    sessionState: readRunnerSessionObservabilityState,
    process: probeRunnerDescendantPid,
    exec: execOnSlot,
    ...overrides,
  };
  const unknown = (): ObservabilityReading<RunnerBackgroundWorkState> => ({
    value: 'unknown',
    source: 'unknown',
    confidence: 'low',
    observedAt: Date.now(),
  });
  const pane = await source.pane(vars, target);
  if (!pane) return unknown();
  const paneState = await source.paneState(vars, pane.paneId);
  const native = !paneState ? await readClaudeProcessState(vars, target) : null;
  const sessionId = paneState?.rootSessionId ?? paneState?.session_id ?? native?.sessionId;
  if (!sessionId) return unknown();
  const session = native
    ? { session_id: native.sessionId, tmuxPane: pane.paneId, transcript_path: native.sessionPath }
    : await source.sessionState(vars, sessionId);
  if (
    session?.session_id !== sessionId ||
    session.tmuxPane !== pane.paneId ||
    !session.transcript_path
  )
    return unknown();
  const result = await source.exec(
    vars,
    buildClaudeBackgroundProbeCommand(sessionId, session.transcript_path),
    { timeout: 10000, maxBuffer: 4096 },
  );
  if (result.exitCode !== 0) return unknown();
  if (native) {
    const current = await readClaudeProcessState(vars, target);
    if (current?.sessionId !== native.sessionId || current.processPid !== native.processPid)
      return unknown();
  }
  const value: unknown = JSON.parse(result.stdout);
  if (
    !isRecord(value) ||
    (value.state !== 'active' && value.state !== 'idle') ||
    typeof value.observedAt !== 'number'
  )
    return unknown();
  if (
    value.state === 'active' &&
    (await source.process(vars, pane.panePid, 'claude')).state !== 'present'
  )
    return unknown();
  return {
    value: value.state === 'active' ? 'active' : 'idle',
    source: 'hook',
    confidence: 'high',
    observedAt: value.observedAt,
  };
}
