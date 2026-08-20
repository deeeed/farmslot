import { type AgentContext, type Run } from '@farmslot/protocol';

import { type loadSlotVars, resolveProjectRuntimeDir } from '../core/config.js';
import { execOnSlot, type ExecOnSlotOptions } from '../core/exec.js';
import { shellQuote } from '../core/tmux.js';

import {
  observedAtFromRecord,
  parseHookJsonl,
  readRunnerObservabilityFiles,
  readRunnerPaneObservabilityState,
} from './observability-files.js';
import type { ObservabilityReading } from './observability-types.js';
import {
  getRunnerDefinition,
  getRunnerObservability,
  runnerPersistsSessionFiles,
  runnerProcessPatternSource,
} from './registry.js';
import {
  chooseRunnerSessionPath,
  dispatchStartedAtMs,
  findSessionStartFromHooks,
  loadSessionMtimesMs,
  RUNNER_SESSION_CAPTURE_MAX_POLLS,
  RUNNER_SESSION_CAPTURE_POLL_MS,
  RUNNER_SESSION_DISPATCH_SLACK_MS,
  runnerSessionIdForPath,
  sessionPathStartedAfterDispatch,
  statSessionPathMtimeMs,
} from './session-path-resolution.js';

export type RunnerSessionBindingSource = 'hook' | 'native' | 'filesystem';

export interface RunnerSessionBinding {
  runnerSessionPath: string;
  runnerSessionId: string;
  source: RunnerSessionBindingSource;
}

export interface RunnerSessionMetadata {
  runnerSessionPath: string | null;
  runnerSessionId: string | null;
}

export interface RunnerSessionCaptureOptions {
  sinceMs?: number;
  observedNotBeforeMs?: number;
  paneId?: string | null;
  slotId?: string | null;
  excludedSessionId?: string | null;
  excludedSessionPath?: string | null;
  /** Exact first prompt, used only for runner-native fallback attribution. */
  promptText?: string;
  /** Provider-clock boundary captured immediately before prompt delivery. */
  promptAcceptedSinceMs?: number | null;
}

export async function readPaneProcessStartedAtMs(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  paneId: string,
  runnerId?: string | null,
): Promise<number | null> {
  const processPattern = runnerId ? runnerProcessPatternSource(runnerId) : '';
  const script = `
python3 - <<'PY'
import datetime
import ctypes
import os
import platform
import re
import subprocess
import sys
import time

pane = ${JSON.stringify(paneId)}
pattern = ${JSON.stringify(processPattern)}
try:
    pane_pid = subprocess.check_output(
        ['tmux', 'display-message', '-p', '-t', pane, '#{pane_pid}'],
        text=True,
    ).strip()
    children = {}
    commands = {}
    executables = {}
    for row in subprocess.check_output(
        ['ps', '-axo', 'pid=,ppid=,comm=,command='], text=True
    ).splitlines():
        parts = row.strip().split(None, 3)
        if len(parts) < 2:
            continue
        pid, ppid = parts[:2]
        executable = parts[2] if len(parts) >= 3 else ''
        command = parts[3] if len(parts) == 4 else executable
        commands[pid] = command
        executables[pid] = executable
        children.setdefault(ppid, []).append(pid)
    pid = pane_pid
    if pattern:
        queue = [(pane_pid, 0)]
        matches = []
        while queue:
            candidate, depth = queue.pop(0)
            command = commands.get(candidate, '')
            executable = executables.get(candidate, '')
            if '__farmslot_status' not in command and re.search(pattern, command):
                executable_name = os.path.basename(executable)
                strong = bool(
                    re.fullmatch(pattern, executable_name)
                    or re.fullmatch(pattern, executable)
                )
                shell_wrapper = os.path.basename(executable) in {'bash', 'zsh', 'sh', 'fish'}
                matches.append((strong, not shell_wrapper, depth, candidate))
            queue.extend((child, depth + 1) for child in children.get(candidate, []))
        if not matches:
            raise ValueError('runner process not found under pane')
        # Prefer the runner executable itself, then a non-shell launcher. Among
        # exact executable matches prefer the shallowest process: descendants
        # such as codex-code-mode-host are tools owned by the turn, not the
        # retained runner generation.
        pid = max(matches, key=lambda item: (item[0], item[1], -item[2]))[3]

    if platform.system() == 'Darwin':
        class ProcBsdInfo(ctypes.Structure):
            _fields_ = [
                ('flags', ctypes.c_uint32), ('status', ctypes.c_uint32),
                ('xstatus', ctypes.c_uint32), ('pid', ctypes.c_uint32),
                ('ppid', ctypes.c_uint32), ('uid', ctypes.c_uint32),
                ('gid', ctypes.c_uint32), ('ruid', ctypes.c_uint32),
                ('rgid', ctypes.c_uint32), ('svuid', ctypes.c_uint32),
                ('svgid', ctypes.c_uint32), ('rfu_1', ctypes.c_uint32),
                ('comm', ctypes.c_char * 16), ('name', ctypes.c_char * 32),
                ('nfiles', ctypes.c_uint32), ('pgid', ctypes.c_uint32),
                ('pjobc', ctypes.c_uint32), ('e_tdev', ctypes.c_uint32),
                ('e_tpgid', ctypes.c_uint32), ('nice', ctypes.c_int32),
                ('start_tvsec', ctypes.c_uint64), ('start_tvusec', ctypes.c_uint64),
            ]
        info = ProcBsdInfo()
        libproc = ctypes.CDLL('/usr/lib/libproc.dylib')
        size = libproc.proc_pidinfo(int(pid), 3, 0, ctypes.byref(info), ctypes.sizeof(info))
        if size != ctypes.sizeof(info):
            raise ValueError('libproc start-time probe failed')
        print(info.start_tvsec * 1000 + info.start_tvusec // 1000)
    elif os.path.isfile(f'/proc/{pid}/stat'):
        fields = open(f'/proc/{pid}/stat').read().split()
        start_ticks = int(fields[21])
        uptime = float(open('/proc/uptime').read().split()[0])
        ticks_per_second = os.sysconf(os.sysconf_names['SC_CLK_TCK'])
        print(int((time.time() - uptime + start_ticks / ticks_per_second) * 1000))
    else:
        started = subprocess.check_output(
            ['ps', '-p', pid, '-o', 'lstart='], text=True,
            env={**os.environ, 'LC_ALL': 'C'},
        ).strip()
        started_at = datetime.datetime.strptime(started, '%a %b %d %H:%M:%S %Y').astimezone()
        print(int(started_at.timestamp() * 1000))
except Exception as error:
    print(f'pane process start probe failed: {error}', file=sys.stderr)
    raise SystemExit(1)
PY`;
  const result = await execOnSlot(vars, script);
  if (result.exitCode !== 0) return null;
  const parsed = Number(result.stdout.trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export interface PersistedRunnerSessionCandidate {
  label: string;
  runnerSessionId?: string | null;
  runnerSessionPath?: string | null;
}

export type PersistedRunnerSessionBindingResult =
  | {
      binding: { runnerSessionId: string; runnerSessionPath: string };
      reason: null;
      incompleteBinding?: never;
    }
  | {
      binding: null;
      reason: string | null;
      /**
       * Set only when a candidate carried half a retained identity. That proves
       * neither continuity nor a fresh session, so callers must fail closed. An
       * absent binding without this flag is a legitimate fresh session and may
       * be delivered through the fresh post-launch contract.
       */
      incompleteBinding?: true;
    };

/**
 * Resolve retained-session metadata as one atomic binding. A higher-priority
 * source with only half of the pair is unsafe and must not borrow the missing
 * field from a different run or context.
 */
export function resolvePersistedRunnerSessionBinding(
  candidates: readonly PersistedRunnerSessionCandidate[],
): PersistedRunnerSessionBindingResult {
  for (const candidate of candidates) {
    const runnerSessionId = candidate.runnerSessionId?.trim() ?? '';
    const runnerSessionPath = candidate.runnerSessionPath?.trim() ?? '';
    if (!runnerSessionId && !runnerSessionPath) continue;
    if (!runnerSessionId || !runnerSessionPath) {
      return {
        binding: null,
        reason: `${candidate.label} has incomplete retained session metadata`,
        incompleteBinding: true,
      };
    }
    return {
      binding: { runnerSessionId, runnerSessionPath },
      reason: null,
    };
  }
  return { binding: null, reason: null };
}

/** Resolve one run/context's retained session without mixing partial identities. */
export function resolveRunRetainedSessionBinding(
  run: {
    agentContexts?: Run['agentContexts'];
    metrics: Pick<Run['metrics'], 'runnerSessionId' | 'runnerSessionPath'>;
  },
  context?: Pick<AgentContext, 'runnerSessionId' | 'runnerSessionPath'> | null,
): PersistedRunnerSessionBindingResult {
  if (context === null) {
    return { binding: null, reason: 'requested agent context is unavailable' };
  }
  return resolvePersistedRunnerSessionBinding(
    context
      ? [
          {
            label: 'agent context',
            runnerSessionId: context.runnerSessionId,
            runnerSessionPath: context.runnerSessionPath,
          },
        ]
      : [
          {
            label: 'run metrics',
            runnerSessionId: run.metrics.runnerSessionId,
            runnerSessionPath: run.metrics.runnerSessionPath,
          },
        ],
  );
}

export function retainedSessionSendOption(result: PersistedRunnerSessionBindingResult): {
  retainedSession?: { sessionId: string; sessionPath: string };
} {
  return result.binding
    ? {
        retainedSession: {
          sessionId: result.binding.runnerSessionId,
          sessionPath: result.binding.runnerSessionPath,
        },
      }
    : {};
}

/** Files for Claude/Codex and directories for Grok are both resumable state. */
export function resumableSessionProbeCommand(runnerSessionPath: string): string {
  return `test -e ${shellQuote(runnerSessionPath)}`;
}

export function buildRunnerSessionDiscoveryCommand(
  repo: string,
  runner: string,
  runtimeDir: string,
  homeRoot?: string,
): string {
  return `
python3 - <<'PY'
import json
import os
from pathlib import Path
from time import time
from urllib.parse import quote
repo = ${JSON.stringify(repo)}
runner = ${JSON.stringify(runner)}
runtime_dir = ${JSON.stringify(runtimeDir)}
home = Path(${homeRoot === undefined ? 'str(Path.home())' : JSON.stringify(homeRoot)})
paths = []

def grok_repo_key(repo_path: str) -> str:
    try:
        return os.path.realpath(repo_path)
    except Exception:
        return os.path.abspath(repo_path)

def grok_cwd_matches(summary_cwd, repo_path: str) -> bool:
    return repo_path_matches(summary_cwd, repo_path)

def repo_path_matches(session_path, repo_path: str) -> bool:
    if not session_path:
        return False
    repo_key = grok_repo_key(repo_path)
    try:
        return os.path.realpath(session_path) == repo_key
    except Exception:
        return session_path == repo_path or session_path == repo_key

if runner == 'claude':
    session_dir = home / '.claude' / 'projects' / repo.replace('/', '-')
    if session_dir.is_dir():
        paths = [os.path.realpath(p) for p in sorted(session_dir.glob('*.jsonl'), key=lambda p: p.stat().st_mtime, reverse=True)]
elif runner == 'grok':
    keys = {quote(repo, safe=''), quote(grok_repo_key(repo), safe='')}
    cutoff = time() - (7 * 24 * 60 * 60)
    seen = set()
    for key in keys:
        sessions_dir = home / '.grok' / 'sessions' / key
        if not sessions_dir.is_dir():
            continue
        for summary_path in sorted(sessions_dir.glob('*/summary.json'), key=lambda p: p.stat().st_mtime, reverse=True):
            try:
                if summary_path.stat().st_mtime < cutoff:
                    continue
                summary = json.loads(summary_path.read_text())
                if grok_cwd_matches(summary.get('info', {}).get('cwd'), repo):
                    parent = os.path.realpath(summary_path.parent)
                    if parent in seen:
                        continue
                    seen.add(parent)
                    paths.append(parent)
            except Exception:
                # Grok writes summary.json at runtime; skip partial/unreadable files during discovery.
                continue
else:
    # The normal launcher writes under the slot-isolated CODEX_HOME. When its
    # auth bootstrap is unavailable, buildCodexHomeSetup deliberately falls back
    # to the host-global ~/.codex. A stale isolated sessions directory can still
    # exist in that case, so directory existence cannot choose the active root.
    # Search both and let exact cwd/session metadata attribution decide.
    session_roots = [
        Path(repo) / runtime_dir / 'codex-home' / 'sessions',
        home / '.codex' / 'sessions',
    ]
    candidates = []
    for sessions_root in session_roots:
        if sessions_root.is_dir():
            candidates.extend(sessions_root.rglob('*.jsonl'))
    def candidate_mtime(path):
        try:
            return path.stat().st_mtime
        except Exception:
            return 0
    cutoff = time() - (7 * 24 * 60 * 60)
    seen = 0
    for path in sorted(candidates, key=candidate_mtime, reverse=True):
        if seen >= 200:
            break
        try:
            if path.stat().st_mtime < cutoff:
                continue
            with path.open() as f:
                first = json.loads(next(f))
            if first.get('type') == 'session_meta' and repo_path_matches(first.get('payload', {}).get('cwd'), repo):
                canonical = os.path.realpath(path)
                if canonical not in paths:
                    paths.append(canonical)
            seen += 1
        except Exception:
            # Codex session discovery scans CLI-owned files; skip malformed/non-session files.
            continue
print(json.dumps(paths))
PY`;
}

export async function listRunnerSessionFiles(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  runner: string,
): Promise<string[]> {
  if (!runnerPersistsSessionFiles(runner)) return [];
  const repo = vars.remoteRepo;
  const runtimeDir = await resolveProjectRuntimeDir(vars.projectName);
  const script = buildRunnerSessionDiscoveryCommand(repo, runner, runtimeDir);
  const result = await execOnSlot(vars, script);
  return JSON.parse(result.stdout || '[]') as string[];
}

async function tryHookSessionBinding(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  runner: string,
  beforePaths: readonly string[],
  options: {
    sinceMs?: number;
    observedNotBeforeMs?: number;
    paneId?: string | null;
    slotId?: string | null;
    paneStartedAtMs?: number | null;
    excludedSessionId?: string | null;
    excludedSessionPath?: string | null;
  },
): Promise<RunnerSessionBinding | null> {
  if (getRunnerDefinition(runner).observabilityScope !== 'event-driven') return null;
  if (options.paneId) {
    const paneStartedAt =
      options.paneStartedAtMs === undefined
        ? await readPaneProcessStartedAtMs(vars, options.paneId, runner)
        : options.paneStartedAtMs;
    // A named pane is the authority for this binding. If its live process
    // start cannot be established, fail closed instead of accepting a stale
    // native or hook snapshot from a prior process in the same tmux pane.
    const isNewSessionPath = (sessionPath: string) =>
      beforePaths.length > 0 && !beforePaths.includes(sessionPath);
    const isCurrentPaneProcess = (observedAt: number | null | undefined) =>
      paneStartedAt === null ||
      (observedAt !== null && observedAt !== undefined && observedAt >= paneStartedAt);
    const observedBoundary =
      options.observedNotBeforeMs ??
      (options.sinceMs === undefined
        ? undefined
        : options.sinceMs - RUNNER_SESSION_DISPATCH_SLACK_MS);
    const isCurrentDispatch = (observedAt: number | null | undefined) =>
      observedBoundary === undefined ||
      (observedAt !== null && observedAt !== undefined && observedAt >= observedBoundary);
    const isSuccessorSession = (sessionId: string, sessionPath: string) =>
      (!options.excludedSessionId || sessionId !== options.excludedSessionId) &&
      (!options.excludedSessionPath || sessionPath !== options.excludedSessionPath);
    let nativeBinding = null;
    try {
      nativeBinding = await getRunnerObservability(runner)?.getSessionBinding?.(
        vars,
        options.paneId,
        paneStartedAt ?? undefined,
      );
    } catch (error) {
      // Native attribution is optional evidence. A transient probe failure must
      // fail this source closed without tearing down an already-launched worker;
      // the pane-scoped hook source below may still provide authoritative proof.
      console.warn(
        `[runner-session] native binding probe failed for ${runner} in ${options.paneId}: ${(error as Error).message}`,
      );
    }
    if (
      nativeBinding &&
      isCurrentPaneProcess(nativeBinding.observedAt) &&
      isCurrentDispatch(nativeBinding.observedAt) &&
      (paneStartedAt !== null || isNewSessionPath(nativeBinding.sessionPath)) &&
      isSuccessorSession(nativeBinding.sessionId, nativeBinding.sessionPath)
    ) {
      const mtimeMs = await statSessionPathMtimeMs(vars, nativeBinding.sessionPath);
      if (mtimeMs !== null) {
        return {
          runnerSessionPath: nativeBinding.sessionPath,
          runnerSessionId: nativeBinding.sessionId,
          source: 'native',
        };
      }
    }
    const paneState = await readRunnerPaneObservabilityState(vars, options.paneId);
    const observedAt = paneState ? observedAtFromRecord(paneState) : null;
    const transcriptPath = paneState?.transcript_path?.trim() ?? '';
    const sessionId = paneState?.session_id?.trim() ?? '';
    const isCurrentSlot =
      !options.slotId || !paneState?.slotId || paneState.slotId === options.slotId;
    if (
      transcriptPath &&
      sessionId &&
      isCurrentPaneProcess(observedAt) &&
      isCurrentDispatch(observedAt) &&
      isCurrentSlot &&
      (paneStartedAt !== null || isNewSessionPath(transcriptPath)) &&
      isSuccessorSession(sessionId, transcriptPath)
    ) {
      const mtimeMs = await statSessionPathMtimeMs(vars, transcriptPath);
      if (mtimeMs !== null) {
        return {
          runnerSessionPath: transcriptPath,
          runnerSessionId: sessionId,
          source: 'hook',
        };
      }
    }
    // Once a caller names a pane, that pane is the authority. Falling through
    // to shared hook/filesystem streams could bind a concurrent runner process.
    return null;
  }
  const { hooksRaw } = await readRunnerObservabilityFiles(vars);
  const hookBinding = findSessionStartFromHooks(parseHookJsonl(hooksRaw), options);
  if (!hookBinding) return null;
  const mtimeMs = await statSessionPathMtimeMs(vars, hookBinding.transcriptPath);
  if (mtimeMs === null) return null;
  const runnerSessionId =
    hookBinding.sessionId ??
    (await resolveSessionIdFromPath(vars, runner, hookBinding.transcriptPath));
  if (!runnerSessionId) return null;
  return {
    runnerSessionPath: hookBinding.transcriptPath,
    runnerSessionId,
    source: 'hook',
  };
}

async function resolveSessionIdFromPath(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  runner: string,
  sessionPath: string,
): Promise<string | null> {
  const definition = getRunnerDefinition(runner);
  const observability = getRunnerObservability(runner);
  if (observability?.resolveSessionId) {
    return observability.resolveSessionId(vars, sessionPath);
  }
  return definition.supportsExactSessionDelivery ? null : runnerSessionIdForPath(sessionPath);
}

async function tryFilesystemSessionBinding(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  runner: string,
  beforePaths: string[],
  options: {
    sinceMs?: number;
    existingPath?: string | null;
  },
): Promise<RunnerSessionBinding | null> {
  const afterPaths = await listRunnerSessionFiles(vars, runner);
  const mtimeMsByPath = await loadSessionMtimesMs(vars, afterPaths);
  const chosen = chooseRunnerSessionPath({
    candidates: afterPaths,
    mtimeMsByPath,
    beforePaths,
    sinceMs: options.sinceMs,
    existingPath: options.existingPath,
  });
  if (!chosen) return null;
  const runnerSessionId = await resolveSessionIdFromPath(vars, runner, chosen);
  if (!runnerSessionId) return null;
  return {
    runnerSessionPath: chosen,
    runnerSessionId,
    source: 'filesystem',
  };
}

interface PromptBoundSessionDeps {
  listSessionFiles: typeof listRunnerSessionFiles;
  loadMtimes: typeof loadSessionMtimesMs;
  resolveSessionId: typeof resolveSessionIdFromPath;
  promptAcceptedInSession(
    vars: Awaited<ReturnType<typeof loadSlotVars>>,
    runner: string,
    target: string,
    sessionId: string,
    sessionPath: string,
    promptText: string,
    sinceMs: number,
  ): Promise<ObservabilityReading<boolean> | null>;
}

const PROMPT_BOUND_SESSION_DEPS: PromptBoundSessionDeps = {
  listSessionFiles: listRunnerSessionFiles,
  loadMtimes: loadSessionMtimesMs,
  resolveSessionId: resolveSessionIdFromPath,
  async promptAcceptedInSession(vars, runner, target, sessionId, sessionPath, promptText, sinceMs) {
    return (
      (await getRunnerObservability(runner)?.promptAcceptedInSession?.(
        vars,
        target,
        sessionId,
        sessionPath,
        promptText,
        sinceMs,
      )) ?? null
    );
  },
};

/**
 * Resolve a fresh session by exact runner-native prompt evidence when hook/pane
 * binding is unavailable (for example Codex's global-home fallback disables
 * plugin hooks). More than one exact match is ambiguous and fails closed.
 */
export async function resolvePromptBoundRunnerSession(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  runner: string,
  beforePaths: readonly string[],
  options: Pick<
    RunnerSessionCaptureOptions,
    | 'sinceMs'
    | 'paneId'
    | 'excludedSessionId'
    | 'excludedSessionPath'
    | 'promptText'
    | 'promptAcceptedSinceMs'
  >,
  deps: PromptBoundSessionDeps = PROMPT_BOUND_SESSION_DEPS,
): Promise<RunnerSessionBinding | null> {
  const promptText = options.promptText;
  const promptAcceptedSinceMs = options.promptAcceptedSinceMs;
  const observability = getRunnerObservability(runner);
  if (
    !promptText?.trim() ||
    promptAcceptedSinceMs == null ||
    !observability?.promptAcceptedInSession
  ) {
    return null;
  }

  const before = new Set(beforePaths);
  const paths = await deps.listSessionFiles(vars, runner);
  const mtimes = await deps.loadMtimes(vars, paths);
  const candidates = paths
    .filter((sessionPath) => {
      if (before.has(sessionPath) || sessionPath === options.excludedSessionPath) return false;
      const mtimeMs = mtimes.get(sessionPath);
      if (mtimeMs === undefined) return false;
      return options.sinceMs === undefined
        ? true
        : sessionPathStartedAfterDispatch(mtimeMs, options.sinceMs);
    })
    .sort((a, b) => (mtimes.get(b) ?? 0) - (mtimes.get(a) ?? 0));

  const matches: RunnerSessionBinding[] = [];
  for (const sessionPath of candidates) {
    const sessionId = await deps.resolveSessionId(vars, runner, sessionPath);
    if (!sessionId || sessionId === options.excludedSessionId) continue;
    const reading = await deps.promptAcceptedInSession(
      vars,
      runner,
      options.paneId ?? '',
      sessionId,
      sessionPath,
      promptText,
      promptAcceptedSinceMs,
    );
    if (
      reading?.value === true &&
      reading.confidence === 'high' &&
      reading.source === 'signal' &&
      reading.exactPromptMatch === true
    ) {
      matches.push({
        runnerSessionId: sessionId,
        runnerSessionPath: sessionPath,
        source: 'native',
      });
      if (matches.length > 1) return null;
    }
  }
  return matches[0] ?? null;
}

export async function resolveRunnerSessionBinding(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  runner: string,
  beforePaths: string[],
  options: {
    sinceMs?: number;
    observedNotBeforeMs?: number;
    paneId?: string | null;
    slotId?: string | null;
    existingPath?: string | null;
    paneStartedAtMs?: number | null;
    excludedSessionId?: string | null;
    excludedSessionPath?: string | null;
  } = {},
): Promise<RunnerSessionBinding | null> {
  if (!runnerPersistsSessionFiles(runner)) return null;
  const hookBinding = await tryHookSessionBinding(vars, runner, beforePaths, options);
  if (hookBinding) return hookBinding;
  // A live pane is the authoritative owner for an exact retained session.
  // Reviewers can coexist with other same-runner processes in one checkout,
  // so falling back to the newest filesystem transcript here can bind the
  // reviewer window to an unrelated session.
  if (options.paneId) return null;
  return tryFilesystemSessionBinding(vars, runner, beforePaths, options);
}

export interface ExactLiveRunnerSessionBindingOptions {
  paneId: string;
  slotId: string;
  expectedSessionId: string;
  expectedSessionPath: string;
}

export type ExactLiveRunnerSessionBindingResult =
  | {
      ok: true;
      binding: RunnerSessionBinding & { canonicalSessionPath: string };
    }
  | {
      ok: false;
      reason: string;
      binding?: RunnerSessionBinding & { canonicalSessionPath?: string };
    };

interface ExactLiveRunnerSessionBindingDeps {
  readPaneStartedAt: typeof readPaneProcessStartedAtMs;
  resolveBinding: typeof resolveRunnerSessionBinding;
  canonicalizePath: typeof canonicalizeRunnerSessionPath;
}

const EXACT_LIVE_BINDING_DEPS: ExactLiveRunnerSessionBindingDeps = {
  readPaneStartedAt: readPaneProcessStartedAtMs,
  resolveBinding: resolveRunnerSessionBinding,
  canonicalizePath: canonicalizeRunnerSessionPath,
};

/** Prove the live runner in one exact pane still owns the persisted session id and path. */
export async function verifyExactLiveRunnerSessionBinding(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  runner: string,
  options: ExactLiveRunnerSessionBindingOptions,
  deps: ExactLiveRunnerSessionBindingDeps = EXACT_LIVE_BINDING_DEPS,
): Promise<ExactLiveRunnerSessionBindingResult> {
  const paneStartedAtMs = await deps.readPaneStartedAt(vars, options.paneId, runner);
  if (paneStartedAtMs == null) {
    return { ok: false, reason: `live runner process start is unavailable for ${options.paneId}` };
  }
  const binding = await deps.resolveBinding(vars, runner, [], {
    paneId: options.paneId,
    slotId: options.slotId,
    paneStartedAtMs,
  });
  if (!binding) {
    return {
      ok: false,
      reason: `active runner session binding is unavailable for ${options.paneId}`,
    };
  }
  const [canonicalActivePath, canonicalExpectedPath] = await Promise.all([
    deps.canonicalizePath(vars, binding.runnerSessionPath),
    deps.canonicalizePath(vars, options.expectedSessionPath),
  ]);
  if (!canonicalActivePath || !canonicalExpectedPath) {
    return {
      ok: false,
      reason: `runner session path canonicalization failed for ${options.paneId}`,
      binding,
    };
  }
  const canonicalBinding = { ...binding, canonicalSessionPath: canonicalActivePath };
  if (binding.runnerSessionId !== options.expectedSessionId) {
    return {
      ok: false,
      reason: `active runner session id '${binding.runnerSessionId}' does not match persisted '${options.expectedSessionId}'`,
      binding: canonicalBinding,
    };
  }
  if (canonicalActivePath !== canonicalExpectedPath) {
    return {
      ok: false,
      reason: `active runner session path '${canonicalActivePath}' does not match persisted '${canonicalExpectedPath}'`,
      binding: canonicalBinding,
    };
  }
  return { ok: true, binding: canonicalBinding };
}

export async function canonicalizeRunnerSessionPath(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  sessionPath: string,
): Promise<string | null> {
  const command = `python3 -c ${shellQuote('import os,sys; print(os.path.realpath(sys.argv[1]))')} ${shellQuote(sessionPath)}`;
  const result = await execOnSlot(vars, command, { timeout: 10_000 });
  if (result.exitCode !== 0) return null;
  return result.stdout.trim() || null;
}

export async function resolveRunnerSessionForRun(
  run: Pick<Run, 'startedAt' | 'steps' | 'metrics'>,
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
): Promise<RunnerSessionBinding | null> {
  const runner = run.metrics.runner;
  if (!runner) return null;
  return resolveRunnerSessionBinding(vars, runner, [], {
    sinceMs: dispatchStartedAtMs(run),
    slotId: vars.slotId,
    existingPath: run.metrics.runnerSessionPath,
  });
}

export async function captureRunnerSessionMetadata(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  runner: string,
  beforePaths: string[],
  options: RunnerSessionCaptureOptions = {},
): Promise<RunnerSessionMetadata> {
  if (!runnerPersistsSessionFiles(runner)) {
    return { runnerSessionPath: null, runnerSessionId: null };
  }
  for (let i = 0; i < RUNNER_SESSION_CAPTURE_MAX_POLLS; i++) {
    await new Promise((resolve) => setTimeout(resolve, RUNNER_SESSION_CAPTURE_POLL_MS));
    // ps(1) reports elapsed time at one-second precision. Re-probe on every
    // capture attempt so a legitimate SessionStart emitted during the first
    // partial second becomes eligible when the elapsed counter advances.
    const paneStartedAtMs = options.paneId
      ? await readPaneProcessStartedAtMs(vars, options.paneId, runner)
      : undefined;
    if (options.paneId && paneStartedAtMs === null) continue;
    const binding = await resolveRunnerSessionBinding(vars, runner, beforePaths, {
      sinceMs: options.sinceMs,
      observedNotBeforeMs: options.observedNotBeforeMs,
      paneId: options.paneId,
      slotId: options.slotId ?? vars.slotId,
      paneStartedAtMs,
      excludedSessionId: options.excludedSessionId,
      excludedSessionPath: options.excludedSessionPath,
    });
    if (binding) {
      return {
        runnerSessionPath: binding.runnerSessionPath,
        runnerSessionId: binding.runnerSessionId,
      };
    }
    const promptBound = await resolvePromptBoundRunnerSession(vars, runner, beforePaths, options);
    if (promptBound) {
      return {
        runnerSessionPath: promptBound.runnerSessionPath,
        runnerSessionId: promptBound.runnerSessionId,
      };
    }
  }
  return { runnerSessionPath: null, runnerSessionId: null };
}

type CaptureRunnerSessionMetadata = typeof captureRunnerSessionMetadata;

/**
 * A runner may not create its persisted session until its first prompt is
 * accepted. Preserve an exact pre-prompt binding when one exists; otherwise
 * capture again after prompt acceptance using the same dispatch boundary and
 * pane attribution. Each attempt must supply the complete id/path pair by
 * itself — fields are never borrowed across attempts.
 */
export async function recaptureRunnerSessionMetadataIfMissing(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  runner: string,
  beforePaths: string[],
  initial: RunnerSessionMetadata,
  options: RunnerSessionCaptureOptions = {},
  capture: CaptureRunnerSessionMetadata = captureRunnerSessionMetadata,
): Promise<RunnerSessionMetadata> {
  const initialBinding = resolvePersistedRunnerSessionBinding([
    {
      label: 'pre-prompt session capture',
      runnerSessionId: initial.runnerSessionId,
      runnerSessionPath: initial.runnerSessionPath,
    },
  ]).binding;
  if (initialBinding) return initialBinding;

  const recaptured = await capture(vars, runner, beforePaths, options);
  const recapturedBinding = resolvePersistedRunnerSessionBinding([
    {
      label: 'post-prompt session capture',
      runnerSessionId: recaptured.runnerSessionId,
      runnerSessionPath: recaptured.runnerSessionPath,
    },
  ]).binding;
  return recapturedBinding ?? { runnerSessionId: null, runnerSessionPath: null };
}

/**
 * Find a runner-pattern process living anywhere in the descendant tree of
 * {@link panePid}. Returns the matching PID as a trimmed string, or `''` when
 * no descendant matches. Replaces the old `pgrep -P <panePid>` checks
 * scattered across dispatch / run-monitor / ci-monitor / slot.killAgentInSession
 * — `-P` matches only DIRECT children, so any project whose `dispatch_cmd`
 * wraps the runner (`bash -lc 'codex …'`, `nohup`, etc.) leaves the runner as
 * a *grandchild* and the old check missed it. The miss caused multiple
 * symmetric defects: monitor falsely reporting "worker done" before this PR's
 * launch hardening; `assertRunnerProcessStarted` now timing out on legitimate
 * dispatches; and `killAgentInSession` skipping the graceful `/exit` step
 * because `pgrep -P` returned nothing for wrapped runners.
 *
 * Strategy: walk descendants outward from {@link panePid}, checking each
 * child's command against the runner registry pattern. This work is bounded by
 * one pane's process tree; scanning every matching runner on a busy node made
 * lifecycle checks time out and falsely classified retained reviewers as dead.
 */
export async function findRunnerDescendantPid(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  panePid: string,
  runnerId?: string | null,
  options?: ExecOnSlotOptions,
): Promise<string> {
  if (!panePid) return '';
  const pattern = runnerProcessPatternSource(runnerId);
  if (!pattern) return '';
  const cmd = buildFindRunnerDescendantPidCommand(panePid, pattern);
  const result = await execOnSlot(vars, cmd, options);
  if (result.exitCode !== 0) return '';
  return result.stdout.trim();
}

export function buildFindRunnerDescendantPidCommand(panePid: string, pattern: string): string {
  return buildFindRunnerDescendantPidCommandWithRoot(shellQuote(panePid), pattern);
}

/**
 * Build the same descendant probe for a pane PID already held in a remote
 * shell variable. The variable name is validated before interpolation so
 * monitor-style commands can reuse the canonical process-tree walk without
 * duplicating it.
 */
export function buildFindRunnerDescendantPidFromVariableCommand(
  variableName: string,
  pattern: string,
): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variableName)) {
    throw new Error(`Invalid shell variable name: ${variableName}`);
  }
  return buildFindRunnerDescendantPidCommandWithRoot(`"$${variableName}"`, pattern);
}

function buildFindRunnerDescendantPidCommandWithRoot(quotedRoot: string, pattern: string): string {
  const cmd = [
    `root=${quotedRoot}`,
    `command=$(ps -o command= -p "$root" 2>/dev/null || true)`,
    `case "$command" in`,
    `  *'__farmslot_status'*) ;;`,
    `  *) if printf '%s\\n' "$command" | grep -Eq ${shellQuote(pattern)}; then echo "$root"; exit 0; fi ;;`,
    `esac`,
    `set -- "$root"`,
    `while [ "$#" -gt 0 ]; do`,
    `  parent=$1`,
    `  shift`,
    `  for pid in $(pgrep -P "$parent" 2>/dev/null); do`,
    `    command=$(ps -o command= -p "$pid" 2>/dev/null || true)`,
    `    case "$command" in`,
    `      *'__farmslot_status'*) continue ;;`,
    `    esac`,
    `    if printf '%s\\n' "$command" | grep -Eq ${shellQuote(pattern)}; then`,
    `      echo "$pid"`,
    `      exit 0`,
    `    fi`,
    `    set -- "$@" "$pid"`,
    `  done`,
    `done`,
    `exit 1`,
  ].join('\n');
  return cmd;
}

/**
 * Boolean convenience wrapper around {@link findRunnerDescendantPid} for
 * callers that only need "is the runner alive somewhere under this pane?"
 * (run-monitor, ci-monitor, dispatch's wait-for-exit / wait-for-start polls).
 * This is intentionally process-only: callers deciding whether a worker can
 * accept input must additionally inspect the pane prompt, because a transient
 * headless runner descendant can be alive while the interactive worker is not.
 * `killAgentInSession` and any other caller that needs the PID itself
 * (graceful-exit signaling, kill -TERM/KILL fallback) should use the
 * underlying helper directly.
 */
export async function isRunnerAliveUnderPane(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  panePid: string,
  runnerId?: string | null,
  options?: ExecOnSlotOptions,
): Promise<boolean> {
  return (await findRunnerDescendantPid(vars, panePid, runnerId, options)).length > 0;
}
