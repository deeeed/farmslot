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
import type { RunnerObservability, SlotVars } from './observability-types.js';

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
      return deriveRunnerSessionDeliveryState(sessionState, expectedSessionId);
    }
    const paneId = await resolveTmuxPaneId(vars, target);
    if (!paneId) return null;
    const paneState = await readRunnerPaneObservabilityState(vars, paneId);
    const sessionId = paneState?.session_id;
    if (!sessionId) return null;
    return deriveRunnerSessionDeliveryState(paneState, sessionId);
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
    return deriveRunnerSessionDeliveryState(sessionState, sessionId);
  },
};
