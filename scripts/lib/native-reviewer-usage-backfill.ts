import { normalizeFlowType, type RunnerSessionUsage } from '@farmslot/protocol';

import type {
  NativeSessionUsageIdentity,
  NativeSessionUsageRequest,
} from '../../services/gateway/src/runners/native-session-usage-command.js';
import { upsertSessionUsage } from '../../services/gateway/src/runtime/agent-session-rows.js';
import { preferSessionUsage } from '../../services/gateway/src/runtime/reviewer-usage.js';

export const LEGACY_REVIEW_USAGE_ERROR = 'Native reviewer usage accounting is unavailable';
export const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
export const usageKey = (runner: string, session: string) => JSON.stringify([runner, session]);
const string = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const counter = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

function legacyUsage(
  value: unknown,
): value is Record<string, unknown> & { runner: string; runnerSessionId: string } {
  return (
    object(value) &&
    value.source === 'unavailable' &&
    value.error === LEGACY_REVIEW_USAGE_ERROR &&
    typeof value.runner === 'string' &&
    typeof value.runnerSessionId === 'string'
  );
}
export function visitLegacyUsage(
  document: unknown,
  found: (usage: { runner: string; runnerSessionId: string }) => void,
): void {
  if (legacyUsage(document)) found(document);
  else if (Array.isArray(document)) document.forEach((value) => visitLegacyUsage(value, found));
  else if (object(document))
    Object.values(document).forEach((value) => visitLegacyUsage(value, found));
}
function identity(value: unknown): NativeSessionUsageIdentity | undefined {
  if (
    !object(value) ||
    typeof value.sessionId !== 'string' ||
    typeof value.ownerPrincipalId !== 'string' ||
    typeof value.executionNodeId !== 'string'
  )
    return;
  return {
    sessionId: value.sessionId,
    ownerPrincipalId: value.ownerPrincipalId,
    executionNodeId: value.executionNodeId,
    ...(typeof value.stateDirectory === 'string' ? { stateDirectory: value.stateDirectory } : {}),
  };
}
function receipt(value: unknown): RunnerSessionUsage | undefined {
  if (
    !object(value) ||
    !['runner-transcript', 'provider-response', 'unavailable'].includes(String(value.source)) ||
    typeof value.runner !== 'string' ||
    typeof value.runnerSessionId !== 'string' ||
    typeof value.measuredAt !== 'string'
  )
    return;
  const strings = (items: unknown): string[] | undefined =>
    Array.isArray(items)
      ? items.filter((item): item is string => typeof item === 'string')
      : undefined;
  return {
    model: string(value.model),
    effort: string(value.effort),
    role: typeof value.role === 'string' ? value.role : undefined,
    roles: strings(value.roles),
    contextIds: strings(value.contextIds),
    runId: string(value.runId),
    flowType: typeof value.flowType === 'string' ? normalizeFlowType(value.flowType) : null,
    runnerSessionPath: string(value.runnerSessionPath),
    nativeSession: identity(value.nativeSession),
    slotId: string(value.slotId),
    identityKind:
      value.identityKind === 'request'
        ? 'request'
        : value.identityKind === 'conversation'
          ? 'conversation'
          : undefined,
    kind: value.kind === 'helper' ? 'helper' : value.kind === 'agent' ? 'agent' : undefined,
    requestId: typeof value.requestId === 'string' ? value.requestId : undefined,
    startedAt: string(value.startedAt),
    completedAt: string(value.completedAt),
    durationMs: counter(value.durationMs),
    costStatus:
      value.costStatus === 'estimated'
        ? 'estimated'
        : value.costStatus === 'unpriced'
          ? 'unpriced'
          : undefined,
    costReason: typeof value.costReason === 'string' ? value.costReason : undefined,
    captureGaps: strings(value.captureGaps),
    outcome:
      value.outcome === 'completed'
        ? 'completed'
        : value.outcome === 'failed'
          ? 'failed'
          : undefined,
    source:
      value.source === 'provider-response'
        ? 'provider-response'
        : value.source === 'runner-transcript'
          ? 'runner-transcript'
          : 'unavailable',
    runner: value.runner,
    runnerSessionId: value.runnerSessionId,
    measuredAt: value.measuredAt,
    actualModel: string(value.actualModel),
    totalTokens: counter(value.totalTokens),
    turns: counter(value.turns),
    inputTokens: counter(value.inputTokens),
    outputTokens: counter(value.outputTokens),
    cacheRead: counter(value.cacheRead),
    cacheCreation: counter(value.cacheCreation),
    costUsd: counter(value.costUsd),
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
  };
}
function retainedReceipts(document: unknown): Map<string, RunnerSessionUsage> {
  const result = new Map<string, RunnerSessionUsage>();
  const visit = (value: unknown): void => {
    const parsed = receipt(value);
    if (parsed) {
      const key = usageKey(parsed.runner!, parsed.runnerSessionId!);
      result.set(key, preferSessionUsage(result.get(key), parsed));
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (object(value)) Object.values(value).forEach(visit);
  };
  visit(document);
  return result;
}
function sources(document: Record<string, unknown>): Record<string, unknown>[] {
  const entries = [
    ...(Array.isArray(document.agentContexts) ? document.agentContexts : []),
    ...(Array.isArray(document.sessionUsage) ? document.sessionUsage : []),
  ].filter(object);
  for (const value of retainedReceipts(document).values()) {
    if (value.runId === document.id && typeof value.role === 'string') entries.push({ ...value });
  }
  const engine = object(document.engineState) ? document.engineState : undefined;
  const gate = object(engine?.publishGate) ? engine.publishGate : undefined;
  for (const review of Array.isArray(gate?.reviews) ? gate.reviews : []) {
    if (!object(review)) continue;
    if (object(review.usage))
      entries.push({
        ...review.usage,
        role: 'review',
        model: review.model ?? review.usage.model,
        runner: review.usage.runner ?? review.runner,
        runnerSessionId: review.usage.runnerSessionId ?? review.reviewerSessionId,
      });
    for (const attempt of Array.isArray(review.attempts) ? review.attempts : []) {
      if (
        object(attempt) &&
        object(attempt.usage) &&
        typeof attempt.usage.runnerSessionId === 'string'
      )
        entries.push({
          ...attempt.usage,
          role: 'review',
          model: attempt.usage.model ?? review.model,
        });
    }
  }
  if (object(document.metrics)) entries.push({ ...document.metrics, role: 'worker' });
  return entries;
}

/** Exact context/receipt sources for all roles. Pool ownership locates terminal paths. */
export function agentSessionRequests(
  document: unknown,
  repo: string,
  provider: (runner: string) => string | undefined,
  nodeForSlot: (slotId: string) => string | undefined = () => undefined,
): NativeSessionUsageRequest[] {
  if (!object(document) || typeof document.id !== 'string') return [];
  const entries = sources(document);
  const represented = retainedReceipts(document);
  const requests = new Map<string, NativeSessionUsageRequest>();
  for (const entry of entries) {
    if (typeof entry.runner !== 'string' || typeof entry.runnerSessionId !== 'string') continue;
    const key = usageKey(entry.runner, entry.runnerSessionId);
    const known = represented.get(key);
    if (known && known.source !== 'unavailable' && !known.error && known.totalTokens != null)
      continue;
    const kind = provider(entry.runner);
    if (!kind || requests.has(key)) continue;
    const matches = entries.filter(
      (item) => item.runner === entry.runner && item.runnerSessionId === entry.runnerSessionId,
    );
    const bindings = matches.flatMap((item) => {
      const binding = identity(item.nativeSession);
      return binding ? [binding] : [];
    });
    const binding = bindings[0];
    if (
      binding &&
      bindings.some(
        (other) =>
          other.ownerPrincipalId !== binding.ownerPrincipalId ||
          other.executionNodeId !== binding.executionNodeId,
      )
    )
      continue;
    const path = matches.map((item) => string(item.runnerSessionPath)).find(Boolean);
    const slotId = string(entry.slotId) ?? string(document.slotId) ?? document.id;
    const node = binding?.executionNodeId ?? nodeForSlot(slotId);
    if (!node || (!binding && !path)) continue;
    requests.set(key, {
      key,
      runner: entry.runner,
      provider: kind,
      runnerSessionId: entry.runnerSessionId,
      cwd: repo,
      slotId,
      ...(path ? { sessionPath: path } : {}),
      ...(binding ? { nativeSession: binding } : {}),
      executionNodeId: node,
    });
  }
  return [...requests.values()];
}

/** Enumerate unavailable identities/counters, including historical helper evidence with no id. */
export function sessionCaptureGaps(
  document: unknown,
): Array<{ role: string; sessionId: string | null; reason: string }> {
  if (!object(document)) return [];
  const gaps: Array<{ role: string; sessionId: string | null; reason: string }> = [];
  const known = retainedReceipts(document);
  const seen = new Set<string>();
  for (const entry of sources(document)) {
    const key =
      typeof entry.runner === 'string' && typeof entry.runnerSessionId === 'string'
        ? usageKey(entry.runner, entry.runnerSessionId)
        : null;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const usage = known.get(key);
    if (
      typeof entry.runnerSessionId !== 'string' ||
      (usage?.source !== 'unavailable' && usage?.totalTokens != null)
    )
      continue;
    gaps.push({
      role: string(entry.role) ?? 'worker',
      sessionId: entry.runnerSessionId,
      reason: usage?.error ?? 'No verified accounting source',
    });
  }
  for (const step of Array.isArray(document.steps) ? document.steps : []) {
    if (!object(step) || !object(step.outputs)) continue;
    for (const value of Object.values(step.outputs))
      if (
        object(value) &&
        typeof value.provider === 'string' &&
        typeof value.model === 'string' &&
        !value.sessionUsage &&
        !['heuristic', 'fallback', 'skip'].includes(value.provider)
      )
        gaps.push({
          role: string(step.name) ?? 'helper',
          sessionId: null,
          reason: 'Historical helper has step usage but no recorded request/conversation identity',
        });
  }
  return gaps;
}

/** Patch only accounting fields. Keep the rest of every run/learning record opaque. */
export function backfillDocument(
  document: unknown,
  usages: ReadonlyMap<string, RunnerSessionUsage>,
): { document: unknown; replacements: number; sessionKeys: string[] } {
  let replacements = 0;
  const receipts = retainedReceipts(document);
  for (const [key, measured] of usages)
    receipts.set(key, preferSessionUsage(receipts.get(key), measured));
  const sessionKeys = new Set<string>();
  const patch = (value: unknown): unknown => {
    if (legacyUsage(value)) {
      const usage = receipts.get(usageKey(value.runner, value.runnerSessionId));
      if (usage && usage.source !== 'unavailable' && !usage.error) {
        replacements++;
        const next = { ...value, ...usage };
        delete next.error;
        return next;
      }
      return value;
    }
    if (Array.isArray(value)) return value.map(patch);
    if (object(value))
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, patch(item)]));
    return value;
  };
  const result = patch(document);
  if (!object(result) || typeof result.id !== 'string')
    return { document: result, replacements, sessionKeys: [] };
  let rows: RunnerSessionUsage[] = [];
  const existing = Array.isArray(result.sessionUsage)
    ? result.sessionUsage.flatMap((value) => {
        const row = receipt(value);
        return row && object(value) ? [{ ...value, ...row }] : [];
      })
    : [];
  for (const row of existing) rows = upsertSessionUsage(rows, row);
  const measuredAt = new Date().toISOString();
  const entries = sources(result);
  for (const entry of entries) {
    const runner = string(entry.runner),
      sessionId = string(entry.runnerSessionId);
    if (!runner || !sessionId) continue;
    const key = usageKey(runner, sessionId);
    const measured = receipts.get(key);
    const native = identity(entry.nativeSession);
    const start =
      string(entry.startedAt) ??
      string(object(entry.nativeSession) ? entry.nativeSession.launchRequestedAt : undefined);
    const end =
      string(entry.completedAt) ??
      string(object(entry.nativeSession) ? entry.nativeSession.closedAt : undefined);
    const duration =
      start && end && Number.isFinite(Date.parse(start)) && Number.isFinite(Date.parse(end))
        ? Math.max(0, Date.parse(end) - Date.parse(start))
        : (measured?.durationMs ?? null);
    const costUsd = measured?.costUsd ?? null;
    const role = string(entry.role) ?? 'worker';
    const row: RunnerSessionUsage = {
      ...(object(entry.usage) ? entry.usage : {}),
      ...measured,
      runner,
      runnerSessionId: sessionId,
      runnerSessionPath: measured?.runnerSessionPath ?? string(entry.runnerSessionPath),
      model: string(entry.model) ?? measured?.model ?? null,
      actualModel: measured?.actualModel ?? null,
      effort:
        string(entry.effort) ??
        string(object(entry.nativeSession) ? entry.nativeSession.effort : undefined) ??
        string(result.effort),
      role,
      roles: [role],
      contextIds: typeof entry.id === 'string' ? [entry.id] : (measured?.contextIds ?? []),
      flowType: typeof result.flowType === 'string' ? normalizeFlowType(result.flowType) : null,
      runId: result.id,
      identityKind: measured?.identityKind ?? 'conversation',
      kind: measured?.kind ?? 'agent',
      slotId: string(entry.slotId) ?? string(result.slotId),
      ...(native ? { nativeSession: native } : {}),
      startedAt: start ?? measured?.startedAt ?? null,
      completedAt: end ?? measured?.completedAt ?? null,
      durationMs: duration,
      turns: measured?.turns ?? null,
      inputTokens: measured?.inputTokens ?? null,
      outputTokens: measured?.outputTokens ?? null,
      cacheRead: measured?.cacheRead ?? null,
      cacheCreation: measured?.cacheCreation ?? null,
      totalTokens: measured?.totalTokens ?? null,
      costUsd,
      costStatus: costUsd === null ? 'unpriced' : 'estimated',
      costReason:
        costUsd === null ? (measured?.costReason ?? 'No verified historical price') : undefined,
      source: measured?.source ?? 'unavailable',
      error: measured?.error,
      measuredAt: measured?.measuredAt ?? measuredAt,
      scope: 'session-total',
      ...(!measured ? { error: 'No verified accounting source' } : {}),
      captureGaps: [
        ...new Set([
          ...(measured?.captureGaps ?? []),
          ...(duration === null ? ['Historical session duration unavailable'] : []),
        ]),
      ],
    };
    rows = upsertSessionUsage(rows, row);
    if (row.source !== 'unavailable' && !row.error) sessionKeys.add(key);
    if (Array.isArray(result.agentContexts) && result.agentContexts.includes(entry)) {
      const merged = { ...(object(entry.usage) ? entry.usage : {}), ...row };
      if (!row.error) delete merged.error;
      if (JSON.stringify(entry.usage) !== JSON.stringify(merged)) {
        entry.usage = merged;
        replacements++;
      }
    }
  }
  if (rows.length && JSON.stringify(result.sessionUsage) !== JSON.stringify(rows)) {
    result.sessionUsage = rows;
    replacements++;
  }
  return { document: result, replacements, sessionKeys: [...sessionKeys] };
}
