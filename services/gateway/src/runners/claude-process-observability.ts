import { isRecord } from '@farmslot/protocol';

import { execOnSlot } from '../core/exec.js';
import { lazyImport } from '../core/lazy-import.js';
import { resolveExactTmuxWindowPane } from '../core/tmux.js';

import type { SlotVars } from './observability-types.js';
import type { probeRunnerDescendantPid } from './session-process.js';

// The session process module reaches this one through the registry (a cycle).
const loadSessionProcess = lazyImport(() => import('./session-process.js'));

interface ClaudeProcessBindingRegistration {
  sessionId: string;
  status: 'busy' | 'idle' | 'waiting';
  observedAt: number | null;
}

export interface ClaudeProcessRegistration extends ClaudeProcessBindingRegistration {
  status: 'busy' | 'idle';
}

/** A pid registration from an earlier process is never current runner evidence. */
function claudeProcessBindingRegistration(
  value: unknown,
  pid: string,
  processStartedAt: number,
): ClaudeProcessBindingRegistration | null {
  if (
    !isRecord(value) ||
    String(value.pid) !== pid ||
    typeof value.startedAt !== 'number' ||
    value.startedAt < processStartedAt ||
    !Number.isFinite(processStartedAt) ||
    processStartedAt <= 0 ||
    typeof value.sessionId !== 'string' ||
    !/^[a-zA-Z0-9-]+$/.test(value.sessionId) ||
    (value.status !== 'busy' &&
      value.status !== 'idle' &&
      value.status !== 'shell' &&
      value.status !== 'waiting') ||
    (value.statusUpdatedAt !== undefined &&
      (typeof value.statusUpdatedAt !== 'number' ||
        !Number.isFinite(value.statusUpdatedAt) ||
        value.statusUpdatedAt < value.startedAt))
  )
    return null;
  return {
    sessionId: value.sessionId,
    // Claude Code 2.1.312 writes "shell" once a turn has ended while background shells still run:
    // the turn is idle; the background-work reader tracks the shells from the transcript.
    status: value.status === 'shell' ? 'idle' : value.status,
    observedAt: typeof value.statusUpdatedAt === 'number' ? value.statusUpdatedAt : null,
  };
}

/** Liveness readers retain their existing busy/idle observations. */
export function claudeProcessRegistration(
  value: unknown,
  pid: string,
  processStartedAt: number,
): ClaudeProcessRegistration | null {
  const registration = claudeProcessBindingRegistration(value, pid, processStartedAt);
  return registration && registration.status !== 'waiting'
    ? { ...registration, status: registration.status }
    : null;
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
export async function readClaudeProcessBinding(
  vars: SlotVars,
  target: string,
  overrides: Partial<ProcessReaders> = {},
) {
  const source: ProcessReaders = {
    pane: resolveExactTmuxWindowPane,
    process: async (...args) => (await loadSessionProcess()).probeRunnerDescendantPid(...args),
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
  const registration = claudeProcessBindingRegistration(
    value.record,
    process.pid,
    value.processStartedAt,
  );
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

/** A waiting registration establishes identity, not an active or idle turn. */
export async function readClaudeSessionBinding(
  vars: SlotVars,
  target: string,
  observedNotBeforeMs = 0,
  overrides: Partial<ProcessReaders> = {},
) {
  const binding = await readClaudeProcessBinding(vars, target, overrides);
  if (!binding || binding.observedAt < observedNotBeforeMs) return null;
  return {
    sessionId: binding.sessionId,
    sessionPath: binding.sessionPath,
    observedAt: binding.observedAt,
  };
}

/** A waiting registration establishes identity, not an active or idle turn. */
export async function readClaudeProcessState(
  vars: SlotVars,
  target: string,
  overrides: Partial<ProcessReaders> = {},
) {
  const binding = await readClaudeProcessBinding(vars, target, overrides);
  return binding && binding.status !== 'waiting' ? { ...binding, status: binding.status } : null;
}

/** Exact prompt acceptance from the runner's native parent transcript, bounded independently of hooks. */
export function buildClaudePromptAcceptanceCommand(
  sessionId: string,
  sessionPath: string,
  prompt: string,
  since: number,
): string {
  return `python3 - <<'PY'
import json,os
from datetime import datetime
from pathlib import Path
session=${JSON.stringify(sessionId)}
file=Path(${JSON.stringify(sessionPath)})
prompt=${JSON.stringify(prompt)}
since=${Math.floor(since)}
def unavailable():
 print('{}');raise SystemExit(0)
if file.name!=session+'.jsonl':unavailable()
try:
 with file.open('rb') as stream:
  before=os.fstat(stream.fileno());offset=max(0,before.st_size-8*1024*1024);stream.seek(offset);data=stream.read(8*1024*1024+1);after=os.fstat(stream.fileno())
 current=file.stat()
except OSError:unavailable()
identity=lambda s:(s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns)
if identity(before)!=identity(after) or identity(after)!=identity(current) or not data.endswith(b'\\n'):unavailable()
if offset:
 boundary=data.find(b'\\n')
 if boundary<0:unavailable()
 data=data[boundary+1:]
latest=None
for line in data.splitlines():
 try:row=json.loads(line)
 except (ValueError,UnicodeError):unavailable()
 if not isinstance(row,dict) or row.get('sessionId')!=session or row.get('isSidechain') is not False or row.get('isMeta') is True or row.get('type')!='user':continue
 message=row.get('message')
 if not isinstance(message,dict) or message.get('role')!='user':continue
 content=message.get('content')
 if isinstance(content,list):
  if any(not isinstance(x,dict) or x.get('type')!='text' for x in content):continue
  content=''.join(x.get('text','') for x in content)
 if not isinstance(content,str):continue
 try:stamp=datetime.fromisoformat(row.get('timestamp','').replace('Z','+00:00')).timestamp()*1000
 except (ValueError,TypeError,AttributeError):continue
 if stamp<since:continue
 latest={'accepted':content.replace('\\r\\n','\\n').strip()==prompt.replace('\\r\\n','\\n').strip(),'observedAt':stamp,'turnToken':session+':'+str(int(stamp))}
print(json.dumps(latest or {}))
PY`;
}

export async function readClaudePromptAcceptance(
  vars: SlotVars,
  target: string,
  sessionId: string,
  sessionPath: string,
  prompt: string,
  since: number,
  overrides: Partial<ProcessReaders> = {},
) {
  const before = await readClaudeProcessBinding(vars, target, overrides);
  if (!before || before.sessionId !== sessionId || before.sessionPath !== sessionPath) return null;
  const result = await (overrides.exec ?? execOnSlot)(
    vars,
    buildClaudePromptAcceptanceCommand(sessionId, sessionPath, prompt, since),
    { timeout: 10000, maxBuffer: 4096 },
  );
  if (result.exitCode !== 0) return null;
  const value: unknown = JSON.parse(result.stdout);
  if (
    !isRecord(value) ||
    value.accepted !== true ||
    typeof value.observedAt !== 'number' ||
    !Number.isFinite(value.observedAt) ||
    value.observedAt < since ||
    typeof value.turnToken !== 'string'
  )
    return null;
  const after = await readClaudeProcessBinding(vars, target, overrides);
  if (
    !after ||
    after.processPid !== before.processPid ||
    after.sessionId !== sessionId ||
    after.sessionPath !== sessionPath
  )
    return null;
  return {
    value: true,
    source: 'signal' as const,
    confidence: 'high' as const,
    observedAt: value.observedAt,
    turnToken: value.turnToken,
    exactPromptMatch: true,
  };
}
