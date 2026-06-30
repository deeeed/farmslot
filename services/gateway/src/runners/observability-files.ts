import path from 'node:path';

import { type loadSlotVars, resolveProjectRuntimeDir } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { shellQuote } from '../core/tmux.js';

import type {
  HookRecord,
  ObservabilityReading,
  RunnerActivity,
  StatuslineRecord,
} from './observability-types.js';

export const OBSERVABILITY_SIGNAL_FRESH_MS = 120_000;

type SlotVars = Awaited<ReturnType<typeof loadSlotVars>>;

export function observedAtFromRecord(record: {
  observedAt?: number;
  observed_at?: number;
  timestamp?: number;
  mtime?: number;
}): number | null {
  const raw = record.observedAt ?? record.observed_at ?? record.timestamp ?? record.mtime;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  return raw < 10_000_000_000 ? Math.round(raw * 1000) : Math.round(raw);
}

export function isFreshObservedAt(observedAt: number | null, now = Date.now()): boolean {
  return observedAt != null && now - observedAt <= OBSERVABILITY_SIGNAL_FRESH_MS;
}

export function hookEventName(record: HookRecord): string | null {
  const name = record.hook_event_name ?? record.event;
  return typeof name === 'string' && name.length > 0 ? name : null;
}

export function parseHookJsonl(raw: string | null | undefined): HookRecord[] {
  if (!raw?.trim()) return [];
  const records: HookRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        records.push(parsed as HookRecord);
      }
    } catch {
      // tail -c can start mid-line; skip malformed fragments.
    }
  }
  return records;
}

export function parseStatuslineJson(raw: string | null | undefined): StatuslineRecord | null {
  if (!raw?.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(raw.trim());
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as StatuslineRecord)
      : null;
  } catch {
    return null;
  }
}

export function deriveRunnerActivity(
  hooks: readonly HookRecord[],
  statusline: StatuslineRecord | null,
  now = Date.now(),
): ObservabilityReading<RunnerActivity> | null {
  const statuslineObservedAt = statusline ? observedAtFromRecord(statusline) : null;
  if (
    statusline &&
    isFreshObservedAt(statuslineObservedAt, now) &&
    typeof statusline.busy === 'boolean'
  ) {
    return {
      value: statusline.busy ? 'tool-running' : 'idle',
      source: 'statusline',
      confidence: 'high',
      observedAt: statuslineObservedAt!,
    };
  }

  if (hooks.length === 0) return null;

  let lastPreToolUse: { record: HookRecord; observedAt: number } | null = null;
  let lastPostToolUseAt: number | null = null;
  let lastTurnStop: { observedAt: number } | null = null;
  let lastComposing: { observedAt: number } | null = null;

  for (const record of hooks) {
    const event = hookEventName(record);
    const observedAt = observedAtFromRecord(record);
    if (!event || observedAt == null) continue;
    if (event === 'PreToolUse') {
      lastPreToolUse = { record, observedAt };
      lastPostToolUseAt = null;
    } else if (event === 'PostToolUse' || event === 'PostToolUseFailure') {
      lastPostToolUseAt = observedAt;
    } else if (event === 'Stop' || event === 'SubagentStop') {
      lastTurnStop = { observedAt };
    } else if (event === 'UserPromptSubmit' || event === 'UserPromptExpansion') {
      lastComposing = { observedAt };
    } else if (event === 'Notification') {
      lastComposing = { observedAt };
    }
  }

  const freshest = [
    lastPreToolUse?.observedAt,
    lastPostToolUseAt,
    lastTurnStop?.observedAt,
    lastComposing?.observedAt,
  ]
    .filter((value): value is number => value != null)
    .sort((a, b) => b - a)[0];
  if (freshest == null || !isFreshObservedAt(freshest, now)) return null;

  if (
    lastPreToolUse &&
    (lastPostToolUseAt == null || lastPreToolUse.observedAt > lastPostToolUseAt)
  ) {
    return {
      value: 'tool-running',
      source: 'hook',
      confidence: 'high',
      observedAt: lastPreToolUse.observedAt,
    };
  }
  if (
    lastComposing &&
    (lastTurnStop == null || lastComposing.observedAt > lastTurnStop.observedAt)
  ) {
    return {
      value: 'composing',
      source: 'hook',
      confidence: 'high',
      observedAt: lastComposing.observedAt,
    };
  }
  if (lastTurnStop) {
    return {
      value: 'idle',
      source: 'hook',
      confidence: 'high',
      observedAt: lastTurnStop.observedAt,
    };
  }
  return null;
}

export function runnerActivityIsBusy(activity: RunnerActivity): boolean {
  return activity === 'composing' || activity === 'tool-running' || activity === 'awaiting-input';
}

export function activeToolFromHooks(
  hooks: readonly HookRecord[],
  now = Date.now(),
): ObservabilityReading<string> | null {
  let lastPreToolUse: { tool: string; observedAt: number } | null = null;
  let lastPostToolUseAt: number | null = null;
  for (const record of hooks) {
    const event = hookEventName(record);
    const observedAt = observedAtFromRecord(record);
    if (!event || observedAt == null) continue;
    if (event === 'PreToolUse' && typeof record.tool_name === 'string' && record.tool_name) {
      lastPreToolUse = { tool: record.tool_name, observedAt };
      lastPostToolUseAt = null;
    } else if (event === 'PostToolUse' || event === 'PostToolUseFailure') {
      lastPostToolUseAt = observedAt;
    }
  }
  if (
    !lastPreToolUse ||
    (lastPostToolUseAt != null && lastPostToolUseAt >= lastPreToolUse.observedAt) ||
    !isFreshObservedAt(lastPreToolUse.observedAt, now)
  ) {
    return null;
  }
  return {
    value: lastPreToolUse.tool,
    source: 'hook',
    confidence: 'high',
    observedAt: lastPreToolUse.observedAt,
  };
}

export function lastTurnCompletedFromHooks(
  hooks: readonly HookRecord[],
  now = Date.now(),
): ObservabilityReading<number> | null {
  for (let i = hooks.length - 1; i >= 0; i -= 1) {
    const record = hooks[i];
    const event = hookEventName(record);
    const observedAt = observedAtFromRecord(record);
    if (!event || observedAt == null) continue;
    if (event !== 'Stop' && event !== 'SubagentStop') continue;
    if (!isFreshObservedAt(observedAt, now)) return null;
    return {
      value: observedAt,
      source: 'hook',
      confidence: 'high',
      observedAt,
    };
  }
  return null;
}

export function contextPctFromStatusline(
  statusline: StatuslineRecord | null,
  now = Date.now(),
): ObservabilityReading<number> | null {
  if (!statusline) return null;
  const observedAt = observedAtFromRecord(statusline);
  const ctxPct = statusline.ctxPct ?? statusline.contextPct;
  if (
    typeof ctxPct !== 'number' ||
    !Number.isFinite(ctxPct) ||
    !isFreshObservedAt(observedAt, now)
  ) {
    return null;
  }
  const rounded = Math.round(ctxPct);
  if (rounded < 0 || rounded > 100) return null;
  return {
    value: rounded,
    source: 'statusline',
    confidence: 'high',
    observedAt: observedAt!,
  };
}

export function runnerObservabilityDir(repoPath: string, runtimeDir = '.agent'): string {
  return path.posix.join(repoPath, runtimeDir, '.observability');
}

export async function runnerObservabilityDirForSlot(vars: SlotVars): Promise<string> {
  const runtimeDir = await resolveProjectRuntimeDir(vars.projectName);
  return runnerObservabilityDir(vars.remoteRepo, runtimeDir);
}

export async function readRunnerObservabilityFiles(
  vars: SlotVars,
  repoPath = vars.remoteRepo,
): Promise<{ hooksRaw: string; statuslineRaw: string }> {
  const obsDir = shellQuote(await runnerObservabilityDirForSlot({ ...vars, remoteRepo: repoPath }));
  const hooksPath = `${obsDir}/hooks.jsonl`;
  const statuslinePath = `${obsDir}/statusline.json`;
  const [hooksResult, statuslineResult] = await Promise.all([
    execOnSlot(vars, `tail -c 65536 ${hooksPath} 2>/dev/null || true`),
    execOnSlot(vars, `cat ${statuslinePath} 2>/dev/null || true`),
  ]);
  return {
    hooksRaw: hooksResult.stdout,
    statuslineRaw: statuslineResult.stdout,
  };
}

export function filterHooksByPane(
  hooks: readonly HookRecord[],
  paneId?: string | null,
): HookRecord[] {
  if (!paneId) return [...hooks];
  return hooks.filter((record) => !record.tmuxPane || record.tmuxPane === paneId);
}

export function promptTurnStartedFromHooks(
  hooks: readonly HookRecord[],
  sinceMs: number,
  paneId?: string | null,
  now = Date.now(),
  graceMs = 500,
): ObservabilityReading<boolean> | null {
  const scoped = filterHooksByPane(hooks, paneId);
  let latestToolUseAt: number | null = null;
  let latestPromptSubmitAt: number | null = null;
  for (const record of scoped) {
    const event = hookEventName(record);
    const observedAt = observedAtFromRecord(record);
    if (observedAt == null || observedAt < sinceMs) continue;
    if (event === 'PreToolUse') {
      if (latestToolUseAt == null || observedAt > latestToolUseAt) latestToolUseAt = observedAt;
    }
    if (event === 'UserPromptSubmit') {
      if (latestPromptSubmitAt == null || observedAt > latestPromptSubmitAt) {
        latestPromptSubmitAt = observedAt;
      }
    }
  }
  if (latestToolUseAt != null) {
    return {
      value: true,
      source: 'hook',
      confidence: 'high',
      observedAt: latestToolUseAt,
    };
  }
  if (latestPromptSubmitAt != null) {
    return {
      value: true,
      source: 'hook',
      confidence: 'medium',
      observedAt: latestPromptSubmitAt,
    };
  }
  if (now - sinceMs < graceMs) return null;
  return {
    value: false,
    source: 'hook',
    confidence: 'medium',
    observedAt: now,
  };
}

export function promptAcceptedFromHooks(
  hooks: readonly HookRecord[],
  promptDigest: string,
  sinceMs: number,
  graceMs = 500,
  now = Date.now(),
  paneId?: string | null,
): ObservabilityReading<boolean> | null {
  const scoped = filterHooksByPane(hooks, paneId);
  let latest: { observedAt: number; digest?: string } | null = null;
  for (const record of scoped) {
    const event = hookEventName(record);
    if (event !== 'UserPromptSubmit') continue;
    const observedAt = observedAtFromRecord(record);
    if (observedAt == null || observedAt < sinceMs) continue;
    if (!latest || observedAt > latest.observedAt) {
      latest = { observedAt, digest: record.runnerPromptDigest };
    }
  }
  if (!latest) {
    const turnStarted = promptTurnStartedFromHooks(scoped, sinceMs, paneId, now, graceMs);
    if (turnStarted?.value === true) return turnStarted;
    if (now - sinceMs < graceMs) return null;
    return {
      value: false,
      source: 'hook',
      confidence: 'medium',
      observedAt: now,
    };
  }
  const matched =
    typeof latest.digest === 'string' &&
    (latest.digest === promptDigest || latest.digest.startsWith(promptDigest));
  if (matched) {
    return {
      value: true,
      source: 'hook',
      confidence: 'high',
      observedAt: latest.observedAt,
    };
  }
  const turnStarted = promptTurnStartedFromHooks(scoped, sinceMs, paneId, now, graceMs);
  if (turnStarted?.value === true) {
    return {
      value: true,
      source: 'hook',
      confidence: 'medium',
      observedAt: turnStarted.observedAt,
    };
  }
  return {
    value: false,
    source: 'hook',
    confidence: latest.digest ? 'high' : 'medium',
    observedAt: latest.observedAt,
  };
}
