import path from 'node:path';

import { execOnSlot } from '../core/exec.js';

import { readSlotClockMs } from './observability-clock.js';
import type { RunnerActivity, RunnerObservability, SlotVars } from './observability-types.js';

type GrokPromptSignalProbe =
  | {
      status: 'matched';
      promptAcceptedAt: number | null;
      activity: Extract<RunnerActivity, 'idle' | 'composing' | 'tool-running' | 'unknown'>;
      activityAt: number;
      turnStartedAt?: number | null;
      sessionId?: string;
      sessionPath?: string;
    }
  | { status: 'unavailable' | 'ambiguous' };

type ProbeGrokPromptSignal = (
  vars: SlotVars,
  target: string,
  sinceMs: number | null,
  promptText: string | null,
) => Promise<GrokPromptSignalProbe>;

export function parseGrokPromptSignalProbe(raw: string): GrokPromptSignalProbe {
  const value = JSON.parse(raw) as Record<string, unknown>;
  if (value.status === 'unavailable' || value.status === 'ambiguous') {
    return { status: value.status };
  }
  if (
    value.status !== 'matched' ||
    (value.promptAcceptedAt !== null && typeof value.promptAcceptedAt !== 'number') ||
    (value.activity !== 'idle' &&
      value.activity !== 'composing' &&
      value.activity !== 'tool-running' &&
      value.activity !== 'unknown') ||
    typeof value.activityAt !== 'number' ||
    (value.turnStartedAt !== undefined &&
      value.turnStartedAt !== null &&
      typeof value.turnStartedAt !== 'number')
  ) {
    throw new Error(`Invalid Grok prompt signal probe: ${raw}`);
  }
  return {
    status: 'matched',
    promptAcceptedAt: value.promptAcceptedAt,
    activity: value.activity,
    activityAt: value.activityAt,
    ...(value.turnStartedAt === undefined ? {} : { turnStartedAt: value.turnStartedAt }),
    ...(typeof value.sessionId === 'string' ? { sessionId: value.sessionId } : {}),
    ...(typeof value.sessionPath === 'string' ? { sessionPath: value.sessionPath } : {}),
  };
}

async function probeGrokPromptSignal(
  vars: SlotVars,
  target: string,
  sinceMs: number | null,
  promptText: string | null,
): Promise<GrokPromptSignalProbe> {
  const result = await execOnSlot(
    vars,
    buildGrokPromptSignalProbeCommand(vars, target, sinceMs, promptText),
    { timeout: 10_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Grok prompt signal probe failed: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`,
    );
  }
  return parseGrokPromptSignalProbe(result.stdout.trim());
}

export function buildGrokPromptSignalProbeCommand(
  vars: SlotVars,
  target: string,
  sinceMs: number | null,
  promptText: string | null,
): string {
  return `
python3 - <<'PY'
import json
import os
import subprocess
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

target = ${JSON.stringify(target)}
repo = ${JSON.stringify(vars.remoteRepo)}
since_ms = ${sinceMs === null ? 'None' : Math.floor(sinceMs)}
expected_prompt = ${promptText === null ? 'None' : JSON.stringify(promptText)}
home = Path.home()
active_path = home / '.grok' / 'active_sessions.json'
session_roots = list(dict.fromkeys([
    home / '.grok' / 'sessions' / quote(repo, safe=''),
    home / '.grok' / 'sessions' / quote(os.path.realpath(repo), safe=''),
]))

if not active_path.is_file():
    print(json.dumps({'status': 'unavailable'}))
    raise SystemExit(0)

pane_pid = int(subprocess.check_output(
    ['tmux', 'display-message', '-p', '-t', target, '#{pane_pid}'],
    text=True,
).strip())
parents = {}
for row in subprocess.check_output(['ps', '-axo', 'pid=,ppid='], text=True).splitlines():
    pid_text, parent_text = row.split()
    parents[int(pid_text)] = int(parent_text)

def belongs_to_pane(pid):
    seen = set()
    while pid > 0 and pid not in seen:
        if pid == pane_pid:
            return True
        seen.add(pid)
        pid = parents.get(pid, 0)
    return False

repo_key = os.path.realpath(repo)
matching = [
    item for item in json.loads(active_path.read_text())
    if isinstance(item.get('cwd'), str)
    and item['cwd']
    and os.path.realpath(item['cwd']) == repo_key
    and isinstance(item.get('pid'), int)
    and belongs_to_pane(item['pid'])
]
if not matching:
    print(json.dumps({'status': 'unavailable'}))
    raise SystemExit(0)
def parse_aware_timestamp_ms(value):
    if not isinstance(value, str) or not value:
        return None
    normalized = value[:-1] + '+00:00' if value.endswith('Z') else value
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        return None
    return int(parsed.timestamp() * 1000)

candidates = []
for item in matching:
    session_id = item.get('session_id')
    timestamp = item.get('opened_at')
    opened_at_ms = parse_aware_timestamp_ms(timestamp)
    if not isinstance(session_id, str) or not session_id or opened_at_ms is None:
        continue
    candidates.append({
        'session_id': session_id,
        'pid': item['pid'],
        'opened_at_ms': opened_at_ms,
    })
if len(candidates) != 1:
    print(json.dumps({'status': 'ambiguous' if candidates else 'unavailable'}))
    raise SystemExit(0)

candidate = candidates[0]
session_dirs = []
seen_session_dirs = set()
for root in session_roots:
    raw_path = root / candidate['session_id']
    if not raw_path.is_dir():
        continue
    canonical_path = Path(os.path.realpath(raw_path))
    canonical_key = str(canonical_path)
    if canonical_key in seen_session_dirs:
        continue
    seen_session_dirs.add(canonical_key)
    session_dirs.append(canonical_path)
if len(session_dirs) != 1:
    print(json.dumps({'status': 'ambiguous' if session_dirs else 'unavailable'}))
    raise SystemExit(0)

session_dir = session_dirs[0]
events_path = session_dir / 'events.jsonl'
chat_path = session_dir / 'chat_history.jsonl'
if not events_path.is_file() or not chat_path.is_file():
    print(json.dumps({'status': 'unavailable'}))
    raise SystemExit(0)

accepted_at = None
max_scan_bytes = 1024 * 1024

def read_jsonl_tail(path):
    with path.open('rb') as handle:
        size = handle.seek(0, 2)
        start = max(0, size - max_scan_bytes)
        handle.seek(start)
        if start:
            handle.readline()
        lines = handle.readlines()
    records = []
    for index, raw_line in enumerate(lines):
        try:
            records.append(json.loads(raw_line.decode('utf-8', errors='replace')))
        except json.JSONDecodeError:
            if index == len(lines) - 1 and not raw_line.endswith(b'\\n'):
                continue
            raise
    return records

latest_start = None
latest_end = None
latest_tool_start = None
latest_tool_end = None
for event in read_jsonl_tail(events_path):
    event_ms = parse_aware_timestamp_ms(event.get('ts'))
    if event_ms is None or event_ms < candidate['opened_at_ms']:
        continue
    event_type = event.get('type')
    if event_type == 'turn_started' and isinstance(event.get('turn_number'), int):
        if latest_start is None or event_ms > latest_start['at']:
            latest_start = {'at': event_ms, 'turn_number': event['turn_number']}
    elif event_type == 'turn_ended':
        latest_end = max(event_ms, latest_end or 0)
    elif event_type == 'tool_started':
        latest_tool_start = max(event_ms, latest_tool_start or 0)
    elif event_type == 'tool_completed':
        latest_tool_end = max(event_ms, latest_tool_end or 0)

latest_user = None
for message in read_jsonl_tail(chat_path):
    prompt_index = message.get('prompt_index')
    content = message.get('content')
    if message.get('type') != 'user' or not isinstance(prompt_index, int) or not isinstance(content, list):
        continue
    texts = [item.get('text') for item in content if isinstance(item, dict) and item.get('type') == 'text']
    if not texts or not all(isinstance(text, str) for text in texts):
        continue
    text = ''.join(texts)
    user_query_prefix = '<user_query>\\n'
    user_query_suffix = '\\n</user_query>'
    if text.startswith(user_query_prefix) and text.endswith(user_query_suffix):
        text = text[len(user_query_prefix):-len(user_query_suffix)]
    if latest_user is None or prompt_index > latest_user['prompt_index']:
        latest_user = {'prompt_index': prompt_index, 'text': text}

if latest_start is None:
    activity = 'unknown'
    activity_at = candidate['opened_at_ms']
elif latest_end is not None and latest_end >= latest_start['at']:
    activity = 'idle'
    activity_at = latest_end
elif (
    latest_tool_start is not None
    and latest_tool_start >= latest_start['at']
    and (latest_tool_end is None or latest_tool_start > latest_tool_end)
):
    activity = 'tool-running'
    activity_at = latest_tool_start
else:
    activity = 'composing'
    activity_at = latest_start['at']

if (
    latest_start is not None
    and latest_user is not None
    and latest_start['turn_number'] == latest_user['prompt_index']
    and expected_prompt is not None
    and since_ms is not None
    and latest_start['at'] >= max(candidate['opened_at_ms'], since_ms)
    and latest_user['text'] == expected_prompt
):
    accepted_at = latest_start['at']

print(json.dumps({
    'status': 'matched',
    'promptAcceptedAt': accepted_at,
    'activity': activity,
    'activityAt': activity_at,
    'turnStartedAt': latest_start['at'] if latest_start is not None else None,
    'sessionId': candidate['session_id'],
    'sessionPath': str(session_dir),
}))
PY`;
}

export function createGrokLogObservability(
  probe: ProbeGrokPromptSignal = probeGrokPromptSignal,
  readClock: (vars: SlotVars) => Promise<number> = readSlotClockMs,
): RunnerObservability {
  return {
    promptAcceptanceMode: 'native-text',
    async resolveSessionId(_vars, sessionPath) {
      return path.basename(sessionPath) || null;
    },
    async getActivity(vars, target) {
      const signal = await probe(vars, target, null, null);
      if (signal.status !== 'matched') return null;
      return {
        value: signal.activity,
        source: 'signal',
        confidence: 'high',
        observedAt: signal.activityAt,
        ...(signal.sessionId ? { sessionId: signal.sessionId } : {}),
        ...(signal.sessionId && typeof signal.turnStartedAt === 'number'
          ? { turnToken: `${signal.sessionId}:${signal.turnStartedAt}` }
          : {}),
      };
    },
    async getTurnState(vars, target) {
      const signal = await probe(vars, target, null, null);
      if (signal.status !== 'matched') return null;
      return {
        value:
          signal.activity === 'idle'
            ? 'idle'
            : signal.activity === 'unknown'
              ? 'unknown'
              : 'active',
        source: 'signal',
        confidence: 'high',
        observedAt: signal.activityAt,
        ...(signal.sessionId ? { sessionId: signal.sessionId } : {}),
        ...(signal.sessionId && typeof signal.turnStartedAt === 'number'
          ? { turnToken: `${signal.sessionId}:${signal.turnStartedAt}` }
          : {}),
      };
    },
    async getContextPct() {
      return null;
    },
    async activeTool() {
      return null;
    },
    async lastTurnCompletedAt() {
      return null;
    },
    async capturePromptAcceptanceBaseline(vars) {
      return readClock(vars);
    },
    async promptAccepted(vars, target, _promptDigest, sinceMs, _paneRetired, promptText) {
      if (promptText == null) return null;
      const signal = await probe(vars, target, sinceMs, promptText);
      if (signal.status !== 'matched') return null;
      return signal.promptAcceptedAt === null
        ? {
            value: false,
            source: 'signal',
            confidence: 'medium',
            observedAt: Date.now(),
            exactPromptMatch: false,
          }
        : {
            value: true,
            source: 'signal',
            confidence: 'high',
            observedAt: signal.promptAcceptedAt,
            exactPromptMatch: true,
            ...(signal.sessionId
              ? {
                  sessionId: signal.sessionId,
                  turnToken: `${signal.sessionId}:${signal.promptAcceptedAt}`,
                }
              : {}),
          };
    },
    async getSessionDeliveryState(vars, target, sessionId, _sessionPath) {
      const signal = await probe(vars, target, null, null);
      if (signal.status !== 'matched' || signal.sessionId !== sessionId) {
        return null;
      }
      return {
        value:
          signal.activity === 'idle'
            ? 'idle'
            : signal.activity === 'unknown'
              ? 'unknown'
              : 'active',
        source: 'signal',
        confidence: 'high',
        observedAt: signal.activityAt,
        ...(typeof signal.turnStartedAt === 'number'
          ? { turnToken: `${sessionId}:${signal.turnStartedAt}` }
          : {}),
      };
    },
  };
}

export const grokLogObservability = createGrokLogObservability();
