import path from 'node:path';

import { PipelineSteps, type Run } from '@farmslot/protocol';

import type { loadSlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { shellQuote } from '../core/tmux.js';

import { hookEventName, observedAtFromRecord } from './observability-files.js';
import type { HookRecord } from './observability-types.js';

/** Allow session files touched slightly before the dispatch step timestamp. */
export const RUNNER_SESSION_DISPATCH_SLACK_MS = 60_000;

export const RUNNER_SESSION_CAPTURE_POLL_MS = 500;

/** 40 × 500ms = 20s — Claude can be slow to create a new transcript after launch. */
export const RUNNER_SESSION_CAPTURE_MAX_POLLS = 40;

export function dispatchStartedAtMs(run: Pick<Run, 'startedAt' | 'steps'>): number | undefined {
  const dispatch = run.steps?.find((step) => step.name === PipelineSteps.DISPATCH);
  const iso = dispatch?.startedAt ?? run.startedAt;
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

export function sessionPathStartedAfterDispatch(mtimeMs: number, sinceMs: number): boolean {
  return mtimeMs >= sinceMs - RUNNER_SESSION_DISPATCH_SLACK_MS;
}

export function chooseRunnerSessionPath(input: {
  candidates: readonly string[];
  mtimeMsByPath: ReadonlyMap<string, number>;
  beforePaths?: readonly string[];
  sinceMs?: number;
  existingPath?: string | null;
}): string | null {
  const before = new Set(input.beforePaths ?? []);
  const eligible = input.candidates.filter((candidate) => {
    const mtimeMs = input.mtimeMsByPath.get(candidate);
    if (mtimeMs === undefined) return false;
    if (input.sinceMs !== undefined && !sessionPathStartedAfterDispatch(mtimeMs, input.sinceMs)) {
      return false;
    }
    return true;
  });

  const fresh = eligible.filter((candidate) => !before.has(candidate));
  if (input.existingPath && eligible.includes(input.existingPath)) {
    return input.existingPath;
  }
  if (fresh[0]) return fresh[0];

  return eligible[0] ?? null;
}

export async function statSessionPathMtimeMs(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  sessionPath: string,
): Promise<number | null> {
  const cmd = `stat -f '%m' ${shellQuote(sessionPath)} 2>/dev/null || stat -c '%Y' ${shellQuote(sessionPath)} 2>/dev/null`;
  const result = await execOnSlot(vars, cmd);
  if (result.exitCode !== 0) return null;
  const seconds = Number.parseInt(result.stdout.trim(), 10);
  if (!Number.isFinite(seconds)) return null;
  return seconds * 1000;
}

export async function loadSessionMtimesMs(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  sessionPaths: readonly string[],
): Promise<Map<string, number>> {
  const mtimeMsByPath = new Map<string, number>();
  await Promise.all(
    sessionPaths.map(async (sessionPath) => {
      const mtimeMs = await statSessionPathMtimeMs(vars, sessionPath);
      if (mtimeMs !== null) mtimeMsByPath.set(sessionPath, mtimeMs);
    }),
  );
  return mtimeMsByPath;
}

export function runnerSessionIdForPath(sessionPath: string): string {
  const base = path.basename(sessionPath);
  return base.endsWith('.jsonl') ? base.slice(0, -'.jsonl'.length) : base;
}

export interface SessionStartHookBinding {
  sessionId: string | null;
  transcriptPath: string;
  observedAt: number;
}

export function findSessionStartFromHooks(
  hooks: readonly HookRecord[],
  options: {
    paneId?: string | null;
    slotId?: string | null;
    sinceMs?: number;
  } = {},
): SessionStartHookBinding | null {
  if (options.paneId) {
    const paneExact = pickSessionStartBinding(
      hooks.filter((record) => record.tmuxPane === options.paneId),
      options,
    );
    if (paneExact) return paneExact;
    const unscoped = pickSessionStartBinding(
      hooks.filter((record) => !record.tmuxPane),
      options,
    );
    if (unscoped) return unscoped;
    return null;
  }
  return pickSessionStartBinding(hooks, options);
}

function pickSessionStartBinding(
  hooks: readonly HookRecord[],
  options: {
    slotId?: string | null;
    sinceMs?: number;
  },
): SessionStartHookBinding | null {
  let best: SessionStartHookBinding | null = null;
  for (const record of hooks) {
    if (hookEventName(record) !== 'SessionStart') continue;
    const observedAt = observedAtFromRecord(record);
    if (observedAt == null) continue;
    if (
      options.sinceMs !== undefined &&
      observedAt < options.sinceMs - RUNNER_SESSION_DISPATCH_SLACK_MS
    ) {
      continue;
    }
    if (options.slotId && record.slotId && record.slotId !== options.slotId) continue;
    const transcriptPath =
      typeof record.transcript_path === 'string' && record.transcript_path.trim()
        ? record.transcript_path.trim()
        : null;
    if (!transcriptPath) continue;
    const sessionId =
      typeof record.session_id === 'string' && record.session_id.trim()
        ? record.session_id.trim()
        : null;
    if (!best || observedAt >= best.observedAt) {
      best = { sessionId, transcriptPath, observedAt };
    }
  }
  return best;
}

export async function resolveRunnerSessionPath(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  runner: string,
  listCandidates: () => Promise<string[]>,
  options: {
    beforePaths?: string[];
    existingPath?: string | null;
    sinceMs?: number;
  } = {},
): Promise<string | null> {
  const candidates = await listCandidates();
  if (candidates.length === 0) return null;
  const mtimeMsByPath = await loadSessionMtimesMs(vars, candidates);
  return chooseRunnerSessionPath({
    candidates,
    mtimeMsByPath,
    beforePaths: options.beforePaths,
    sinceMs: options.sinceMs,
    existingPath: options.existingPath,
  });
}
