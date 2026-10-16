import path from 'node:path';

import { execOnSlot } from '../core/exec.js';
import { resolveTmuxPaneId } from '../core/tmux.js';

import { readSlotClockMs } from './observability-clock.js';
import {
  activeToolFromHooks,
  contextPctFromStatusline,
  deriveRunnerActivity,
  deriveRunnerSessionDeliveryState,
  filterHooksByPane,
  filterStatuslineByPane,
  hookRecordMatchesRunnerSession,
  hookRecordMatchesRunnerSessionIdentity,
  lastTurnCompletedFromHooks,
  parseHookJsonl,
  parseStatuslineJson,
  promptAcceptedFromHooks,
  promptDigestMatchedFromHooks,
  readRunnerObservabilityFiles,
  readRunnerPaneObservabilityState,
  readRunnerSessionObservabilityState,
} from './observability-files.js';
import type {
  HookRecord,
  ObservabilityReading,
  RunnerObservability,
  RunnerSessionDeliveryState,
  SlotVars,
} from './observability-types.js';

type ClaudeInterruptionProbe =
  | { status: 'interrupted'; sessionId: string; observedAt: number }
  | { status: 'unavailable' };

export function parseClaudeInterruptionProbe(raw: string): ClaudeInterruptionProbe {
  const value: unknown = JSON.parse(raw);
  if (value && typeof value === 'object' && 'status' in value) {
    if (value.status === 'unavailable') return { status: 'unavailable' };
    if (
      value.status === 'interrupted' &&
      'sessionId' in value &&
      typeof value.sessionId === 'string' &&
      'observedAt' in value &&
      typeof value.observedAt === 'number' &&
      Number.isFinite(value.observedAt)
    )
      return { status: 'interrupted', sessionId: value.sessionId, observedAt: value.observedAt };
  }
  throw new Error('Invalid native interruption probe');
}

/** An interrupt may end the parent without Stop; child hooks do not end that parent. */
export function buildClaudeInterruptionProbeCommand(
  record: HookRecord | null,
  sessionId: string,
): string | null {
  if (
    deriveRunnerSessionDeliveryState(record, sessionId)?.value !== 'active' ||
    !record?.transcript_path ||
    path.basename(record.transcript_path) !== `${sessionId}.jsonl` ||
    (record.rootSessionId && record.rootSessionId !== sessionId) ||
    typeof record.turnStartedAt !== 'number' ||
    !Number.isFinite(record.turnStartedAt) ||
    record.turnStartedAt <= 0
  )
    return null;
  return `python3 - <<'PY'
import json, os
from datetime import datetime
from pathlib import Path
session = ${JSON.stringify(sessionId)}
transcript = Path(${JSON.stringify(record.transcript_path)})
since = ${Math.floor(record.turnStartedAt)}
def unavailable():
    print(json.dumps({'status': 'unavailable'}))
    raise SystemExit(0)
try:
    with transcript.open('rb') as stream:
        before = os.fstat(stream.fileno())
        offset = max(0, before.st_size - 8 * 1024 * 1024)
        stream.seek(offset)
        data = stream.read(8 * 1024 * 1024 + 1)
        after = os.fstat(stream.fileno())
    current = transcript.stat()
except OSError:
    unavailable()
identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns)
if identity(before) != identity(after) or identity(after) != identity(current) or not data.endswith(b'\\n'):
    unavailable()
if offset:
    boundary = data.find(b'\\n')
    if boundary < 0:
        unavailable()
    data = data[boundary + 1:]
candidate = None
markers = ('[Request interrupted by user]', '[Request interrupted by user for tool use]')
for line in reversed(data.splitlines()):
    if not line.strip():
        continue
    try:
        row = json.loads(line)
    except (ValueError, UnicodeError):
        unavailable()
    if not isinstance(row, dict):
        unavailable()
    if row.get('sessionId') != session or row.get('isSidechain') is not False:
        continue
    kind = row.get('type')
    if kind not in ('user', 'assistant'):
        continue
    message = row.get('message')
    if not isinstance(message, dict) or message.get('role') != kind:
        unavailable()
    content = message.get('content')
    blocks = content if isinstance(content, list) else []
    prompt = row.get('promptId')
    if candidate is not None:
        if kind == 'user' and prompt == candidate[0]:
            print(json.dumps({'status': 'interrupted', 'sessionId': session, 'observedAt': candidate[1]}))
            raise SystemExit(0)
        continue
    if kind == 'assistant':
        unavailable()  # Later root work, unlike child progress, supersedes an interrupt.
    control = (len(blocks) == 1 and isinstance(blocks[0], dict) and
               blocks[0].get('type') == 'text' and blocks[0].get('text') in markers and
               row.get('isMeta') is not True and isinstance(prompt, str) and bool(prompt))
    if control:
        try:
            stamp = datetime.fromisoformat(row['timestamp'].replace('Z', '+00:00'))
            if stamp.tzinfo is None:
                unavailable()
            observed = round(stamp.timestamp() * 1000)
        except (KeyError, TypeError, ValueError, AttributeError):
            unavailable()
        if observed < since:
            unavailable()
        candidate = (prompt, observed)
    elif not blocks or any(not isinstance(b, dict) or b.get('type') != 'tool_result' for b in blocks):
        unavailable()  # A new root prompt is not the earlier interrupted request.
unavailable()
PY`;
}

export function applyClaudeInterruptionProbe(
  record: HookRecord | null,
  sessionId: string,
  probe: ClaudeInterruptionProbe,
): ObservabilityReading<RunnerSessionDeliveryState> | null {
  const hook = deriveRunnerSessionDeliveryState(record, sessionId);
  if (
    hook?.value === 'active' &&
    probe.status === 'interrupted' &&
    probe.sessionId === sessionId &&
    typeof record?.turnStartedAt === 'number' &&
    probe.observedAt >= record.turnStartedAt
  )
    return { ...hook, value: 'idle', source: 'signal', observedAt: probe.observedAt };
  return hook;
}

async function readClaudeSessionTurnState(
  vars: SlotVars,
  record: HookRecord | null,
  sessionId: string,
) {
  const command = buildClaudeInterruptionProbeCommand(record, sessionId);
  if (!command) return deriveRunnerSessionDeliveryState(record, sessionId);
  const result = await execOnSlot(vars, command, { timeout: 10000, maxBuffer: 4096 });
  const probe: ClaudeInterruptionProbe =
    result.exitCode === 0 ? parseClaudeInterruptionProbe(result.stdout) : { status: 'unavailable' };
  return applyClaudeInterruptionProbe(record, sessionId, probe);
}

async function loadObservabilitySnapshot(vars: SlotVars, target: string) {
  const { hooksRaw, statuslineRaw } = await readRunnerObservabilityFiles(vars);
  const paneId = await resolveTmuxPaneId(vars, target);
  const hooks = filterHooksByPane(parseHookJsonl(hooksRaw), paneId);
  const statusline = filterStatuslineByPane(parseStatuslineJson(statuslineRaw), paneId);
  return { hooks, statusline };
}

export async function sessionPaneMoveIsSafe(
  vars: SlotVars,
  recordedPane: string | null | undefined,
  destinationPane: string,
  resolvePane: typeof resolveTmuxPaneId = resolveTmuxPaneId,
): Promise<boolean> {
  if (!recordedPane || recordedPane === destinationPane) return true;
  return (await resolvePane(vars, recordedPane)) !== recordedPane;
}

export function buildClaudeSessionDiscoveryCommand(repo: string, homeRoot?: string): string {
  return `python3 - <<'PY'
import json, os, re
from pathlib import Path
home = Path(${homeRoot === undefined ? 'str(Path.home())' : JSON.stringify(homeRoot)})
root = Path(os.environ.get('CLAUDE_CONFIG_DIR') or str(home / '.claude'))
repo = ${JSON.stringify(repo)}
keys = {key for name in {repo, os.path.realpath(repo)} for key in {name.replace('/', '-'), re.sub(r'[^a-zA-Z0-9]', '-', name)}}
directories = [root / 'projects' / key for key in keys]
paths = {os.path.realpath(p) for directory in directories if directory.is_dir() for p in directory.glob('*.jsonl')}
print(json.dumps(sorted(paths, key=lambda p: (os.path.getmtime(p), p), reverse=True)))
PY`;
}

export const claudeHookObservability: RunnerObservability = {
  async listSessionFiles(vars) {
    const result = await execOnSlot(vars, buildClaudeSessionDiscoveryCommand(vars.remoteRepo));
    if (result.exitCode !== 0) throw new Error('Claude session discovery failed');
    return JSON.parse(result.stdout) as string[];
  },
  async verifyResumedSessionBinding(vars, runnerPid, expectedSessionId, expectedSessionPath) {
    const result = await execOnSlot(
      vars,
      `python3 - <<'PY'
import ctypes, json, os, platform, struct
expected = ${JSON.stringify(expectedSessionPath)}
session = ${JSON.stringify(expectedSessionId)}
pid = int(${JSON.stringify(runnerPid)})
try:
    if platform.system() == 'Darwin':
        libc = ctypes.CDLL(None, use_errno=True)
        mib = (ctypes.c_int * 3)(1, 49, pid)  # CTL_KERN / KERN_PROCARGS2
        size = ctypes.c_size_t()
        if libc.sysctl(mib, 3, None, ctypes.byref(size), None, 0):
            raise OSError(ctypes.get_errno())
        buffer = ctypes.create_string_buffer(size.value)
        if libc.sysctl(mib, 3, buffer, ctypes.byref(size), None, 0):
            raise OSError(ctypes.get_errno())
        data = buffer.raw[:size.value]
        argc = struct.unpack_from('i', data)[0]
        offset = data.index(b'\\0', 4) + 1  # skip executable path
        while offset < len(data) and data[offset] == 0:
            offset += 1
        argv = []
        for _ in range(argc):
            end = data.index(b'\\0', offset)
            argv.append(data[offset:end].decode('utf8'))
            offset = end + 1
        # Stop at argc. Environment bytes are never decoded or returned.
    elif platform.system() == 'Linux':
        argv = open(f'/proc/{pid}/cmdline', 'rb').read().rstrip(b'\\0').decode('utf8').split('\\0')
    else:
        raise OSError('unsupported exact argv platform')
    args = argv[1:]
    if args and os.path.basename(args[0]) in {'claude', 'cli.js', 'claude.js'}:
        args = args[1:]  # Node-based installations carry the script before CLI flags.
    values = {'--model', '--effort', '--permission-mode', '--settings', '--setting-sources', '--system-prompt', '--append-system-prompt'}
    switches = {'--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--verbose', '--bare', '--disable-slash-commands'}
    resumed = []
    supported = True
    index = 0
    while index < len(args):
        flag, separator, inline = args[index].partition('=')
        if flag in values or flag in {'--resume', '-r', '--session-id'}:
            if separator:
                value = inline
            else:
                index += 1
                if index >= len(args):
                    supported = False
                    break
                value = args[index]
            if flag in {'--resume', '-r'}:
                resumed.append(value)
            if flag == '--session-id' and value != session:
                supported = False
        elif flag not in switches or separator:
            # Unknown/positional/fork/continue arguments cannot certify identity.
            supported = False
        index += 1
    matched = supported and resumed == [session] and os.path.basename(expected) == session + '.jsonl' and os.path.isfile(expected)
    print(json.dumps({'ok': matched, 'indeterminate': not supported, 'reason': None if matched else 'Cannot prove one explicit Claude resume of the saved conversation from exact process arguments'}))
except (OSError, ValueError, UnicodeError, struct.error):
    print(json.dumps({'ok': False, 'indeterminate': True, 'reason': 'Exact Claude resume arguments are unavailable'}))
PY`,
      { timeout: 15000 },
    );
    if (result.exitCode !== 0)
      return {
        ok: false,
        indeterminate: true,
        reason: 'Claude resumed-session ownership is unavailable',
      };
    return JSON.parse(result.stdout) as { ok: boolean; indeterminate?: true; reason?: string };
  },
  promptAcceptanceMode: 'hook-digest',
  async resolveSessionId(_vars, sessionPath) {
    const base = path.basename(sessionPath);
    return base.endsWith('.jsonl') ? base.slice(0, -'.jsonl'.length) : base || null;
  },
  async getActivity(vars, target) {
    const { hooks, statusline } = await loadObservabilitySnapshot(vars, target);
    const turn = await claudeHookObservability.getTurnState?.(vars, target);
    if (turn?.value === 'idle' && turn.source === 'signal') return { ...turn, value: 'idle' };
    return deriveRunnerActivity(hooks, statusline);
  },

  async getTurnState(vars, target, expectedTurnToken) {
    if (expectedTurnToken) {
      const separator = expectedTurnToken.lastIndexOf(':');
      const expectedSessionId = separator > 0 ? expectedTurnToken.slice(0, separator).trim() : '';
      if (!expectedSessionId) return null;
      const paneId = await resolveTmuxPaneId(vars, target);
      if (!paneId) return null;
      const [sessionState, paneState] = await Promise.all([
        readRunnerSessionObservabilityState(vars, expectedSessionId),
        readRunnerPaneObservabilityState(vars, paneId),
      ]);
      if (sessionState?.session_id !== expectedSessionId) return null;
      if (!(await sessionPaneMoveIsSafe(vars, sessionState.tmuxPane, paneId))) return null;
      if (paneState?.rootSessionId && paneState.rootSessionId !== expectedSessionId) return null;
      return readClaudeSessionTurnState(vars, sessionState, expectedSessionId);
    }
    const paneId = await resolveTmuxPaneId(vars, target);
    if (!paneId) return null;
    const paneState = await readRunnerPaneObservabilityState(vars, paneId);
    const sessionId = paneState?.session_id;
    if (!sessionId) return null;
    return readClaudeSessionTurnState(vars, paneState, sessionId);
  },

  async getContextPct(vars, target) {
    const { statusline } = await loadObservabilitySnapshot(vars, target);
    return contextPctFromStatusline(statusline);
  },

  async activeTool(vars, target) {
    const { hooks } = await loadObservabilitySnapshot(vars, target);
    return activeToolFromHooks(hooks);
  },

  async lastTurnCompletedAt(vars, target) {
    const { hooks } = await loadObservabilitySnapshot(vars, target);
    return lastTurnCompletedFromHooks(hooks);
  },

  async capturePromptAcceptanceBaseline(vars) {
    return readSlotClockMs(vars);
  },

  async promptAccepted(vars, target, promptDigest, sinceMs, paneRetired = false) {
    const { hooks } = await loadObservabilitySnapshot(vars, target);
    const reading = promptAcceptedFromHooks(
      hooks,
      promptDigest,
      sinceMs,
      500,
      Date.now(),
      undefined,
      paneRetired,
    );
    return reading
      ? {
          ...reading,
          exactPromptMatch: promptDigestMatchedFromHooks(hooks, promptDigest, sinceMs),
        }
      : null;
  },

  async getSessionDeliveryState(vars, target, sessionId, sessionPath) {
    const paneId = await resolveTmuxPaneId(vars, target);
    if (!paneId) return null;
    const expected = { sessionId, sessionPath, paneId };
    const [sessionState, paneState] = await Promise.all([
      readRunnerSessionObservabilityState(vars, sessionId),
      readRunnerPaneObservabilityState(vars, paneId),
    ]);
    if (!hookRecordMatchesRunnerSessionIdentity(sessionState, expected)) {
      return null;
    }
    if (!(await sessionPaneMoveIsSafe(vars, sessionState.tmuxPane, paneId))) {
      // A pane move is safe only after the pane that last owned the session is
      // gone. Otherwise resuming the transcript here would create two live
      // runners writing the same persisted session.
      return null;
    }
    // A freshly restored canonical worker window has no pane-scoped record yet.
    // Once the old pane is gone, the exact session-level Stop is authoritative
    // proof that the persisted session is safe to resume in the new pane.
    if (paneState && !hookRecordMatchesRunnerSession(paneState, expected)) {
      return null;
    }
    return readClaudeSessionTurnState(vars, sessionState, sessionId);
  },
};
