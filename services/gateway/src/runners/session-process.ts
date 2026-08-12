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
  statSessionPathMtimeMs,
} from './session-path-resolution.js';

export type RunnerSessionBindingSource = 'hook' | 'filesystem';

export interface RunnerSessionBinding {
  runnerSessionPath: string;
  runnerSessionId: string;
  source: RunnerSessionBindingSource;
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

export async function listRunnerSessionFiles(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  runner: string,
): Promise<string[]> {
  if (!runnerPersistsSessionFiles(runner)) return [];
  const repo = vars.remoteRepo;
  // Codex runs with CODEX_HOME=<repo>/<runtimeDir>/codex-home (see buildCodexHomeSetup), so its
  // rollouts live there. Resolve the SAME runtime dir the launcher uses — no globbing/guessing.
  const runtimeDir = await resolveProjectRuntimeDir(vars.projectName);
  const script = `
python3 - <<'PY'
import json
import os
from pathlib import Path
from time import time
from urllib.parse import quote
repo = ${JSON.stringify(repo)}
runner = ${JSON.stringify(runner)}
runtime_dir = ${JSON.stringify(runtimeDir)}
home = Path.home()
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
    # The worker's CODEX_HOME is the exact <repo>/<runtimeDir>/codex-home the launcher set, so
    # its rollouts live there — not ~/.codex/sessions. Use that exact path; only fall back to the
    # global home if the per-slot home is absent (e.g. observability install was skipped).
    sessions_root = Path(repo) / runtime_dir / 'codex-home' / 'sessions'
    if not sessions_root.is_dir():
        sessions_root = home / '.codex' / 'sessions'
    if sessions_root.is_dir():
        cutoff = time() - (7 * 24 * 60 * 60)
        seen = 0
        for path in sorted(sessions_root.rglob('*.jsonl'), key=lambda p: p.stat().st_mtime, reverse=True):
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
  const result = await execOnSlot(vars, script);
  return JSON.parse(result.stdout || '[]') as string[];
}

async function tryHookSessionBinding(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  runner: string,
  options: {
    sinceMs?: number;
    paneId?: string | null;
    slotId?: string | null;
  },
): Promise<RunnerSessionBinding | null> {
  if (getRunnerDefinition(runner).observabilityScope !== 'event-driven') return null;
  if (options.paneId) {
    const paneState = await readRunnerPaneObservabilityState(vars, options.paneId);
    const observedAt = paneState ? observedAtFromRecord(paneState) : null;
    const transcriptPath = paneState?.transcript_path?.trim() ?? '';
    const sessionId = paneState?.session_id?.trim() ?? '';
    const isCurrentDispatch =
      options.sinceMs === undefined ||
      (observedAt !== null && observedAt >= options.sinceMs - RUNNER_SESSION_DISPATCH_SLACK_MS);
    const isCurrentSlot =
      !options.slotId || !paneState?.slotId || paneState.slotId === options.slotId;
    if (transcriptPath && sessionId && isCurrentDispatch && isCurrentSlot) {
      const mtimeMs = await statSessionPathMtimeMs(vars, transcriptPath);
      if (mtimeMs !== null) {
        return {
          runnerSessionPath: transcriptPath,
          runnerSessionId: sessionId,
          source: 'hook',
        };
      }
    }
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

export async function resolveRunnerSessionBinding(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  runner: string,
  beforePaths: string[],
  options: {
    sinceMs?: number;
    paneId?: string | null;
    slotId?: string | null;
    existingPath?: string | null;
  } = {},
): Promise<RunnerSessionBinding | null> {
  if (!runnerPersistsSessionFiles(runner)) return null;
  const hookBinding = await tryHookSessionBinding(vars, runner, options);
  if (hookBinding) return hookBinding;
  return tryFilesystemSessionBinding(vars, runner, beforePaths, options);
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
  options: {
    sinceMs?: number;
    paneId?: string | null;
    slotId?: string | null;
  } = {},
): Promise<{ runnerSessionPath: string | null; runnerSessionId: string | null }> {
  if (!runnerPersistsSessionFiles(runner)) {
    return { runnerSessionPath: null, runnerSessionId: null };
  }
  for (let i = 0; i < RUNNER_SESSION_CAPTURE_MAX_POLLS; i++) {
    await new Promise((resolve) => setTimeout(resolve, RUNNER_SESSION_CAPTURE_POLL_MS));
    const binding = await resolveRunnerSessionBinding(vars, runner, beforePaths, {
      sinceMs: options.sinceMs,
      paneId: options.paneId,
      slotId: options.slotId ?? vars.slotId,
    });
    if (binding) {
      return {
        runnerSessionPath: binding.runnerSessionPath,
        runnerSessionId: binding.runnerSessionId,
      };
    }
  }
  return { runnerSessionPath: null, runnerSessionId: null };
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
