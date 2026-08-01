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
export const OBSERVABILITY_TERMINAL_IDLE_MAX_AGE_MS = 30 * 60_000;

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

export function filterStatuslineByPane(
  statusline: StatuslineRecord | null,
  paneId?: string | null,
): StatuslineRecord | null {
  if (!statusline || !paneId || !statusline.tmuxPane) return statusline;
  return statusline.tmuxPane === paneId ? statusline : null;
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
  let lastIdleNotification: { observedAt: number } | null = null;
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
    } else if (event === 'Stop') {
      lastTurnStop = { observedAt };
    } else if (event === 'UserPromptSubmit' || event === 'UserPromptExpansion') {
      lastComposing = { observedAt };
    } else if (event === 'Notification') {
      const notificationMessage =
        typeof record.notification_message === 'string' ? record.notification_message : '';
      const notificationIndicatesIdle = /\b(?:idle prompt|waiting for your input)\b/i.test(
        notificationMessage,
      );
      const turnWasIdle =
        lastTurnStop != null &&
        (lastComposing == null || lastComposing.observedAt < lastTurnStop.observedAt) &&
        (lastPreToolUse == null ||
          (lastPostToolUseAt != null && lastPostToolUseAt >= lastPreToolUse.observedAt));
      if (
        record.notification_type === 'idle_prompt' ||
        notificationIndicatesIdle ||
        (!record.notification_type && !notificationMessage && turnWasIdle)
      ) {
        lastIdleNotification = { observedAt };
      } else {
        lastComposing = { observedAt };
      }
    }
  }

  const lastIdle =
    lastIdleNotification &&
    (!lastTurnStop || lastIdleNotification.observedAt > lastTurnStop.observedAt)
      ? lastIdleNotification
      : lastTurnStop;

  const freshest = [
    lastPreToolUse?.observedAt,
    lastPostToolUseAt,
    lastIdle?.observedAt,
    lastComposing?.observedAt,
  ]
    .filter((value): value is number => value != null)
    .sort((a, b) => b - a)[0];
  if (freshest == null) return null;
  if (!isFreshObservedAt(freshest, now)) {
    // A terminal idle hook remains useful as a low-confidence last-known state. The hook-only
    // sender may use it only after its existing live-composer guard proves the input is empty;
    // selectors continue to reject low-confidence readings everywhere else.
    const freshestNonIdle = Math.max(
      lastPreToolUse?.observedAt ?? Number.NEGATIVE_INFINITY,
      lastPostToolUseAt ?? Number.NEGATIVE_INFINITY,
      lastComposing?.observedAt ?? Number.NEGATIVE_INFINITY,
    );
    if (
      lastIdle?.observedAt === freshest &&
      lastIdle.observedAt > freshestNonIdle &&
      now - freshest <= OBSERVABILITY_TERMINAL_IDLE_MAX_AGE_MS
    ) {
      return {
        value: 'idle',
        source: 'hook',
        confidence: 'low',
        observedAt: freshest,
        evidence: 'stale-terminal-idle',
      };
    }
    return null;
  }

  if (
    lastPreToolUse &&
    (lastPostToolUseAt == null || lastPreToolUse.observedAt > lastPostToolUseAt) &&
    (lastIdle == null || lastPreToolUse.observedAt > lastIdle.observedAt) &&
    (lastComposing == null || lastPreToolUse.observedAt > lastComposing.observedAt)
  ) {
    return {
      value: 'tool-running',
      source: 'hook',
      confidence: 'high',
      observedAt: lastPreToolUse.observedAt,
    };
  }
  if (lastComposing && (lastIdle == null || lastComposing.observedAt > lastIdle.observedAt)) {
    return {
      value: 'composing',
      source: 'hook',
      confidence: 'high',
      observedAt: lastComposing.observedAt,
    };
  }
  if (lastIdle) {
    return {
      value: 'idle',
      source: 'hook',
      confidence: 'high',
      observedAt: lastIdle.observedAt,
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
    if (event !== 'Stop') continue;
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
): Promise<{ hooksRaw: string; hooksTailComplete: boolean; statuslineRaw: string }> {
  const obsDir = shellQuote(await runnerObservabilityDirForSlot({ ...vars, remoteRepo: repoPath }));
  const hooksPath = `${obsDir}/hooks.jsonl`;
  const statuslinePath = `${obsDir}/statusline.json`;
  const [hooksResult, statuslineResult] = await Promise.all([
    execOnSlot(
      vars,
      `{ cat ${hooksPath}.1 2>/dev/null || true; cat ${hooksPath} 2>/dev/null || true; } | tail -c 65536`,
    ),
    execOnSlot(vars, `cat ${statuslinePath} 2>/dev/null || true`),
  ]);
  return {
    hooksRaw: hooksResult.stdout,
    // An exact-size tail may be truncated, so only a shorter read proves the combined retained
    // history was read in full. This lets short/fresh logs answer long-window digest lookups while
    // exact-size tails remain fail-closed.
    hooksTailComplete: Buffer.byteLength(hooksResult.stdout, 'utf8') < 65_536,
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
  paneRetired = false,
): ObservabilityReading<boolean> | null {
  const scoped = filterHooksByPane(hooks, paneId);
  // Under the ADR-032 pane-retirement flag ONLY, no hook records for this pane is ABSENCE of
  // evidence, not evidence of no turn: fabricating a medium-confidence `false` would read as an
  // authoritative "no prompt" and mask a dead/absent hook pipeline as a confident decision instead
  // of surfacing it as degraded — so return null. FLAG-OFF (default) preserves main's behavior and
  // falls through to the medium-`false` after the grace window; the null semantics must not leak to
  // the Phase-2 pane-fallback callers.
  if (scoped.length === 0 && paneRetired) return null;
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
  paneRetired = false,
): ObservabilityReading<boolean> | null {
  const scoped = filterHooksByPane(hooks, paneId);
  // Under the ADR-032 pane-retirement flag ONLY, absent hooks for this pane are non-authoritative
  // (degraded), not a confident "prompt not accepted": a fabricated medium-`false` would let the
  // retirement send path treat a dead hook stream as an authoritative decision, so return null and
  // let it degrade/hold. FLAG-OFF (default) keeps main's medium-`false` semantics for Phase-2.
  if (scoped.length === 0 && paneRetired) return null;
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
    const turnStarted = promptTurnStartedFromHooks(
      scoped,
      sinceMs,
      paneId,
      now,
      graceMs,
      paneRetired,
    );
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
  const turnStarted = promptTurnStartedFromHooks(
    scoped,
    sinceMs,
    paneId,
    now,
    graceMs,
    paneRetired,
  );
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

/**
 * Exact digest lookup for long-window idempotency checks.
 *
 * Unlike {@link promptAcceptedFromHooks}, this never substitutes generic turn-start evidence for
 * a digest match. A negative result is authoritative only when the retained hook tail starts at or
 * before the requested window. Otherwise the matching prompt may have scrolled out of the bounded
 * read, so the caller must degrade instead of resending it.
 */
export function promptDigestAcceptedFromHooks(
  hooks: readonly HookRecord[],
  promptDigest: string,
  sinceMs: number,
  now = Date.now(),
  paneId?: string | null,
  paneRetired = false,
  tailComplete = false,
): ObservabilityReading<boolean> | null {
  const scoped = filterHooksByPane(hooks, paneId);
  let oldestObservedAt: number | null = null;
  for (const record of hooks) {
    const observedAt = observedAtFromRecord(record);
    if (observedAt == null) continue;
    if (oldestObservedAt == null || observedAt < oldestObservedAt) oldestObservedAt = observedAt;
  }
  let latestObservedAt: number | null = null;
  let latestMatchAt: number | null = null;
  for (const record of scoped) {
    const observedAt = observedAtFromRecord(record);
    if (observedAt == null || observedAt < sinceMs) continue;
    if (latestObservedAt == null || observedAt > latestObservedAt) latestObservedAt = observedAt;
    if (hookEventName(record) !== 'UserPromptSubmit') continue;
    const digest = record.runnerPromptDigest;
    if (
      typeof digest === 'string' &&
      (digest === promptDigest || digest.startsWith(promptDigest)) &&
      (latestMatchAt == null || observedAt > latestMatchAt)
    ) {
      latestMatchAt = observedAt;
    }
  }
  if (latestMatchAt != null) {
    return {
      value: true,
      source: 'hook',
      confidence: 'high',
      observedAt: latestMatchAt,
    };
  }
  if (!tailComplete && (oldestObservedAt == null || oldestObservedAt > sinceMs)) return null;
  if (latestObservedAt != null) {
    return {
      value: false,
      source: 'hook',
      confidence: 'medium',
      observedAt: latestObservedAt,
    };
  }
  if (paneRetired) return null;
  return { value: false, source: 'hook', confidence: 'medium', observedAt: now };
}
