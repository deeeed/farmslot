import {
  type AgentContext,
  preferRunUsageReceipt,
  primaryRoleForFlow,
  type Run,
  type RunnerSessionUsage,
} from '@farmslot/protocol';

import { resolveNativeContext } from '../agents/native-context.js';
import type { RecoveredUsageSession } from '../runners/session-usage-provider.js';
import { noteCostUsageUpsert } from '../runs/cost-accounting-revision.js';

export const sessionUsageKey = (
  usage: Pick<RunnerSessionUsage, 'runner' | 'runnerSessionId' | 'nativeSession'>,
): string | null => {
  if (!usage.runner) return null;
  if (usage.runnerSessionId) return JSON.stringify([usage.runner, usage.runnerSessionId]);
  const source = usage.nativeSession;
  return source
    ? JSON.stringify([
        usage.runner,
        'pending-native',
        source.executionNodeId,
        source.ownerPrincipalId,
        source.sessionId,
      ])
    : null;
};

export function upsertSessionUsage(
  rows: readonly RunnerSessionUsage[],
  receipt: RunnerSessionUsage,
  coverage: 'run' | 'session' = 'run',
): RunnerSessionUsage[] {
  const key = sessionUsageKey(receipt);
  if (!key) {
    const copy = [...rows];
    noteCostUsageUpsert(rows, copy);
    return copy;
  }
  const promoteRequest =
    coverage === 'run' && receipt.identityKind === 'conversation' && receipt.requestId;
  const promoteNative = Boolean(receipt.runnerSessionId && receipt.nativeSession);
  const filtered =
    promoteRequest || promoteNative
      ? rows.filter((row) => {
          if (row.runner !== receipt.runner) return true;
          if (
            promoteRequest &&
            row.identityKind === 'request' &&
            row.requestId === receipt.requestId
          )
            return false;
          return (
            !promoteNative ||
            Boolean(row.runnerSessionId) ||
            row.nativeSession?.sessionId !== receipt.nativeSession?.sessionId ||
            row.nativeSession?.ownerPrincipalId !== receipt.nativeSession?.ownerPrincipalId ||
            row.nativeSession?.executionNodeId !== receipt.nativeSession?.executionNodeId
          );
        })
      : rows;
  const retained = filtered.length === rows.length ? rows : filtered;
  const index = retained.findIndex((row) => sessionUsageKey(row) === key);
  if (index < 0) {
    const added = [...retained, receipt];
    noteCostUsageUpsert(rows, added, undefined, receipt);
    return added;
  }
  const previous = retained[index];
  const merged = mergeUsageReceipt(previous, receipt, coverage);
  const updated = retained.map((row, rowIndex) => (rowIndex === index ? merged : row));
  noteCostUsageUpsert(rows, updated, previous, merged);
  return updated;
}

function mergeUsageReceipt(
  previous: RunnerSessionUsage,
  receipt: RunnerSessionUsage,
  coverage: 'run' | 'session',
): RunnerSessionUsage {
  const scopeChanged = (previous.scope ?? 'session-total') !== (receipt.scope ?? 'session-total');
  const earlierNative = previous.nativeSession;
  const laterNative = receipt.nativeSession;
  const sameNativeRun =
    coverage === 'run' &&
    Boolean(earlierNative || laterNative) &&
    (!earlierNative ||
      !laterNative ||
      (earlierNative.sessionId === laterNative.sessionId &&
        earlierNative.ownerPrincipalId === laterNative.ownerPrincipalId &&
        earlierNative.executionNodeId === laterNative.executionNodeId)) &&
    (!previous.runId || !receipt.runId || previous.runId === receipt.runId);
  const coversMoreLeases = (candidate: RunnerSessionUsage, existing: RunnerSessionUsage) => {
    if (candidate.scope !== 'run-delta' || candidate.source === 'unavailable' || candidate.error)
      return false;
    const covered = new Set(candidate.usageLeaseIds);
    const prior = existing.usageLeaseIds ?? [];
    return covered.size > prior.length && prior.every((lease) => covered.has(lease));
  };
  const best =
    sameNativeRun && coversMoreLeases(receipt, previous)
      ? receipt
      : sameNativeRun && coversMoreLeases(previous, receipt)
        ? previous
        : preferRunUsageReceipt(
            previous,
            receipt,
            coverage === 'run' ? 'run-delta' : 'session-total',
          );
  const other = best === previous ? receipt : previous;
  const leases = new Set(best.usageLeaseIds);
  const otherLeases = new Set(other.usageLeaseIds);
  const pendingLeases = sameNativeRun
    ? [
        ...new Set([
          ...(previous.pendingUsageLeaseIds ?? []),
          ...(receipt.pendingUsageLeaseIds ?? []),
          ...(previous.usageLeaseIds ?? []),
          ...(receipt.usageLeaseIds ?? []),
        ]),
      ].filter((lease) => !leases.has(lease))
    : best.pendingUsageLeaseIds;
  const differentDeltaWindow =
    best.scope === 'run-delta' &&
    ((best.runId && other.runId && best.runId !== other.runId) ||
      (best.startedAt && other.startedAt && best.startedAt !== other.startedAt) ||
      (best.completedAt && other.completedAt && best.completedAt !== other.completedAt) ||
      leases.size !== otherLeases.size ||
      [...leases].some((lease) => !otherLeases.has(lease)));
  const differentWindow = scopeChanged || differentDeltaWindow;
  const measuredTokens =
    !differentWindow &&
    best.totalTokens == null &&
    other.totalTokens != null &&
    other.source !== 'unavailable' &&
    !other.error
      ? {
          totalTokens: other.totalTokens,
          inputTokens: other.inputTokens,
          outputTokens: other.outputTokens,
          cacheCreation: other.cacheCreation,
          cacheRead: other.cacheRead,
          reasoningOutputTokens: other.reasoningOutputTokens,
        }
      : undefined;
  const startedAt =
    [previous.startedAt, receipt.startedAt]
      .filter((value): value is string => !!value)
      .sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
  const completedAt =
    receipt.completedAt === null ? null : (receipt.completedAt ?? previous.completedAt ?? null);
  const roles = [
    ...new Set(
      [...(previous.roles ?? []), ...(receipt.roles ?? []), previous.role, receipt.role].filter(
        (role): role is string => !!role,
      ),
    ),
  ];
  return {
    // Missing measurement fields must not be filled from a different usage window.
    ...(differentWindow ? {} : { ...previous, ...receipt }),
    ...best,
    ...measuredTokens,
    includesPriorRunLifetime: previous.includesPriorRunLifetime ?? receipt.includesPriorRunLifetime,
    error: best.error,
    costUsd: best.costUsd,
    costStatus: best.costStatus,
    costReason: best.costReason,
    pricingScope: best.pricingScope,
    providerReportedCostUsd: best.providerReportedCostUsd,
    outcome: receipt.outcome ?? previous.outcome,
    captureGaps: best.captureGaps ?? [],
    role: previous.role ?? receipt.role,
    roles,
    contextIds: [...new Set([...(previous.contextIds ?? []), ...(receipt.contextIds ?? [])])],
    nativeSession: receipt.nativeSession ?? previous.nativeSession,
    usageLeaseIds:
      sameNativeRun || differentDeltaWindow
        ? best.usageLeaseIds
        : [...new Set([...(previous.usageLeaseIds ?? []), ...(receipt.usageLeaseIds ?? [])])],
    pendingUsageLeaseIds: pendingLeases?.length ? pendingLeases : undefined,
    runnerSessionPath:
      best.runnerSessionPath ?? receipt.runnerSessionPath ?? previous.runnerSessionPath,
    startedAt: differentDeltaWindow ? best.startedAt : startedAt,
    completedAt: differentDeltaWindow ? best.completedAt : completedAt,
    durationMs: differentDeltaWindow
      ? best.durationMs
      : startedAt
        ? Math.max(
            0,
            Math.max(
              Date.parse(previous.completedAt ?? previous.measuredAt),
              Date.parse(receipt.completedAt ?? receipt.measuredAt),
            ) - Date.parse(startedAt),
          )
        : (previous.durationMs ?? receipt.durationMs ?? null),
  };
}

/** Merge a batch without searching and copying the ledger for every observation. */
export function mergeRunSessionReceipts(
  existing: readonly RunnerSessionUsage[],
  receipts: readonly RunnerSessionUsage[],
): RunnerSessionUsage[] {
  const rows = Array.from<RunnerSessionUsage | undefined>(existing);
  const positions = new Map<string, number>();
  const pending = new Map<string, number[]>();
  for (const [index, row] of existing.entries()) {
    const key = sessionUsageKey(row);
    if (!key) continue;
    if (!positions.has(key)) positions.set(key, index);
    if (!row.runnerSessionId && row.nativeSession) {
      const reservations = pending.get(key) ?? [];
      reservations.push(index);
      pending.set(key, reservations);
    }
  }
  for (const receipt of receipts) {
    const key = sessionUsageKey(receipt);
    if (!key) continue;
    const index = positions.get(key) ?? rows.length;
    if (receipt.runnerSessionId && receipt.nativeSession) {
      const reservation = sessionUsageKey({ ...receipt, runnerSessionId: null })!;
      for (const slot of pending.get(reservation) ?? []) rows[slot] = undefined;
      pending.delete(reservation);
      positions.delete(reservation);
    } else if (receipt.nativeSession && !pending.has(key)) {
      pending.set(key, [index]);
    }
    const previous = rows[index];
    rows[index] = previous ? mergeUsageReceipt(previous, receipt, 'run') : receipt;
    positions.set(key, index);
  }
  return rows.filter((row): row is RunnerSessionUsage => Boolean(row));
}

/** Enrich the common receipt. Unknown fields remain explicit, never observed zero. */
export function contextSessionReceipt(
  run: Pick<Run, 'id' | 'flowType' | 'slotId' | 'effort' | 'startedAt' | 'metrics'>,
  context: AgentContext,
  now: string,
): RunnerSessionUsage | null {
  if (!context.runner || (!context.runnerSessionId && !context.nativeSession)) return null;
  const runnerSessionId = context.runnerSessionId || null;
  const captured =
    runnerSessionId &&
    context.usage?.runner === context.runner &&
    context.usage.runnerSessionId === runnerSessionId
      ? context.usage
      : undefined;
  const startedAt =
    captured?.startedAt ?? context.nativeSession?.launchRequestedAt ?? context.startedAt ?? null;
  const completedAt =
    context.completedAt ??
    context.nativeSession?.closedAt ??
    captured?.completedAt ??
    (['complete', 'failed', 'blocked', 'idle'].includes(context.status)
      ? (context.updatedAt ?? now)
      : null);
  const measuredAt = captured?.measuredAt ?? now;
  const start = startedAt ? Date.parse(startedAt) : NaN;
  const end = Date.parse(completedAt ?? measuredAt);
  const durationMs =
    Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
  const costUsd =
    typeof captured?.costUsd === 'number' && Number.isFinite(captured.costUsd)
      ? captured.costUsd
      : null;
  const gaps = [...(captured?.captureGaps ?? [])];
  if (!runnerSessionId) gaps.push('Native conversation has not been returned');
  if (!captured || captured.source === 'unavailable')
    gaps.push(captured?.error ?? 'Session usage has not been measured');
  if (durationMs === null) gaps.push('Session start time is unavailable');
  if (!captured?.actualModel) gaps.push('Actual model has not been reported');
  if (!(context.effort ?? context.nativeSession?.effort ?? run.effort))
    gaps.push('Effective effort has not been reported');
  return {
    ...captured,
    runner: context.runner,
    runnerSessionId,
    runnerSessionPath: captured?.runnerSessionPath ?? context.runnerSessionPath ?? null,
    usageLeaseIds: captured?.usageLeaseIds,
    pendingUsageLeaseIds:
      context.nativeSession && !captured?.usageLeaseIds?.includes(context.nativeSession.leaseId)
        ? [...new Set([...(captured?.pendingUsageLeaseIds ?? []), context.nativeSession.leaseId])]
        : captured?.pendingUsageLeaseIds,
    nativeSession: context.nativeSession
      ? {
          sessionId: context.nativeSession.sessionId,
          executionNodeId: context.nativeSession.executionNodeId,
          ownerPrincipalId: context.nativeSession.ownerPrincipalId,
          stateDirectory: context.nativeSession.stateDirectory,
        }
      : undefined,
    slotId: context.slotId ?? run.slotId ?? null,
    identityKind: 'conversation',
    kind: 'agent',
    runId: run.id,
    flowType: run.flowType,
    role: context.role,
    roles: [context.role],
    contextIds: [context.id],
    model: context.model ?? run.metrics.model ?? null,
    actualModel: captured?.actualModel ?? null,
    effort: context.effort ?? context.nativeSession?.effort ?? run.effort ?? null,
    turns: captured?.turns ?? null,
    inputTokens: captured?.inputTokens ?? null,
    outputTokens: captured?.outputTokens ?? null,
    cacheRead: captured?.cacheRead ?? null,
    cacheCreation: captured?.cacheCreation ?? null,
    totalTokens: captured?.totalTokens ?? null,
    costUsd,
    costStatus: costUsd === null ? 'unpriced' : 'estimated',
    ...(costUsd === null
      ? { costReason: captured?.costReason ?? 'No verified price for this session' }
      : { costReason: undefined }),
    startedAt,
    completedAt,
    durationMs,
    measuredAt,
    source: captured?.source ?? 'unavailable',
    scope: captured?.scope ?? 'session-total',
    ...(!captured
      ? {
          error: runnerSessionId
            ? 'Session usage has not been measured'
            : 'Native conversation has not been returned',
        }
      : {}),
    captureGaps: [...new Set(gaps)],
  };
}

/** Called by the single run-store writer on context changes, preserving old identities. */
export function registerContextSessionUsage(
  run: Run,
  now: string,
): RunnerSessionUsage[] | undefined {
  let rows = run.sessionUsage ?? [];
  for (const context of run.agentContexts ?? []) {
    const resolved = context.nativeSessionOwner ? resolveNativeContext(run, context) : null;
    if (context.nativeSessionOwner && !resolved) continue;
    const receipt = contextSessionReceipt(
      run,
      resolved
        ? {
            ...context,
            runner: resolved.owner.runner,
            runnerSessionId: resolved.owner.runnerSessionId,
            runnerSessionPath: resolved.owner.runnerSessionPath,
            nativeSession: resolved.binding,
            usage: resolved.owner.usage,
          }
        : context,
      now,
    );
    if (receipt) rows = upsertSessionUsage(rows, receipt);
  }
  return rows.length ? rows : undefined;
}

/** One receipt builder feeds persisted completion and read-only historical recovery. */
export function recoveredWorkerSessionReceipt(
  run: Run,
  session: RecoveredUsageSession,
  usage: RunnerSessionUsage,
): RunnerSessionUsage {
  const context = run.agentContexts?.find((item) => item.id === session.contextId);
  if (
    context &&
    context.runner === usage.runner &&
    context.runnerSessionId === session.runnerSessionId
  ) {
    const receipt = contextSessionReceipt(
      run,
      {
        ...context,
        runner: usage.runner ?? context.runner,
        runnerSessionId: session.runnerSessionId,
        runnerSessionPath: session.runnerSessionPath,
        usage,
      },
      usage.measuredAt,
    );
    if (receipt) return receipt;
  }
  const previous = run.sessionUsage?.find(
    (row) => row.runner === usage.runner && row.runnerSessionId === session.runnerSessionId,
  );
  const role = previous?.role ?? primaryRoleForFlow(run.flowType);
  return {
    ...previous,
    ...usage,
    error: usage.error,
    runnerSessionId: session.runnerSessionId,
    runnerSessionPath: session.runnerSessionPath,
    kind: 'agent',
    identityKind: 'conversation',
    role,
    roles: previous?.roles ?? [role],
    runId: run.id,
    flowType: run.flowType,
    slotId: previous?.slotId ?? run.slotId,
    model: previous?.model ?? null,
    effort: previous?.effort ?? null,
    contextIds: previous?.contextIds ?? [],
    startedAt: previous?.startedAt ?? null,
    completedAt: previous?.completedAt ?? null,
    durationMs: previous?.durationMs ?? null,
    costUsd: usage.costUsd ?? null,
    costStatus: usage.costUsd == null ? 'unpriced' : 'estimated',
    costReason:
      usage.costUsd == null
        ? (usage.costReason ?? 'Runner accounting has no verified price for this model')
        : undefined,
    captureGaps: [
      ...(usage.captureGaps ?? []),
      ...(usage.error ? [usage.error] : []),
      ...(previous?.model == null || previous?.effort == null
        ? ['Historical requested configuration is unavailable']
        : []),
      ...(previous?.durationMs == null
        ? ['Historical session context/duration is unavailable']
        : []),
    ],
  };
}
