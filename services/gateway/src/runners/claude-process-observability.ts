import { isRecord } from '@farmslot/protocol';

import { execOnSlot } from '../core/exec.js';
import { resolveExactTmuxWindowPane } from '../core/tmux.js';

import type { SlotVars } from './observability-types.js';
import type { probeRunnerDescendantPid } from './session-process.js';

export interface ClaudeProcessRegistration {
  sessionId: string;
  status: 'busy' | 'idle';
  observedAt: number | null;
}

/** A pid registration from an earlier process is never current runner evidence. */
export function claudeProcessRegistration(
  value: unknown,
  pid: string,
  processStartedAt: number,
): ClaudeProcessRegistration | null {
  if (
    !isRecord(value) ||
    String(value.pid) !== pid ||
    typeof value.startedAt !== 'number' ||
    value.startedAt < processStartedAt ||
    !Number.isFinite(processStartedAt) ||
    processStartedAt <= 0 ||
    typeof value.sessionId !== 'string' ||
    !/^[a-zA-Z0-9-]+$/.test(value.sessionId) ||
    (value.status !== 'busy' && value.status !== 'idle') ||
    (value.statusUpdatedAt !== undefined &&
      (typeof value.statusUpdatedAt !== 'number' ||
        !Number.isFinite(value.statusUpdatedAt) ||
        value.statusUpdatedAt < value.startedAt))
  )
    return null;
  return {
    sessionId: value.sessionId,
    status: value.status,
    observedAt: typeof value.statusUpdatedAt === 'number' ? value.statusUpdatedAt : null,
  };
}

/** Reads only public native session metadata, never runner credentials or output text. */
export function buildClaudeProcessProbeCommand(pid: string, repo: string): string {
  return `python3 - <<'PY'
import json, os, subprocess, time
from datetime import datetime
from pathlib import Path
pid = ${JSON.stringify(pid)}
repo = ${JSON.stringify(repo)}
def unavailable():
    print('{}')
    raise SystemExit(0)
try:
    stamp = subprocess.check_output(['ps', '-p', pid, '-o', 'lstart='], env={**os.environ, 'LC_ALL': 'C'}, text=True).strip()
    started = time.mktime(datetime.strptime(stamp, '%a %b %d %H:%M:%S %Y').timetuple()) * 1000
    root = Path(os.environ.get('CLAUDE_CONFIG_DIR') or str(Path.home() / '.claude'))
    file = root / 'sessions' / (pid + '.json')
    record = json.loads(file.read_text())
    if not isinstance(record, dict) or os.path.realpath(record.get('cwd', '')) != os.path.realpath(repo):
        unavailable()
    session = record.get('sessionId')
    if not isinstance(session, str) or not session or '/' in session or '\\\\' in session:
        unavailable()
    paths = list((root / 'projects').glob('*/' + session + '.jsonl'))
    if not paths:
        unavailable()
    transcript = max(paths, key=lambda p: (p.stat().st_mtime_ns, str(p)))
    observation = {k: record.get(k) for k in ['pid','sessionId','startedAt','status']}
    observation['statusUpdatedAt'] = record.get('statusUpdatedAt', file.stat().st_mtime_ns / 1000000)
    if json.loads(file.read_text()) != record:
        unavailable()
    print(json.dumps({'record': observation, 'processStartedAt': started, 'sessionPath': str(transcript)}))
except (OSError, ValueError, subprocess.SubprocessError):
    unavailable()
PY`;
}

interface ProcessReaders {
  pane: typeof resolveExactTmuxWindowPane;
  process: typeof probeRunnerDescendantPid;
  exec: typeof execOnSlot;
}

/** Bind registration to the exact pane's live runner, rechecking ownership after the read. */
export async function readClaudeProcessState(
  vars: SlotVars,
  target: string,
  overrides: Partial<ProcessReaders> = {},
) {
  const source: ProcessReaders = {
    pane: resolveExactTmuxWindowPane,
    process: async (...args) =>
      (await import('./session-process.js')).probeRunnerDescendantPid(...args),
    exec: execOnSlot,
    ...overrides,
  };
  const pane = await source.pane(vars, target);
  if (!pane) return null;
  const process = await source.process(vars, pane.panePid, 'claude');
  if (process.state !== 'present') return null;
  const result = await source.exec(
    vars,
    buildClaudeProcessProbeCommand(process.pid, vars.remoteRepo),
    {
      timeout: 10000,
      maxBuffer: 16384,
    },
  );
  if (result.exitCode !== 0) return null;
  const value: unknown = JSON.parse(result.stdout);
  if (
    !isRecord(value) ||
    typeof value.processStartedAt !== 'number' ||
    typeof value.sessionPath !== 'string'
  )
    return null;
  const registration = claudeProcessRegistration(value.record, process.pid, value.processStartedAt);
  if (!registration || registration.observedAt === null) return null;
  const currentPane = await source.pane(vars, target);
  const current = await source.process(vars, pane.panePid, 'claude');
  if (
    currentPane?.paneId !== pane.paneId ||
    currentPane.panePid !== pane.panePid ||
    current.state !== 'present' ||
    current.pid !== process.pid
  )
    return null;
  return {
    ...registration,
    observedAt: registration.observedAt,
    sessionPath: value.sessionPath,
    processPid: process.pid,
  };
}
