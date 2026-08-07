import { execOnSlot } from '../core/exec.js';
import { resolveTmuxPaneId } from '../core/tmux.js';

import { claudeHookObservability } from './claude-observability.js';
import { readRunnerPaneObservabilityState } from './observability-files.js';
import type { RunnerObservability, SlotVars } from './observability-types.js';

const SESSION_SCAN_BYTES = 2 * 1024 * 1024;

type CodexPromptProbe =
  | { status: 'matched'; observedAt: number; turnId: string }
  | { status: 'not-found' | 'unavailable' | 'identity-mismatch' };

export function parseCodexPromptProbe(raw: string): CodexPromptProbe {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (
    parsed.status === 'matched' &&
    typeof parsed.observedAt === 'number' &&
    typeof parsed.turnId === 'string'
  ) {
    return { status: 'matched', observedAt: parsed.observedAt, turnId: parsed.turnId };
  }
  if (
    parsed.status === 'not-found' ||
    parsed.status === 'unavailable' ||
    parsed.status === 'identity-mismatch'
  ) {
    return { status: parsed.status };
  }
  throw new Error(`Invalid Codex prompt probe: ${raw}`);
}

export function buildCodexPromptProbeCommand(
  sessionId: string,
  sessionPath: string,
  promptText: string,
  sinceMs: number,
): string {
  return `
python3 - <<'PY'
import json
from datetime import datetime
from pathlib import Path

session_id = ${JSON.stringify(sessionId)}
session_path = Path(${JSON.stringify(sessionPath)})
expected_prompt = ${JSON.stringify(promptText)}
since_ms = ${Math.floor(sinceMs)}
max_scan_bytes = ${SESSION_SCAN_BYTES}

if not session_path.is_file():
    print(json.dumps({'status': 'unavailable'}))
    raise SystemExit(0)

try:
    with session_path.open('rb') as handle:
        first = json.loads(handle.readline().decode('utf-8'))
        if (
            first.get('type') != 'session_meta'
            or first.get('payload', {}).get('id') != session_id
        ):
            print(json.dumps({'status': 'identity-mismatch'}))
            raise SystemExit(0)
        size = handle.seek(0, 2)
        start = max(0, size - max_scan_bytes)
        handle.seek(start)
        if start:
            handle.readline()
        lines = handle.readlines()
except (OSError, UnicodeDecodeError, json.JSONDecodeError):
    print(json.dumps({'status': 'unavailable'}))
    raise SystemExit(0)

def timestamp_ms(value):
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

latest_match = None
current_turn = None
for index, raw_line in enumerate(lines):
    try:
        record = json.loads(raw_line.decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError):
        if index == 0 and start:
            continue
        if index == len(lines) - 1 and not raw_line.endswith(b'\\n'):
            continue
        print(json.dumps({'status': 'unavailable'}))
        raise SystemExit(0)
    payload = record.get('payload', {})
    if record.get('type') == 'event_msg' and payload.get('type') == 'task_started':
        turn_id = payload.get('turn_id')
        if isinstance(turn_id, str) and turn_id:
            current_turn = {'turnId': turn_id}
        continue
    if (
        record.get('type') != 'response_item'
        or payload.get('type') != 'message'
        or payload.get('role') != 'user'
    ):
        continue
    content = payload.get('content')
    if not isinstance(content, list):
        continue
    parts = [
        item.get('text') for item in content
        if isinstance(item, dict) and item.get('type') == 'input_text'
    ]
    if not parts or not all(isinstance(part, str) for part in parts):
        continue
    observed_at = timestamp_ms(record.get('timestamp'))
    if (
        '\\n'.join(parts) == expected_prompt
        and observed_at is not None
        and observed_at >= since_ms
        and current_turn is not None
    ):
        latest_match = {'observedAt': observed_at, 'turnId': current_turn['turnId']}

print(json.dumps(
    {'status': 'matched', **latest_match}
    if latest_match is not None
    else {'status': 'not-found'}
))
PY`;
}

type CodexTurnStateProbe =
  | { status: 'matched'; state: 'active' | 'idle'; observedAt: number; turnId: string }
  | { status: 'unavailable' | 'identity-mismatch' };

export function parseCodexTurnStateProbe(raw: string): CodexTurnStateProbe {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (
    parsed.status === 'matched' &&
    (parsed.state === 'active' || parsed.state === 'idle') &&
    typeof parsed.observedAt === 'number' &&
    typeof parsed.turnId === 'string'
  ) {
    return {
      status: 'matched',
      state: parsed.state,
      observedAt: parsed.observedAt,
      turnId: parsed.turnId,
    };
  }
  if (parsed.status === 'unavailable' || parsed.status === 'identity-mismatch') {
    return { status: parsed.status };
  }
  throw new Error(`Invalid Codex turn-state probe: ${raw}`);
}

export function buildCodexTurnStateProbeCommand(sessionId: string, sessionPath: string): string {
  return `
python3 - <<'PY'
import json
from datetime import datetime
from pathlib import Path

session_id = ${JSON.stringify(sessionId)}
session_path = Path(${JSON.stringify(sessionPath)})

def timestamp_ms(value):
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

try:
    with session_path.open('rb') as handle:
        first = json.loads(handle.readline().decode('utf-8'))
        if first.get('type') != 'session_meta' or first.get('payload', {}).get('id') != session_id:
            print(json.dumps({'status': 'identity-mismatch'}))
            raise SystemExit(0)
        size = handle.seek(0, 2)
        start = max(0, size - ${SESSION_SCAN_BYTES})
        handle.seek(start)
        if start:
            handle.readline()
        lines = handle.readlines()
except (OSError, UnicodeDecodeError, json.JSONDecodeError):
    print(json.dumps({'status': 'unavailable'}))
    raise SystemExit(0)

latest = None
for index, raw_line in enumerate(lines):
    try:
        record = json.loads(raw_line.decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError):
        if (index == 0 and start) or (index == len(lines) - 1 and not raw_line.endswith(b'\\n')):
            continue
        print(json.dumps({'status': 'unavailable'}))
        raise SystemExit(0)
    if record.get('type') != 'event_msg':
        continue
    payload = record.get('payload', {})
    event_type = payload.get('type')
    turn_id = payload.get('turn_id')
    observed_at = timestamp_ms(record.get('timestamp'))
    if not isinstance(turn_id, str) or not turn_id or observed_at is None:
        continue
    if event_type == 'task_started':
        latest = {'turnId': turn_id, 'state': 'active', 'observedAt': observed_at}
    elif event_type in ('task_complete', 'turn_aborted') and latest is not None and latest['turnId'] == turn_id:
        latest = {'turnId': turn_id, 'state': 'idle', 'observedAt': observed_at}

print(json.dumps({'status': 'matched', **latest} if latest is not None else {'status': 'unavailable'}))
PY`;
}

export function buildCodexSessionIdProbeCommand(sessionPath: string): string {
  return `
python3 - <<'PY'
import json
from pathlib import Path

session_path = Path(${JSON.stringify(sessionPath)})
try:
    with session_path.open() as handle:
        first = json.loads(handle.readline())
    session_id = first.get('payload', {}).get('id') if first.get('type') == 'session_meta' else None
except (OSError, UnicodeDecodeError, json.JSONDecodeError):
    session_id = None
print(json.dumps({'sessionId': session_id if isinstance(session_id, str) else None}))
PY`;
}

type CodexSessionBindingProbe =
  | { status: 'matched'; sessionId: string; sessionPath: string }
  | { status: 'unavailable' | 'identity-mismatch' };

export function parseCodexSessionBindingProbe(raw: string): CodexSessionBindingProbe {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (
    parsed.status === 'matched' &&
    typeof parsed.sessionId === 'string' &&
    typeof parsed.sessionPath === 'string'
  ) {
    return {
      status: 'matched',
      sessionId: parsed.sessionId,
      sessionPath: parsed.sessionPath,
    };
  }
  if (parsed.status === 'unavailable' || parsed.status === 'identity-mismatch') {
    return { status: parsed.status };
  }
  throw new Error(`Invalid Codex session binding probe: ${raw}`);
}

export function buildCodexSessionBindingProbeCommand(
  sessionPath: string,
  persistedSessionId?: string,
): string {
  return `
python3 - <<'PY'
import json
import os
from pathlib import Path

requested_path = Path(${JSON.stringify(sessionPath)})
persisted_session_id = ${persistedSessionId === undefined ? 'None' : JSON.stringify(persistedSessionId)}
try:
    session_path = Path(os.path.realpath(requested_path))
    with session_path.open() as handle:
        first = json.loads(handle.readline())
    session_id = first.get('payload', {}).get('id') if first.get('type') == 'session_meta' else None
except (OSError, UnicodeDecodeError, json.JSONDecodeError):
    print(json.dumps({'status': 'unavailable'}))
    raise SystemExit(0)

if not isinstance(session_id, str) or not session_id:
    print(json.dumps({'status': 'unavailable'}))
    raise SystemExit(0)

# Before native Codex ids were read from session_meta, Farmslot persisted the
# rollout filename (minus .jsonl). Accept exactly that historical format, then
# upgrade both id and path to the current native/canonical binding.
legacy_session_id = requested_path.name
if legacy_session_id.endswith('.jsonl'):
    legacy_session_id = legacy_session_id[:-len('.jsonl')]
if persisted_session_id is not None and persisted_session_id not in (session_id, legacy_session_id):
    print(json.dumps({'status': 'identity-mismatch'}))
    raise SystemExit(0)

print(json.dumps({
    'status': 'matched',
    'sessionId': session_id,
    'sessionPath': str(session_path),
}))
PY`;
}

async function probeCodexSessionBinding(
  vars: SlotVars,
  sessionPath: string,
  persistedSessionId?: string,
): Promise<CodexSessionBindingProbe> {
  const result = await execOnSlot(
    vars,
    buildCodexSessionBindingProbeCommand(sessionPath, persistedSessionId),
    { timeout: 10_000 },
  );
  if (result.exitCode !== 0) return { status: 'unavailable' };
  return parseCodexSessionBindingProbe(result.stdout.trim());
}

export const codexSessionObservability: RunnerObservability = {
  ...claudeHookObservability,
  async getTurnState(vars, target) {
    const paneId = await resolveTmuxPaneId(vars, target);
    if (!paneId) return null;
    const paneState = await readRunnerPaneObservabilityState(vars, paneId);
    const sessionId = paneState?.session_id;
    const sessionPath = paneState?.transcript_path;
    if (!sessionId || !sessionPath)
      return claudeHookObservability.getTurnState?.(vars, target) ?? null;
    const result = await execOnSlot(vars, buildCodexTurnStateProbeCommand(sessionId, sessionPath), {
      timeout: 10_000,
    });
    if (result.exitCode !== 0) return null;
    const probe = parseCodexTurnStateProbe(result.stdout.trim());
    return probe.status === 'matched'
      ? {
          value: probe.state,
          source: 'signal',
          confidence: 'high',
          observedAt: probe.observedAt,
          sessionId,
          turnToken: `${sessionId}:${probe.turnId}`,
        }
      : null;
  },
  async resolveSessionId(vars, sessionPath) {
    const result = await execOnSlot(vars, buildCodexSessionIdProbeCommand(sessionPath), {
      timeout: 10_000,
    });
    if (result.exitCode !== 0) return null;
    const parsed = JSON.parse(result.stdout.trim()) as { sessionId?: unknown };
    return typeof parsed.sessionId === 'string' && parsed.sessionId.trim()
      ? parsed.sessionId.trim()
      : null;
  },
  async normalizeRetainedSessionBinding(vars, binding) {
    const probe = await probeCodexSessionBinding(vars, binding.sessionPath, binding.sessionId);
    return probe.status === 'matched'
      ? { sessionId: probe.sessionId, sessionPath: probe.sessionPath }
      : null;
  },
  async promptAcceptedInSession(vars, _target, sessionId, sessionPath, promptText, sinceMs) {
    const result = await execOnSlot(
      vars,
      buildCodexPromptProbeCommand(sessionId, sessionPath, promptText, sinceMs),
      { timeout: 10_000 },
    );
    if (result.exitCode !== 0) return null;
    const probe = parseCodexPromptProbe(result.stdout.trim());
    return probe.status === 'matched'
      ? {
          value: true,
          source: 'signal',
          confidence: 'high',
          observedAt: probe.observedAt,
          exactPromptMatch: true,
          sessionId,
          turnToken: `${sessionId}:${probe.turnId}`,
        }
      : null;
  },
};
