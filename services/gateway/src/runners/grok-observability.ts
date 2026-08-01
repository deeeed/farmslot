import { execOnSlot } from '../core/exec.js';

import type { RunnerObservability, SlotVars } from './observability-types.js';

type GrokPromptSignalProbe =
  | { status: 'matched'; promptAcceptedAt: number | null }
  | { status: 'unavailable' | 'ambiguous' };

type ProbeGrokPromptSignal = (
  vars: SlotVars,
  target: string,
  sinceMs: number,
  promptText: string,
) => Promise<GrokPromptSignalProbe>;

type ReadGrokClockMs = (vars: SlotVars) => Promise<number>;

export function parseGrokPromptSignalProbe(raw: string): GrokPromptSignalProbe {
  const value = JSON.parse(raw) as Record<string, unknown>;
  if (value.status === 'unavailable' || value.status === 'ambiguous') {
    return { status: value.status };
  }
  if (
    value.status !== 'matched' ||
    (value.promptAcceptedAt !== null && typeof value.promptAcceptedAt !== 'number')
  ) {
    throw new Error(`Invalid Grok prompt signal probe: ${raw}`);
  }
  return { status: 'matched', promptAcceptedAt: value.promptAcceptedAt };
}

async function probeGrokPromptSignal(
  vars: SlotVars,
  target: string,
  sinceMs: number,
  promptText: string,
): Promise<GrokPromptSignalProbe> {
  const result = await execOnSlot(
    vars,
    buildGrokPromptSignalProbeCommand(vars, target, sinceMs, promptText),
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Grok prompt signal probe failed: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`,
    );
  }
  return parseGrokPromptSignalProbe(result.stdout.trim());
}

async function readGrokClockMs(vars: SlotVars): Promise<number> {
  const result = await execOnSlot(
    vars,
    `python3 -c 'import time; print(time.time_ns() // 1000000)'`,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Grok remote clock probe failed: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`,
    );
  }
  const clockMs = Number.parseInt(result.stdout.trim(), 10);
  if (!Number.isSafeInteger(clockMs) || clockMs <= 0) {
    throw new Error(`Invalid Grok remote clock probe: ${result.stdout.trim()}`);
  }
  return clockMs;
}

export function buildGrokPromptSignalProbeCommand(
  vars: SlotVars,
  target: string,
  sinceMs: number,
  promptText: string,
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
since_ms = ${Math.floor(sinceMs)}
expected_prompt = ${JSON.stringify(promptText)}
home = Path.home()
active_path = home / '.grok' / 'active_sessions.json'
history_paths = list(dict.fromkeys([
    home / '.grok' / 'sessions' / quote(repo, safe='') / 'prompt_history.jsonl',
    home / '.grok' / 'sessions' / quote(os.path.realpath(repo), safe='') / 'prompt_history.jsonl',
]))
history_paths = [path for path in history_paths if path.is_file()]

if not active_path.is_file() or not history_paths:
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
    if os.path.realpath(str(item.get('cwd', ''))) == repo_key
    and isinstance(item.get('pid'), int)
    and belongs_to_pane(item['pid'])
]
if not matching:
    print(json.dumps({'status': 'unavailable'}))
    raise SystemExit(0)
candidates = []
for item in matching:
    session_id = item.get('session_id')
    timestamp = item.get('opened_at')
    if not isinstance(session_id, str) or not session_id or not isinstance(timestamp, str):
        continue
    candidates.append({
        'session_id': session_id,
        'pid': item['pid'],
        'opened_at_ms': int(
            datetime.fromisoformat(timestamp.replace('Z', '+00:00')).timestamp() * 1000
        ),
    })
if len(candidates) != 1:
    print(json.dumps({'status': 'ambiguous' if candidates else 'unavailable'}))
    raise SystemExit(0)

candidate = candidates[0]
accepted_at = None
max_scan_bytes = 1024 * 1024
for history_path in history_paths:
    with history_path.open('rb') as handle:
        size = handle.seek(0, 2)
        start = max(0, size - max_scan_bytes)
        handle.seek(start)
        if start:
            # The bounded tail starts in an arbitrary record; discard that fragment.
            handle.readline()
        lines = handle.readlines()
        for index, raw_line in enumerate(lines):
            line = raw_line.decode('utf-8', errors='replace')
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                # Grok appends this file live. Only an unterminated final record is expected.
                if index == len(lines) - 1 and not raw_line.endswith(b'\\n'):
                    continue
                raise
            if event.get('session_id') != candidate['session_id']:
                continue
            timestamp = event.get('timestamp')
            if not isinstance(timestamp, str):
                continue
            event_ms = int(datetime.fromisoformat(timestamp.replace('Z', '+00:00')).timestamp() * 1000)
            if event_ms < max(candidate['opened_at_ms'], since_ms):
                continue
            if (
                event.get('prompt') == expected_prompt
                and event.get('is_bash') is False
            ):
                accepted_at = max(event_ms, accepted_at or 0)

print(json.dumps({'status': 'matched', 'promptAcceptedAt': accepted_at}))
PY`;
}

export function createGrokLogObservability(
  probe: ProbeGrokPromptSignal = probeGrokPromptSignal,
  readClock: ReadGrokClockMs = readGrokClockMs,
): RunnerObservability {
  return {
    async getActivity() {
      return null;
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
        ? { value: false, source: 'signal', confidence: 'medium', observedAt: Date.now() }
        : {
            value: true,
            source: 'signal',
            confidence: 'high',
            observedAt: signal.promptAcceptedAt,
          };
    },
    async getSessionDeliveryState() {
      return null;
    },
  };
}

export const grokLogObservability = createGrokLogObservability();
