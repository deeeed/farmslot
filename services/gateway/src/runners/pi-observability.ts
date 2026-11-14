import {
  isEffectiveReasoning,
  isRecord,
  type Run,
  type RunnerReasoningReceipt,
} from '@farmslot/protocol';

import { loadSlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';

import { claudeHookObservability } from './claude-observability.js';
import { runnerObservabilityDirForSlot } from './observability-files.js';
import type { RunnerObservability } from './observability-types.js';
import { reviewWorkspaceRunnerVars } from './review-workspace-context.js';
import { runnerSessionIdForPath } from './session-path-resolution.js';
import { resolveRunRetainedSessionBinding } from './session-process.js';
import { contextPaneId } from './session-record.js';
import {
  PYTHON_USAGE_TASK_PROMPT,
  type RecoveredUsageSession,
  workerUsageScope,
} from './session-usage-provider.js';

interface PiSessionScope {
  homeRoot?: string;
  bindings?: boolean;
  observabilityDir?: string;
  paneId?: string;
  slotId?: string;
  startedAt?: number;
  endedAt?: number;
  reviewerIntervals?: Array<{ startedAt: number; endedAt: number }>;
  taskDir?: string;
}

/** Read only Pi-owned session headers and, for recovery, the exact pane/session snapshot. */
export function buildPiSessionDiscoveryCommand(repo: string, scope: PiSessionScope = {}): string {
  return `python3 - <<'PY'
import datetime, json, os, re
from pathlib import Path
from urllib.parse import quote
${PYTHON_USAGE_TASK_PROMPT}
repo = ${JSON.stringify(repo)}
scope = json.loads(${JSON.stringify(JSON.stringify(scope))})
home = Path(scope.get('homeRoot') or str(Path.home()))
paths = []
for file in (home / '.pi' / 'agent' / 'sessions').glob('*/*.jsonl'):
    try:
        with file.open() as stream:
            header = json.loads(stream.readline())
        if header.get('type') != 'session' or os.path.realpath(header.get('cwd', '')) != os.path.realpath(repo):
            continue
        if scope.get('observabilityDir') or scope.get('taskDir'):
            started = datetime.datetime.fromisoformat(header['timestamp'].replace('Z', '+00:00')).timestamp() * 1000
            if started < scope['startedAt'] or started >= scope['endedAt']:
                continue
            if any(interval['startedAt'] <= started < interval['endedAt'] for interval in scope.get('reviewerIntervals', [])):
                continue
            session = file.stem
            snapshot_file = Path(scope['observabilityDir']) / 'sessions' / (quote(session, safe='') + '.json') if scope.get('observabilityDir') else None
            if snapshot_file and snapshot_file.exists():
                snapshot = json.loads(snapshot_file.read_text())
                if snapshot.get('session_id') != session or snapshot.get('runner') != 'pi' or snapshot.get('tmuxPane') != scope['paneId'] or snapshot.get('slotId') != scope['slotId']:
                    continue
                if os.path.realpath(snapshot.get('cwd', '')) != os.path.realpath(repo):
                    continue
            else:
                # Recycle removes pane snapshots. The first native user prompt retains its task binding.
                if not scope.get('taskDir') or scope['taskDir'] in ('.', '/'):
                    continue
                text = ''
                with file.open() as stream:
                    for line in stream:
                        message = json.loads(line).get('message')
                        if isinstance(message, dict) and message.get('role') == 'user':
                            content = message.get('content')
                            text = prompt_text(content)
                            break
                if not task_prompt_matches(text, scope['taskDir'], ('mark', 'TASK.md')):
                    continue
        if scope.get('bindings'):
            if not isinstance(header.get('id'), str) or not header['id']:
                continue
            paths.append({'runnerSessionId': header['id'], 'runnerSessionPath': os.path.realpath(file)})
        else:
            paths.append(os.path.realpath(file))
    except (OSError, ValueError, TypeError, KeyError):
        # Partial or unavailable runner-owned metadata cannot establish a binding.
        continue
print(json.dumps(sorted(paths, key=lambda entry: entry['runnerSessionPath'] if isinstance(entry, dict) else entry)))
PY`;
}

export function createPiHookObservability(): RunnerObservability {
  return {
    ...claudeHookObservability,
    async getReasoningReceipt(vars, session) {
      const result = await execOnSlot(
        vars,
        buildPiReasoningReceiptCommand(vars.remoteRepo, session),
        {
          timeout: 10_000,
          maxBuffer: 8192,
          selectNodeSupport: false,
        },
      );
      if (result.exitCode !== 0) throw new Error('Pi request receipt read failed');
      return parsePiReasoningReceipt(JSON.parse(result.stdout));
    },
    async promptAcceptedInSession(vars, _target, sessionId, sessionPath, prompt, since) {
      const result = await execOnSlot(
        vars,
        buildPiPromptAcceptanceCommand(vars.remoteRepo, sessionId, sessionPath, prompt, since),
        { timeout: 10_000, maxBuffer: 4096 },
      );
      if (result.exitCode !== 0) return null;
      const value: unknown = JSON.parse(result.stdout);
      return isRecord(value) &&
        value.accepted === true &&
        typeof value.observedAt === 'number' &&
        Number.isFinite(value.observedAt) &&
        value.observedAt >= since &&
        typeof value.turnToken === 'string'
        ? {
            value: true,
            source: 'signal',
            confidence: 'high',
            observedAt: value.observedAt,
            turnToken: value.turnToken,
            exactPromptMatch: true,
          }
        : null;
    },
    async listSessionFiles(vars) {
      const result = await execOnSlot(vars, buildPiSessionDiscoveryCommand(vars.remoteRepo), {
        timeout: 10_000,
        selectNodeSupport: false,
      });
      if (result.exitCode !== 0) throw new Error('Pi session discovery failed');
      return JSON.parse(result.stdout) as string[];
    },
  };
}

export function parsePiReasoningReceipt(value: unknown): RunnerReasoningReceipt | null {
  return isRecord(value) &&
    typeof value.sessionId === 'string' &&
    typeof value.provider === 'string' &&
    typeof value.model === 'string' &&
    typeof value.selectedModel === 'string' &&
    typeof value.observedAt === 'string' &&
    Number.isFinite(Date.parse(value.observedAt)) &&
    isEffectiveReasoning(value.reasoning)
    ? {
        sessionId: value.sessionId,
        provider: value.provider,
        model: value.model,
        selectedModel: value.selectedModel,
        observedAt: value.observedAt,
        reasoning: value.reasoning,
      }
    : null;
}

/** Read two small runner-owned records; never scan the conversation for a label. */
export function buildPiReasoningReceiptCommand(
  repo: string,
  session: { sessionId: string; sessionPath: string; model: string; since: number },
): string {
  return `python3 - <<'PY'
import json,os
from datetime import datetime
from pathlib import Path
repo=${JSON.stringify(repo)}
session=json.loads(${JSON.stringify(JSON.stringify(session))})
file=Path(session['sessionPath'])
def unavailable():
 print('{}');raise SystemExit(0)
try:
 with file.open('rb') as stream:header=json.loads(stream.readline(65536))
 with Path(str(file)+'.farmslot-request.json').open('rb') as stream:receipt=json.loads(stream.read(4096))
 stamp=datetime.fromisoformat(receipt['observedAt'].replace('Z','+00:00')).timestamp()*1000
except (OSError,ValueError,KeyError,TypeError,AttributeError):unavailable()
if not isinstance(header,dict) or header.get('type')!='session' or os.path.realpath(header.get('cwd',''))!=os.path.realpath(repo):unavailable()
if session['sessionId'] not in (header.get('id'),file.stem) or receipt.get('sessionId')!=file.stem or stamp<session['since']:unavailable()
model=session['model']
if model.rsplit(':',1)[-1] in ('off','minimal','low','medium','high','xhigh','max'):model=model.rsplit(':',1)[0]
if model not in (receipt.get('model'),str(receipt.get('provider'))+'/'+str(receipt.get('model'))):unavailable()
receipt['sessionId']=session['sessionId']
receipt['selectedModel']=session['model']
print(json.dumps(receipt))
PY`;
}

/** The retained Pi header binds a bounded native user-message read to its exact cwd. */
export function buildPiPromptAcceptanceCommand(
  repo: string,
  sessionId: string,
  sessionPath: string,
  prompt: string,
  since: number,
): string {
  return `python3 - <<'PY'
import json,os
from datetime import datetime
from pathlib import Path
repo=${JSON.stringify(repo)}
session=${JSON.stringify(sessionId)}
file=Path(${JSON.stringify(sessionPath)})
prompt=${JSON.stringify(prompt)}
since=${Math.floor(since)}
def unavailable():
 print('{}');raise SystemExit(0)
try:
 with file.open('rb') as stream:
  before=os.fstat(stream.fileno());header=json.loads(stream.readline(65536))
  offset=max(0,before.st_size-8*1024*1024);stream.seek(offset);data=stream.read(8*1024*1024+1);after=os.fstat(stream.fileno())
 current=file.stat()
except (OSError,ValueError):unavailable()
identity=lambda s:(s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns)
if identity(before)!=identity(after) or identity(after)!=identity(current) or not data.endswith(b'\\n'):unavailable()
if not isinstance(header,dict) or header.get('type')!='session' or header.get('id')!=session or os.path.realpath(header.get('cwd',''))!=os.path.realpath(repo):unavailable()
if offset:
 boundary=data.find(b'\\n')
 if boundary<0:unavailable()
 data=data[boundary+1:]
latest=None
for line in data.splitlines():
 try:row=json.loads(line)
 except (ValueError,UnicodeError):unavailable()
 if not isinstance(row,dict) or row.get('type')!='message':continue
 message=row.get('message')
 if not isinstance(message,dict) or message.get('role')!='user':continue
 content=message.get('content')
 if isinstance(content,list):
  if any(not isinstance(x,dict) or x.get('type')!='text' or not isinstance(x.get('text'),str) for x in content):continue
  content=''.join(x['text'] for x in content)
 if not isinstance(content,str) or not isinstance(row.get('id'),str):continue
 try:stamp=datetime.fromisoformat(row.get('timestamp','').replace('Z','+00:00')).timestamp()*1000
 except (ValueError,TypeError,AttributeError):continue
 if stamp<since:continue
 latest={'accepted':content.replace('\\r\\n','\\n').strip()==prompt.replace('\\r\\n','\\n').strip(),'observedAt':stamp,'turnToken':session+':'+str(int(stamp))}
print(json.dumps(latest or {}))
PY`;
}

/** A reused fix context can own several Pi sessions. Reviewers never enter its rollup. */
export async function recoverPiUsageSessions(run: Run): Promise<RecoveredUsageSession[]> {
  if (!run.slotId && !run.reviewWorkspace) return [];
  const scope = workerUsageScope(run, 'pi');
  const sessions = new Map<string, RecoveredUsageSession>();
  const vars = run.slotId ? await loadSlotVars(run.slotId) : await reviewWorkspaceRunnerVars(run);
  if (!vars) return [];
  for (const { context, startedAt, endedAt, taskDir } of scope.contexts) {
    const retained = resolveRunRetainedSessionBinding(run, context);
    if (retained.binding) {
      sessions.set(retained.binding.runnerSessionPath, {
        contextId: context.id,
        ...retained.binding,
      });
    }
    const paneId = context.target && contextPaneId(context.target);
    if (
      retained.incompleteBinding ||
      (!run.reviewWorkspace && !paneId) ||
      !Number.isFinite(startedAt)
    )
      continue;
    const result = await execOnSlot(
      vars,
      buildPiSessionDiscoveryCommand(vars.remoteRepo, {
        ...(run.slotId
          ? {
              observabilityDir: await runnerObservabilityDirForSlot(vars),
              paneId: paneId ?? undefined,
              slotId: run.slotId,
            }
          : {}),
        startedAt,
        endedAt,
        reviewerIntervals: scope.reviewerIntervals,
        taskDir: run.reviewWorkspace?.taskPath ?? taskDir,
        bindings: !run.slotId,
      }),
      { timeout: 10_000, selectNodeSupport: false },
    );
    if (result.exitCode !== 0) throw new Error('Pi usage session recovery failed');
    const discovered: Array<
      string | Pick<RecoveredUsageSession, 'runnerSessionId' | 'runnerSessionPath'>
    > = JSON.parse(result.stdout);
    for (const entry of discovered) {
      const binding =
        typeof entry === 'string'
          ? { runnerSessionId: runnerSessionIdForPath(entry), runnerSessionPath: entry }
          : entry;
      sessions.set(binding.runnerSessionPath, { contextId: context.id, ...binding });
    }
  }
  return [...sessions.values()];
}
