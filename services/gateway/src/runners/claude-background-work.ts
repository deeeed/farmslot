import { isRecord } from '@farmslot/protocol';

import { execOnSlot } from '../core/exec.js';
import { resolveExactTmuxWindowPane } from '../core/tmux.js';

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
pending = {}
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
            result = record.get('toolUseResult')
            if record.get('type') == 'user' and isinstance(result, dict):
                task = result.get('backgroundTaskId') or (result.get('agentId') if result.get('isAsync') is True else None)
                if isinstance(task, str) and task:
                    content = record.get('message', {}).get('content', [])
                    tools = [block.get('tool_use_id') for block in content if isinstance(block, dict) and block.get('type') == 'tool_result'] if isinstance(content, list) else []
                    if len(tools) != 1 or not isinstance(tools[0], str):
                        unknown()
                    pending[task] = tools[0]
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
                if task in pending and pending[task] == tool and notification.findtext('status') in ('completed', 'failed', 'killed'):
                    del pending[task]
        after = os.fstat(stream.fileno())
except OSError:
    unknown()
if consumed != before.st_size or (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
    unknown()
if not matched_session:
    unknown()
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
  const sessionId = paneState?.rootSessionId ?? paneState?.session_id;
  if (!sessionId) return unknown();
  const session = await source.sessionState(vars, sessionId);
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
