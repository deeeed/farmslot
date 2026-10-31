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

/**
 * Stream native task identities with bounded records, never tool stdout or prose.
 *
 * The transcript is append-only, so each read resumes where the last one stopped: a
 * per-transcript cache on the node keeps the byte offset and the task identities found so
 * far, and only appended complete lines are parsed. A shorter file (truncation), another
 * inode (rotation) or changed bytes before the offset (an in-place rewrite) restart from
 * byte zero. A trailing partial line is left for the next read. `bytesRead` reports the
 * bytes parsed by this read.
 */
export function buildClaudeBackgroundProbeCommand(
  sessionId: string,
  transcript: string,
  maxRecordBytes = 32 * 1024 * 1024,
): string {
  return `python3 - <<'PY'
import hashlib, json, os, tempfile
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
cache_dir = os.path.join(os.path.expanduser('~'), '.cache', 'farmslot', 'claude-background')
cache_path = os.path.join(cache_dir, hashlib.sha256(transcript.encode()).hexdigest() + '.json')
TAIL = 4096
def tail_digest(stream, offset):
    start = max(0, offset - TAIL)
    stream.seek(start)
    return hashlib.sha256(stream.read(offset - start)).hexdigest()
def load_cache(stream, st):
    try:
        with open(cache_path) as cached:
            cache = json.load(cached)
    except (OSError, ValueError):
        return None
    if not isinstance(cache, dict) or cache.get('v') != 1 or cache.get('session') != session:
        return None
    if cache.get('dev') != st.st_dev or cache.get('ino') != st.st_ino:
        return None  # rotated: another file at this path
    offset = cache.get('offset')
    if not isinstance(offset, int) or offset < 0 or offset > st.st_size:
        return None  # truncated
    if tail_digest(stream, offset) != cache.get('tail'):
        return None  # rewritten in place
    return cache
def save_cache(stream, st, offset):
    data = {
        'v': 1, 'session': session, 'dev': st.st_dev, 'ino': st.st_ino, 'offset': offset,
        'tail': tail_digest(stream, offset), 'matched': matched_session,
        'launched': sorted(launched), 'finished': sorted(finished),
        'stop_calls': sorted(stop_calls), 'stop_results': sorted(stop_results),
    }
    try:
        os.makedirs(cache_dir, mode=0o700, exist_ok=True)
        handle, temporary = tempfile.mkstemp(dir=cache_dir, prefix='.tmp-')
        with os.fdopen(handle, 'w') as out:
            json.dump(data, out)
        os.replace(temporary, cache_path)
    except OSError:
        pass  # without a cache the next read scans from byte zero, as before
try:
    with open(transcript, 'rb') as stream:
        before = os.fstat(stream.fileno())
        cache = load_cache(stream, before)
        offset = 0
        if cache:
            offset = cache['offset']
            matched_session = cache.get('matched') is True
            launched = {tuple(entry) for entry in cache.get('launched', [])}
            finished = {tuple(entry) for entry in cache.get('finished', [])}
            stop_calls = {tuple(entry) for entry in cache.get('stop_calls', [])}
            stop_results = {tuple(entry) for entry in cache.get('stop_results', [])}
        stream.seek(offset)
        consumed = 0
        partial = False
        while True:
            line = stream.readline(${maxRecordBytes} + 1)
            if not line:
                break
            if len(line) > ${maxRecordBytes}:
                unknown()
            if not line.endswith(b'\\n'):
                partial = True  # still being written; the next read resumes before it
                break
            consumed += len(line)
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
        save_cache(stream, before, offset + consumed)
except OSError:
    unknown()
if partial or offset + consumed != before.st_size or (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
    unknown()
if not matched_session:
    unknown()
stopped = {task for tool, task in stop_calls & stop_results}
pending = any(task not in stopped and (task, tool) not in finished for task, tool in launched)
print(json.dumps({'state': 'active' if pending else 'idle', 'observedAt': before.st_mtime_ns / 1000000, 'bytesRead': consumed}))
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
