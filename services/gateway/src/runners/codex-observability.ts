import { execOnSlot } from '../core/exec.js';

import { claudeHookObservability } from './claude-observability.js';
import type { ObservabilityReading, RunnerObservability } from './observability-types.js';

const SESSION_SCAN_BYTES = 2 * 1024 * 1024;

interface JsonRecord {
  [key: string]: unknown;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function userPrompt(record: JsonRecord): string | null {
  if (record.type !== 'response_item' || !isRecord(record.payload)) return null;
  if (record.payload.type !== 'message' || record.payload.role !== 'user') return null;
  if (!Array.isArray(record.payload.content)) return null;
  const parts = record.payload.content
    .filter(isRecord)
    .filter((part) => part.type === 'input_text' && typeof part.text === 'string')
    .map((part) => String(part.text));
  return parts.length > 0 ? parts.join('\n') : null;
}

export function promptAcceptedFromCodexSession(
  raw: string,
  expectedPrompt: string,
  sinceMs: number,
): ObservabilityReading<boolean> | null {
  let latestMatch = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      // A bounded tail can begin inside one JSONL record; later complete records remain valid.
      continue;
    }
    if (!isRecord(record) || userPrompt(record) !== expectedPrompt) continue;
    const observedAt = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
    if (Number.isFinite(observedAt) && observedAt >= sinceMs) latestMatch = observedAt;
  }
  return latestMatch > 0
    ? {
        value: true,
        source: 'signal',
        confidence: 'high',
        observedAt: latestMatch,
        exactPromptMatch: true,
      }
    : null;
}

type CodexPromptProbe =
  | { status: 'matched'; observedAt: number }
  | { status: 'not-found' | 'unavailable' | 'identity-mismatch' };

export function parseCodexPromptProbe(raw: string): CodexPromptProbe {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (parsed.status === 'matched' && typeof parsed.observedAt === 'number') {
    return { status: 'matched', observedAt: parsed.observedAt };
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
    if '\\n'.join(parts) == expected_prompt and observed_at is not None and observed_at >= since_ms:
        latest_match = max(latest_match or 0, observed_at)

print(json.dumps(
    {'status': 'matched', 'observedAt': latest_match}
    if latest_match is not None
    else {'status': 'not-found'}
))
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

export const codexSessionObservability: RunnerObservability = {
  ...claudeHookObservability,
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
        }
      : null;
  },
};
