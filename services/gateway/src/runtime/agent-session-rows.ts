import {
  type AgentContext,
  primaryRoleForFlow,
  type Run,
  type RunnerSessionUsage,
} from '@farmslot/protocol';

import { resolveNativeContext } from '../agents/native-context.js';
import type { RecoveredUsageSession } from '../runners/session-usage-provider.js';

import { preferSessionUsage } from './reviewer-usage.js';

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
): RunnerSessionUsage[] {
  const key = sessionUsageKey(receipt);
  if (!key) return [...rows];
  const retained =
    receipt.runnerSessionId && receipt.nativeSession
      ? rows.filter(
          (row) =>
            row.runnerSessionId ||
            row.runner !== receipt.runner ||
            row.nativeSession?.sessionId !== receipt.nativeSession?.sessionId ||
            row.nativeSession?.ownerPrincipalId !== receipt.nativeSession?.ownerPrincipalId ||
            row.nativeSession?.executionNodeId !== receipt.nativeSession?.executionNodeId,
        )
      : rows;
  const index = retained.findIndex((row) => sessionUsageKey(row) === key);
  if (index < 0) return [...retained, receipt];
  const previous = retained[index];
  const best = preferSessionUsage(previous, receipt);
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
  const merged: RunnerSessionUsage = {
    ...previous,
    ...receipt,
    ...best,
    error: best.error,
    outcome: receipt.outcome ?? previous.outcome,
    captureGaps: best.captureGaps ?? [],
    role: previous.role ?? receipt.role,
    roles,
    contextIds: [...new Set([...(previous.contextIds ?? []), ...(receipt.contextIds ?? [])])],
    nativeSession: receipt.nativeSession ?? previous.nativeSession,
    runnerSessionPath:
      best.runnerSessionPath ?? receipt.runnerSessionPath ?? previous.runnerSessionPath,
    startedAt,
    completedAt,
    durationMs: startedAt
      ? Math.max(
          0,
          Math.max(
            Date.parse(previous.completedAt ?? previous.measuredAt),
            Date.parse(receipt.completedAt ?? receipt.measuredAt),
          ) - Date.parse(startedAt),
        )
      : (previous.durationMs ?? receipt.durationMs ?? null),
  };
  return retained.map((row, rowIndex) => (rowIndex === index ? merged : row));
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
    scope: 'session-total',
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
  if (context) {
    const same = context.runnerSessionId === session.runnerSessionId;
    const receipt = contextSessionReceipt(
      run,
      {
        ...context,
        runner: usage.runner ?? context.runner,
        runnerSessionId: session.runnerSessionId,
        runnerSessionPath: session.runnerSessionPath,
        usage,
        ...(!same
          ? { startedAt: undefined, completedAt: undefined, nativeSession: undefined }
          : {}),
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
    model: previous?.model ?? run.metrics.model ?? null,
    effort: previous?.effort ?? run.effort ?? null,
    contextIds: previous?.contextIds ?? [],
    startedAt: previous?.startedAt ?? null,
    completedAt: previous?.completedAt ?? null,
    durationMs: previous?.durationMs ?? null,
    costUsd: usage.costUsd ?? null,
    costStatus: usage.costUsd == null ? 'unpriced' : 'estimated',
    costReason:
      usage.costUsd == null ? 'Runner accounting has no verified price for this model' : undefined,
    captureGaps: [
      ...(usage.error ? [usage.error] : []),
      ...(previous?.durationMs == null
        ? ['Historical session context/duration is unavailable']
        : []),
    ],
  };
}
