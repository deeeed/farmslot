import {
  type AgentContext,
  agentRoleForWindowName,
  isReviewerWindowName,
  type Run,
} from '@farmslot/protocol';

import { type loadSlotVars, resolveProjectRuntimeDir } from '../core/config.js';
import { execOnSlot, type ExecOnSlotOptions } from '../core/exec.js';
import { shellQuote, tmuxShellSnippet } from '../core/tmux.js';

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
  runnerIdsRequiringExplicitTerminationIdentity,
  runnerIdsSafeForUnattributedTermination,
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
  options?: ExecOnSlotOptions,
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
  // This probe starts a python3 interpreter and reads the whole process table.
  // It ran unbounded until now, so a wedged interpreter on a loaded node could
  // stall every caller indefinitely.
  const result = await execOnSlot(vars, script, {
    timeout: RUNNER_PROCESS_PROBE_TIMEOUT_MS,
    ...options,
  });
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
  /**
   * Live runner PID under this pane, when the caller already proved one. Lets a
   * resumed session be recognized from the process itself; without it only
   * fresh-launch attribution applies.
   */
  runnerPid?: string;
}

export type ExactLiveRunnerSessionBindingResult =
  | {
      ok: true;
      binding: RunnerSessionBinding & { canonicalSessionPath: string };
    }
  | {
      ok: false;
      /** The check could not decide; callers must report unknown, not dead. */
      indeterminate?: true;
      reason: string;
      binding?: RunnerSessionBinding & { canonicalSessionPath?: string };
    };

interface ExactLiveRunnerSessionBindingDeps {
  readPaneStartedAt: typeof readPaneProcessStartedAtMs;
  resolveBinding: typeof resolveRunnerSessionBinding;
  canonicalizePath: typeof canonicalizeRunnerSessionPath;
  verifyResumed: typeof verifyResumedRunnerSessionBinding;
  resolveSessionIdForPath: typeof resolveRunnerSessionIdForPath;
}

/** The session id a persisted session file carries, per the runner's own reader. */
export async function resolveRunnerSessionIdForPath(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  runner: string,
  sessionPath: string,
): Promise<string | null> {
  const provider = getRunnerObservability(runner);
  if (!provider?.resolveSessionId) return null;
  return provider.resolveSessionId(vars, sessionPath);
}

/** Runner-owned check that a live process is resuming one exact session. */
export async function verifyResumedRunnerSessionBinding(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  runner: string,
  runnerPid: string,
  expectedSessionId: string,
  expectedSessionPath: string,
): Promise<{ ok: boolean; indeterminate?: true; reason?: string }> {
  const provider = getRunnerObservability(runner);
  if (!provider?.verifyResumedSessionBinding) {
    return { ok: false, reason: `runner '${runner}' cannot prove a resumed session binding` };
  }
  return provider.verifyResumedSessionBinding(
    vars,
    runnerPid,
    expectedSessionId,
    expectedSessionPath,
  );
}

const EXACT_LIVE_BINDING_DEPS: ExactLiveRunnerSessionBindingDeps = {
  readPaneStartedAt: readPaneProcessStartedAtMs,
  resolveBinding: resolveRunnerSessionBinding,
  verifyResumed: verifyResumedRunnerSessionBinding,
  canonicalizePath: canonicalizeRunnerSessionPath,
  resolveSessionIdForPath: resolveRunnerSessionIdForPath,
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
    // Fresh-launch attribution requires session activity NEWER than the pane
    // process. A resumed session can never satisfy that: its transcript was
    // written by the process that has since exited, so it is always older than
    // the pane that reopened it. Ask the runner whether the live process is
    // resuming exactly this session instead — a targeted check that needs an
    // expected id, so it cannot loosen open-ended discovery.
    if (options.runnerPid) {
      // Canonicalize FIRST: the open-handle check compares against the real
      // path, and the embedded-id check reads that same file.
      const canonicalExpectedPath = await deps.canonicalizePath(vars, options.expectedSessionPath);
      if (!canonicalExpectedPath) {
        return {
          ok: false,
          indeterminate: true,
          reason: `runner session path canonicalization failed for ${options.paneId}`,
        };
      }
      const embeddedId = await deps.resolveSessionIdForPath(vars, runner, canonicalExpectedPath);
      if (embeddedId !== options.expectedSessionId) {
        return {
          ok: false,
          reason: `persisted session file '${canonicalExpectedPath}' carries session id '${embeddedId ?? 'unknown'}', not '${options.expectedSessionId}'`,
        };
      }
      const resumed = await deps.verifyResumed?.(
        vars,
        runner,
        options.runnerPid,
        options.expectedSessionId,
        canonicalExpectedPath,
      );
      if (resumed?.ok) {
        return {
          ok: true,
          binding: {
            runnerSessionId: options.expectedSessionId,
            runnerSessionPath: options.expectedSessionPath,
            source: 'native',
            canonicalSessionPath: canonicalExpectedPath,
          },
        };
      }
      return {
        ok: false,
        ...(resumed?.indeterminate ? { indeterminate: true as const } : {}),
        reason:
          resumed?.reason ?? `active runner session binding is unavailable for ${options.paneId}`,
      };
    }
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
  options?: RunnerDescendantPidProbeOptions,
): Promise<string> {
  const probe = await probeRunnerDescendantPid(vars, panePid, runnerId, options);
  if (probe.state === 'present') return probe.pid;
  if (probe.state === 'absent') return '';
  throw new RunnerProcessProbeError(probe.code, panePid, probe.reason);
}

/**
 * Why liveness could not be decided. Callers that persist an outcome — the
 * machine-park record above all — record this instead of re-deriving intent
 * from a free-text `command timed out after 10000ms`.
 */
export type RunnerProcessProbeFailureCode =
  | 'pane-pid-missing'
  | 'runner-pattern-missing'
  /** A process matched, but only a recorded runner identity may act on it. */
  | 'runner-identity-ambiguous'
  | 'probe-timeout'
  | 'probe-transport';

/** Typed liveness-probe failure, so a timeout stays a timeout up the stack. */
export class RunnerProcessProbeError extends Error {
  readonly name = 'RunnerProcessProbeError';

  constructor(
    readonly code: RunnerProcessProbeFailureCode,
    readonly panePid: string,
    readonly reason?: string,
  ) {
    super(
      `Cannot determine runner liveness under pane PID ${panePid || '(missing)'} (${code})${
        reason ? `: ${reason}` : ''
      }`,
    );
  }
}

export type RunnerDescendantPidProbe =
  | { state: 'present'; pid: string }
  | { state: 'absent' }
  | {
      state: 'unknown';
      code: RunnerProcessProbeFailureCode;
      reason?: string;
      /** How many exec attempts were spent before giving up. */
      attempts?: number;
    };

export interface RunnerDescendantPidProbeOptions extends ExecOnSlotOptions {
  /**
   * Bounded retries for a timed-out or transport-failed attempt. Each retry
   * doubles the exec budget, so a host too loaded to answer inside the first
   * window gets a proportionally larger one instead of a false verdict.
   * Defaults to 1 — callers that must not stall keep today's single attempt.
   */
  attempts?: number;
  /**
   * Absolute epoch-ms ceiling on the WHOLE probe, retries included. Without it
   * `attempts` multiplies the caller's budget: three attempts of a 10s base
   * spend 70s, so a caller holding a 120s wall-clock ceiling could admit a
   * probe at 119s and return near 190s. Each attempt is clamped to what remains
   * of this, and the retries stop once nothing remains.
   */
  deadline?: number;
}

/**
 * Exec seam, mirroring {@link TerminateRunnerDescendantsDeps}. Production always
 * takes the default; the regression guards use it to drive the exit statuses a
 * loaded host produces without shelling out to a doctored `ps`.
 */
export interface RunnerDescendantPidProbeDeps {
  exec?: typeof execOnSlot;
}

/** Exec budget for one liveness probe when a caller states none. */
export const RUNNER_PROCESS_PROBE_TIMEOUT_MS = 10_000;
/** Upper bound on a single escalated attempt, so backoff cannot run away. */
export const RUNNER_PROCESS_PROBE_MAX_TIMEOUT_MS = 60_000;
/**
 * Exit status the probe reserves for "the `ps` snapshot itself did not happen".
 * It must not collide with the walk's own verdicts — 0 found, 1 confirmed
 * absent — because a snapshot that never ran proves nothing about the tree.
 */
export const RUNNER_PROCESS_PROBE_SNAPSHOT_EXIT = 3;

/**
 * Preserve transport/probe failure separately from a confirmed empty process tree.
 * Destructive callers must hold on `unknown`; boolean liveness callers may keep
 * using {@link isRunnerAliveUnderPane} when absence and uncertainty are equivalent.
 */
export async function probeRunnerDescendantPid(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  panePid: string,
  runnerId?: string | null,
  options?: RunnerDescendantPidProbeOptions,
  deps: RunnerDescendantPidProbeDeps = {},
): Promise<RunnerDescendantPidProbe> {
  const exec = deps.exec ?? execOnSlot;
  if (!panePid) {
    return { state: 'unknown', code: 'pane-pid-missing', reason: 'pane PID is missing' };
  }
  const pattern = runnerProcessPatternSource(runnerId);
  if (!pattern) {
    return {
      state: 'unknown',
      code: 'runner-pattern-missing',
      reason: 'runner process pattern is missing',
    };
  }
  const cmd = buildFindRunnerDescendantPidCommand(panePid, pattern);
  const attempts = Math.max(1, options?.attempts ?? 1);
  const baseTimeout = options?.timeout ?? RUNNER_PROCESS_PROBE_TIMEOUT_MS;
  const deadline = options?.deadline;
  let failure: Extract<RunnerDescendantPidProbe, { state: 'unknown' }> = {
    state: 'unknown',
    code: 'probe-transport',
    reason: 'probe was never attempted',
  };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const escalated = Math.min(
      baseTimeout * 2 ** (attempt - 1),
      RUNNER_PROCESS_PROBE_MAX_TIMEOUT_MS,
    );
    // The caller's ceiling wins over the escalation. An attempt that cannot fit
    // is not started, because starting it is exactly how the ceiling gets
    // overrun.
    const remaining = deadline === undefined ? escalated : deadline - Date.now();
    if (remaining <= 0) {
      failure = {
        state: 'unknown',
        code: 'probe-timeout',
        reason: `liveness probe budget exhausted before attempt ${attempt}`,
        attempts: attempt - 1,
      };
      return failure;
    }
    const timeout = Math.min(escalated, remaining);
    try {
      const result = await exec(vars, cmd, { ...options, timeout });
      const pid = result.stdout.trim();
      if (result.exitCode === 0 && /^\d+$/.test(pid)) return { state: 'present', pid };
      if (result.exitCode === 1 && !pid && !result.stderr.trim()) return { state: 'absent' };
      // 124 is the exec layer's own timeout verdict and
      // RUNNER_PROCESS_PROBE_SNAPSHOT_EXIT is a `ps` that could not fork or
      // returned nothing. Both are what an overloaded host does, so both earn
      // another attempt with a larger budget. Any other status is a real probe
      // failure that another attempt would only repeat.
      const timedOut = result.exitCode === 124;
      const snapshotFailed = result.exitCode === RUNNER_PROCESS_PROBE_SNAPSHOT_EXIT;
      failure = {
        state: 'unknown',
        code: timedOut ? 'probe-timeout' : 'probe-transport',
        reason: result.stderr.trim() || result.stdout.trim() || `probe exited ${result.exitCode}`,
        attempts: attempt,
      };
      if (!timedOut && !snapshotFailed) return failure;
    } catch (error) {
      failure = {
        state: 'unknown',
        code: 'probe-transport',
        reason: (error as Error).message,
        attempts: attempt,
      };
    }
  }
  return failure;
}

interface TerminateRunnerDescendantsDeps {
  exec?: typeof execOnSlot;
  probe?: typeof probeRunnerDescendantPid;
  sleep?: (ms: number) => Promise<void>;
  additionalRunnerIds?: string[];
}

const WARM_REPLACEMENT_COMMAND_TIMEOUT_MS = 10_000;

/**
 * Stop every known runner process in a slot tmux session without typing into
 * its composer. Fresh replacement uses this for unowned warm sessions, whose
 * persisted slot metadata may no longer name the runner or role window.
 */
export async function terminateRunnerDescendantsInTmuxSession(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  session: string,
  deps: TerminateRunnerDescendantsDeps = {},
): Promise<number> {
  const exec = deps.exec ?? execOnSlot;
  const probeRunner = deps.probe ?? probeRunnerDescendantPid;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const explicitRunnerIds = new Set((deps.additionalRunnerIds ?? []).filter(Boolean));
  const probeRunnerIds = [
    ...new Set([...explicitRunnerIds, ...runnerIdsSafeForUnattributedTermination()]),
  ];
  const ambiguousRunnerIds = runnerIdsRequiringExplicitTerminationIdentity().filter(
    (runnerId) => !explicitRunnerIds.has(runnerId),
  );
  const probeAnyRunner = async (panePid: string): Promise<RunnerDescendantPidProbe> => {
    for (const runnerId of probeRunnerIds) {
      const result = await probeRunner(vars, panePid, runnerId, {
        timeout: WARM_REPLACEMENT_COMMAND_TIMEOUT_MS,
      });
      if (result.state !== 'absent') return result;
    }
    for (const runnerId of ambiguousRunnerIds) {
      const result = await probeRunner(vars, panePid, runnerId, {
        timeout: WARM_REPLACEMENT_COMMAND_TIMEOUT_MS,
      });
      if (result.state === 'present') {
        return {
          state: 'unknown',
          code: 'runner-identity-ambiguous',
          reason: `${runnerId} process requires matching recorded runner identity`,
        };
      }
      if (result.state === 'unknown') return result;
    }
    return { state: 'absent' };
  };
  const listed = await exec(
    vars,
    tmuxShellSnippet(`list-panes -s -t ${shellQuote(session)} -F '#{pane_pid}' 2>/dev/null`),
    { timeout: WARM_REPLACEMENT_COMMAND_TIMEOUT_MS },
  );
  if (listed.exitCode !== 0) {
    const sessionProbe = await exec(
      vars,
      tmuxShellSnippet(`has-session -t ${shellQuote(`=${session}`)} 2>/dev/null`),
      { timeout: WARM_REPLACEMENT_COMMAND_TIMEOUT_MS },
    );
    if (sessionProbe.exitCode === 1) return 0;
    throw new Error(
      `Cannot replace warm session ${session}: tmux pane inspection failed${listed.stderr || listed.stdout ? ` (${(listed.stderr || listed.stdout).trim()})` : ` (exit ${listed.exitCode})`}`,
    );
  }

  const panePids = [
    ...new Set(
      listed.stdout
        .split('\n')
        .map((pid) => pid.trim())
        .filter(Boolean),
    ),
  ];
  const stoppedPids = new Set<string>();
  for (const panePid of panePids) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const probe = await probeAnyRunner(panePid);
      if (probe.state !== 'present') {
        if (probe.state === 'absent') break;
        throw new Error(
          `Cannot replace warm session ${session}: runner liveness under pane ${panePid} is unknown${probe.reason ? ` (${probe.reason})` : ''}`,
        );
      }
      await exec(vars, `kill -TERM ${shellQuote(probe.pid)} 2>/dev/null || true`, {
        timeout: WARM_REPLACEMENT_COMMAND_TIMEOUT_MS,
      });
      // Fresh replacement is destructive, but give the runner enough time to
      // flush its own session state before escalating to SIGKILL.
      await sleep(2_000);
      const beforeEscalation = await probeAnyRunner(panePid);
      if (beforeEscalation.state === 'unknown') {
        throw new Error(
          `Cannot replace warm session ${session}: runner liveness under pane ${panePid} is unknown${beforeEscalation.reason ? ` (${beforeEscalation.reason})` : ''}`,
        );
      }
      if (beforeEscalation.state === 'present' && beforeEscalation.pid === probe.pid) {
        await exec(vars, `kill -KILL ${shellQuote(probe.pid)} 2>/dev/null || true`, {
          timeout: WARM_REPLACEMENT_COMMAND_TIMEOUT_MS,
        });
      }
      stoppedPids.add(probe.pid);
      await sleep(50);
    }
    const remaining = await probeAnyRunner(panePid);
    if (remaining.state !== 'absent') {
      throw new Error(
        `Cannot replace warm session ${session}: runner process remains under pane ${panePid}`,
      );
    }
  }
  return stoppedPids.size;
}

interface ResolveRetainedRunnerPaneDeps {
  exec?: typeof execOnSlot;
  probe?: typeof probeRunnerDescendantPid;
}

export interface RetainedRunnerPane {
  target: string;
  window: string;
  pane: string;
  seenWindows: string[];
}

/** Resolve an existing runner pane. Nudge callers must never create a shell window. */
export async function resolveRetainedRunnerPane(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  session: string,
  runner: string,
  preferredTarget?: string | null,
  deps: ResolveRetainedRunnerPaneDeps = {},
): Promise<RetainedRunnerPane | null> {
  const exec = deps.exec ?? execOnSlot;
  const probeRunner = deps.probe ?? probeRunnerDescendantPid;
  const listed = await exec(
    vars,
    tmuxShellSnippet(
      `list-panes -s -t ${shellQuote(session)} -F '#{window_index}|#{window_name}|#{pane_index}|#{pane_pid}|#{window_activity}' 2>/dev/null`,
    ),
    { timeout: 10_000 },
  );
  if (listed.exitCode !== 0) {
    const sessionProbe = await exec(
      vars,
      tmuxShellSnippet(`has-session -t ${shellQuote(`=${session}`)} 2>/dev/null`),
      { timeout: 10_000 },
    );
    if (sessionProbe.exitCode === 1) return null;
    throw new Error(
      `Cannot inspect retained runner session ${session}: ${listed.stderr || listed.stdout || `exit ${listed.exitCode}`}`,
    );
  }
  const panes = listed.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [windowIndex, windowName, paneIndex, panePid, activityRaw] = line.split('|');
      return {
        windowIndex: windowIndex || '',
        windowName: windowName || '',
        paneIndex: paneIndex || '',
        panePid: panePid || '',
        activity: Number(activityRaw) || 0,
        window: windowName || windowIndex || '',
        target: `${session}:${windowIndex}.${paneIndex}`,
      };
    })
    .filter((pane) => pane.window && pane.paneIndex && pane.panePid);
  const seenWindows = panes.map(
    (pane) => `${pane.windowIndex}:${pane.windowName || '(unnamed)'} pane ${pane.paneIndex}`,
  );
  const preferredRef = preferredTarget?.includes(':')
    ? preferredTarget.slice(preferredTarget.indexOf(':') + 1).split('.', 1)[0]
    : null;
  const ordered = [...panes].sort((a, b) => {
    const aPreferred = preferredRef === a.window || preferredRef === a.windowIndex;
    const bPreferred = preferredRef === b.window || preferredRef === b.windowIndex;
    if (aPreferred !== bPreferred) return aPreferred ? -1 : 1;
    return b.activity - a.activity;
  });
  for (const pane of ordered) {
    if (
      isReviewerWindowName(pane.windowName) ||
      agentRoleForWindowName(pane.windowName) === 'ci-fix'
    ) {
      continue;
    }
    const runnerProbe = await probeRunner(vars, pane.panePid, runner, { timeout: 10_000 });
    if (runnerProbe.state === 'unknown') {
      throw new Error(
        `Cannot inspect retained runner in ${session}:${pane.windowIndex}.${pane.paneIndex}${runnerProbe.reason ? ` (${runnerProbe.reason})` : ''}`,
      );
    }
    if (runnerProbe.state === 'absent') continue;
    return {
      target: pane.target,
      window: pane.window,
      pane: pane.paneIndex,
      seenWindows,
    };
  }
  return null;
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

/**
 * One `ps` snapshot, one `awk` walk. The previous shape forked `pgrep -P` plus
 * `ps -p` for every node it visited, and each of those re-reads the whole
 * process table — so a pane tree of N processes cost 2N+1 full table passes.
 * On a node at load 34-72 that blew the stop path's budget, the park settled
 * `partial`, and a runner that had already exited was reported still running.
 *
 * The walk itself is unchanged and stays scoped to {@link quotedRoot}'s
 * descendants: breadth-first from the root, `exact_match` is the FIRST process
 * whose argv0 matches the runner pattern (the runner executable), and
 * `fallback_match` the LAST whose full command line matches (a launcher or
 * wrapper). Children are visited in the order `ps` reports them, which is pid
 * order on both macOS and Linux.
 *
 * The snapshot is taken before the walk and checked, because the whole tree now
 * rests on that one `ps`. A `ps` that could not fork, was killed, or returned
 * nothing leaves the walk with no rows, and "no rows" is indistinguishable from
 * "the runner is gone" once the walk has started — which is exactly the false
 * `stopped` a park must never act on. A failed or empty snapshot therefore
 * exits {@link RUNNER_PROCESS_PROBE_SNAPSHOT_EXIT} with a reason on stderr, so
 * the caller classifies it as an undecided probe rather than a confirmed
 * absence.
 *
 * The pattern reaches awk through the environment, not `-v`: `awk -v` runs the
 * value through escape processing, so `-v pattern='foo\.bar'` would hand awk
 * `foo.bar` and silently widen the match. `ENVIRON` is passed through verbatim.
 *
 * Every row must carry a numeric pid, a numeric ppid, a state and a command. A
 * single malformed row condemns the whole snapshot rather than being skipped:
 * a table we only partly understood cannot support a CONFIRMED absence, and
 * absence is what frees a slot. `123 garbage` therefore exits
 * {@link RUNNER_PROCESS_PROBE_SNAPSHOT_EXIT}, not 1.
 *
 * The walk carries a visited set, so an inconsistent snapshot whose ppid edges
 * form a cycle — possible when a pid is recycled between rows — terminates
 * instead of queueing forever until the exec timeout kills it. A zombie is
 * never matched as a live runner: it has already exited and only its exit
 * status remains, but its children are still traversed.
 */
function buildFindRunnerDescendantPidCommandWithRoot(quotedRoot: string, pattern: string): string {
  const walk = [
    'BEGIN { pattern = ENVIRON["FARMSLOT_RUNNER_PATTERN"] }',
    '{',
    '  if (NF < 4 || $1 !~ /^[0-9]+$/ || $2 !~ /^[0-9]+$/ || $3 == "") {',
    '    malformed++',
    '    next',
    '  }',
    '  rows++',
    '  line = $0',
    '  sub(/^[ \\t]+/, "", line)',
    '  sub(/^[^ \\t]+[ \\t]+/, "", line)',
    '  sub(/^[^ \\t]+[ \\t]+/, "", line)',
    '  sub(/^[^ \\t]+[ \\t]+/, "", line)',
    '  cmd[$1] = line',
    '  state[$1] = $3',
    '  kids[$2] = kids[$2] " " $1',
    '}',
    'END {',
    '  if (rows == 0 || malformed > 0) {',
    '    printf "runner liveness probe: process table snapshot unusable (%d row(s), %d malformed)\\n", rows + 0, malformed + 0 > "/dev/stderr"',
    `    exit ${RUNNER_PROCESS_PROBE_SNAPSHOT_EXIT}`,
    '  }',
    '  queue[0] = root',
    '  head = 0',
    '  tail = 1',
    '  while (head < tail) {',
    '    pid = queue[head++]',
    '    if (pid in visited) continue',
    '    visited[pid] = 1',
    '    command = cmd[pid]',
    '    if (command != "" && state[pid] !~ /^Z/ && index(command, "__farmslot_status") == 0 && command ~ pattern) {',
    '      fallback = pid',
    '      split(command, argv, /[ \\t]/)',
    '      if (exact == "" && argv[1] ~ pattern) exact = pid',
    '    }',
    '    n = split(kids[pid], child, " ")',
    '    for (i = 1; i <= n; i++) if (child[i] != "") queue[tail++] = child[i]',
    '  }',
    '  if (exact != "") { print exact; exit 0 }',
    '  if (fallback != "") { print fallback; exit 0 }',
    '  exit 1',
    '}',
  ].join('\n');
  const snapshotFailed = (reason: string) =>
    `{ printf '%s\\n' ${shellQuote(`runner liveness probe: ${reason}`)} >&2; exit ${RUNNER_PROCESS_PROBE_SNAPSHOT_EXIT}; }`;
  return [
    `root=${quotedRoot}`,
    `FARMSLOT_RUNNER_PATTERN=${shellQuote(pattern)}`,
    'export FARMSLOT_RUNNER_PATTERN',
    `snapshot=$(ps -axo pid=,ppid=,state=,command= 2>/dev/null) || ${snapshotFailed('ps snapshot exited nonzero')}`,
    `[ -n "$snapshot" ] || ${snapshotFailed('ps snapshot was empty')}`,
    `printf '%s\\n' "$snapshot" | awk -v root="$root" ${shellQuote(walk)}`,
  ].join('\n');
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
  return (await probeRunnerDescendantPid(vars, panePid, runnerId, options)).state === 'present';
}
