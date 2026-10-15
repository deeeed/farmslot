import { isRecord } from '@farmslot/protocol';

import { execOnSlot } from '../core/exec.js';
import { resolveExactTmuxWindowPane } from '../core/tmux.js';

import type {
  ObservabilityReading,
  RunnerObservability,
  RunnerSessionDeliveryState,
  SlotVars,
} from './observability-types.js';
import { probeRunnerDescendantPid } from './session-process.js';

/** Read only the native structured lifecycle records in the live process's open log. */
export function buildCursorTurnProbeCommand(pid: string): string {
  if (!/^\d+$/.test(pid)) throw new Error('Cursor process PID is required');
  return `python3 - <<'PY'
import json
import os
import subprocess
from datetime import datetime

pid = ${pid}
def unavailable():
    print('null')
    raise SystemExit(0)

opened = subprocess.run(['lsof', '-a', '-p', str(pid), '-Fn'], capture_output=True, text=True, timeout=5)
if opened.returncode != 0:
    unavailable()
logs = list(dict.fromkeys(line[1:] for line in opened.stdout.splitlines()
    if line.startswith('n') and '/cursor-agent-logs-' in line
    and os.path.basename(line[1:]).startswith('session-')
    and os.path.basename(line[1:]).endswith('.log')
    and os.path.basename(line[1:]).split('-')[-2] == str(pid)))
if len(logs) != 1:
    unavailable()
with open(logs[0], 'rb') as stream:
    header = stream.read(8192).splitlines()
    identities = []
    for line in header:
        if not line.startswith(b'{'):
            continue
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if record.get('event') == 'debug-session-start':
            identities.append(record)
    if len(identities) != 1 or identities[0].get('pid') != pid:
        unavailable()
    if os.path.realpath(identities[0].get('logFile', '')) != os.path.realpath(logs[0]):
        unavailable()
    size = stream.seek(0, os.SEEK_END)
    offset = max(0, size - 8 * 1024 * 1024)
    stream.seek(offset)
    raw = stream.read(8 * 1024 * 1024)
    if raw and not raw.endswith(b'\\n'):
        unavailable()
    lines = raw.splitlines()
    if offset:
        lines = lines[1:]
    # A log that grew during this read needs a fresh snapshot.
    if lines and not stream.tell() == size:
        unavailable()
for line in reversed(lines):
    stamp, separator, payload = line.partition(b' structured-log.info ')
    if not separator:
        continue
    try:
        record = json.loads(payload)
    except ValueError:
        unavailable()
    if not isinstance(record, dict):
        unavailable()
    if record.get('key') != 'agent_cli' or record.get('message') not in ('agent_cli.turn.start', 'agent_cli.turn.outcome'):
        continue
    metadata = record.get('metadata')
    if not isinstance(metadata, dict) or not isinstance(metadata.get('request_id'), str) or not metadata['request_id']:
        unavailable()
    try:
        observed = datetime.fromisoformat(stamp.decode()[1:-1].replace('Z', '+00:00'))
        if observed.tzinfo is None:
            unavailable()
        observed_at = observed.timestamp() * 1000
    except ValueError:
        unavailable()
    state = 'active' if record['message'] == 'agent_cli.turn.start' else 'idle'
    if state == 'idle' and metadata.get('outcome') not in ('success', 'error', 'aborted'):
        unavailable()
    print(json.dumps({'state': state, 'observedAt': observed_at, 'turnToken': str(pid) + ':' + metadata['request_id']}))
    raise SystemExit(0)
unavailable()
PY`;
}

interface CursorProbeReaders {
  pane: typeof resolveExactTmuxWindowPane;
  process: typeof probeRunnerDescendantPid;
  exec: typeof execOnSlot;
}

export async function readCursorTurnState(
  vars: SlotVars,
  target: string,
  overrides: Partial<CursorProbeReaders> = {},
): Promise<ObservabilityReading<RunnerSessionDeliveryState> | null> {
  const source = {
    pane: resolveExactTmuxWindowPane,
    process: probeRunnerDescendantPid,
    exec: execOnSlot,
    ...overrides,
  };
  const pane = await source.pane(vars, target);
  if (!pane) return null;
  const process = await source.process(vars, pane.panePid, 'cursor');
  if (process.state !== 'present') return null;
  const result = await source.exec(vars, buildCursorTurnProbeCommand(process.pid), {
    timeout: 10000,
  });
  if (result.exitCode !== 0) throw new Error('Cursor native lifecycle probe failed');
  const value: unknown = JSON.parse(result.stdout);
  if (
    !isRecord(value) ||
    (value.state !== 'idle' && value.state !== 'active') ||
    typeof value.observedAt !== 'number' ||
    !Number.isFinite(value.observedAt) ||
    typeof value.turnToken !== 'string'
  )
    return null;
  // Recheck the pane and process after I/O so a replaced worker cannot inherit old idle.
  const currentPane = await source.pane(vars, target);
  if (currentPane?.paneId !== pane.paneId || currentPane?.panePid !== pane.panePid) return null;
  const current = await source.process(vars, pane.panePid, 'cursor');
  if (current.state !== 'present' || current.pid !== process.pid) return null;
  return {
    value: value.state,
    observedAt: value.observedAt,
    turnToken: value.turnToken,
    source: 'signal',
    confidence: 'high',
  };
}

export function createCursorLogObservability(): RunnerObservability {
  return {
    async getActivity(vars, target) {
      const turn = await readCursorTurnState(vars, target);
      return turn ? { ...turn, value: turn.value === 'idle' ? 'idle' : 'composing' } : null;
    },
    async getTurnState(vars, target, expectedTurnToken) {
      const turn = await readCursorTurnState(vars, target);
      return expectedTurnToken && turn?.turnToken !== expectedTurnToken ? null : turn;
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
    // Lifecycle records do not prove the identity of submitted prompt text.
    async promptAccepted() {
      return null;
    },
    async getSessionDeliveryState() {
      return null;
    },
  };
}
