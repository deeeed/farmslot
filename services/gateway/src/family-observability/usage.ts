import {
  type FamilyObservabilityUsage,
  type FamilyUsageParticipation,
  type FamilyUsageSession,
  matchesFailedReviewUsageWindow,
  preferRunUsageReceipt,
  type Run,
  type RunnerSessionUsage,
  sessionUsageIncludesPriorRun,
} from '@farmslot/protocol';
import { reviewHistoryView } from '@farmslot/review-dispatch';

import { resolveNativeContext } from '../agents/native-context.js';
import {
  contextSessionReceipt,
  sessionUsageKey,
  upsertSessionUsage,
} from '../runtime/agent-session-rows.js';
import {
  familyRunSessionUsageReceipts,
  familySessionUsageContributions,
} from '../runtime/session-usage-selection.js';

function sameReviewUsageWindow(
  recorded: RunnerSessionUsage,
  recovered: RunnerSessionUsage,
  contextKey: string,
): boolean {
  if (recorded.source === 'unavailable' || recorded.error)
    return matchesFailedReviewUsageWindow(recorded, recovered, contextKey);
  // A matching context or lease cannot widen explicitly recorded time bounds.
  if (
    (recorded.startedAt && recorded.startedAt !== recovered.startedAt) ||
    (recorded.completedAt && recorded.completedAt !== recovered.completedAt)
  )
    return false;
  const leases = new Set(recorded.usageLeaseIds);
  const recoveryLeases = new Set(recovered.usageLeaseIds);
  if (leases.size)
    return leases.size === recoveryLeases.size && [...leases].every((id) => recoveryLeases.has(id));
  if (recorded.startedAt && recorded.completedAt) return true;
  if (recorded.scope === 'run-delta') return false;
  return recorded.totalTokens != null && recovered.totalTokens != null
    ? recorded.totalTokens === recovered.totalTokens
    : recorded.measuredAt === recovered.measuredAt;
}

/** Project existing accounting facts. Capture, preference and deltas remain data-owned. */
export function buildFamilyUsage(runs: readonly Run[]): FamilyObservabilityUsage {
  const ordered = [...runs].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  const sessions = new Map<string, FamilyUsageSession>();
  const runOrder = new Map(ordered.map((run, index) => [run.id, index]));
  const inventory = new Map(ordered.map((run) => [run, familyRunSessionUsageReceipts(run)]));
  const add = (run: Run, usage: RunnerSessionUsage, fallback: string): void => {
    const runId = run.id;
    const id = sessionUsageKey(usage) ?? JSON.stringify(['unbound', runId, fallback]);
    const before = [...sessions.values()];
    const mergedRows = sessionUsageKey(usage)
      ? upsertSessionUsage(
          before.map((row) => row.usage),
          usage,
          'session',
        )
      : [];
    const retainedKeys = new Set(mergedRows.map(sessionUsageKey));
    // The data-owned merge decides which native placeholders this confirmed receipt replaces.
    const replaced = sessionUsageKey(usage)
      ? before.filter(
          (row) => sessionUsageKey(row.usage) && !retainedKeys.has(sessionUsageKey(row.usage)),
        )
      : [];
    const previous = sessions.get(id);
    const participants = new Map<string, FamilyUsageParticipation>();
    const incoming: FamilyUsageParticipation = {
      runId,
      flowType: run.flowType,
      roles: [
        ...new Set([...(usage.roles ?? []), usage.role].filter((role): role is string => !!role)),
      ],
      contextIds: usage.contextIds ?? [],
    };
    for (const participant of [
      ...(previous?.participations ?? []),
      ...replaced.flatMap((row) => row.participations),
      incoming,
    ]) {
      const prior = participants.get(participant.runId);
      participants.set(participant.runId, {
        ...participant,
        roles: [...new Set([...(prior?.roles ?? []), ...participant.roles])],
        contextIds: [...new Set([...(prior?.contextIds ?? []), ...participant.contextIds])],
      });
    }
    for (const row of replaced) sessions.delete(row.id);
    const participations = [...participants.values()].sort(
      (a, b) => (runOrder.get(a.runId) ?? 0) - (runOrder.get(b.runId) ?? 0),
    );
    sessions.set(id, {
      id,
      runIds: participations.map((row) => row.runId),
      participations,
      usage: sessionUsageKey(usage)
        ? mergedRows[mergedRows.findIndex((row) => sessionUsageKey(row) === id)]
        : usage,
    });
  };
  const rows = [...inventory].flatMap(([run, rows]) =>
    rows.map((usage, index) => ({ run, usage, index })),
  );
  // Feed reservations before confirmations so a later unmeasured role cannot re-add a placeholder.
  rows.sort(
    (a, b) =>
      Number(!(a.usage.nativeSession && !a.usage.runnerSessionId)) -
      Number(!(b.usage.nativeSession && !b.usage.runnerSessionId)),
  );
  for (const { run, usage, index } of rows) {
    add(run, usage, `receipt:${index}`);
  }
  const canonical = familySessionUsageContributions(ordered, (run) => inventory.get(run)!);
  const contributions = ordered.flatMap((run) =>
    (canonical.get(run.id) ?? []).map((usage) => ({
      runId: run.id,
      sessionId: sessionUsageKey(usage),
      usage,
    })),
  );

  const rounds = [...inventory].flatMap(([run, rows]) => {
    const bySession = new Map<string, RunnerSessionUsage>();
    const byContext = new Map<string, RunnerSessionUsage[]>();
    for (const usage of rows) {
      if (usage.runId && usage.runId !== run.id) continue;
      const key = sessionUsageKey(usage);
      if (key) bySession.set(key, usage);
      for (const contextId of usage.contextIds ?? []) {
        const candidates = byContext.get(contextId) ?? [];
        candidates.push(usage);
        byContext.set(contextId, candidates);
      }
    }
    // The display inventory also folds gate summaries and context placeholders into
    // its rows. Their associations cannot qualify a recovered measurement by themselves.
    const capturedBySession = new Map<string, RunnerSessionUsage>();
    for (const usage of run.sessionUsage ?? []) {
      if (usage.runId && usage.runId !== run.id) continue;
      const key = sessionUsageKey(usage);
      if (!key) continue;
      const existing = capturedBySession.get(key);
      capturedBySession.set(key, existing ? preferRunUsageReceipt(existing, usage) : usage);
    }
    return reviewHistoryView(run).cards.map(({ round, fixes }) => {
      const context = run.agentContexts?.find((row) => row.id === round.key);
      const resolved = resolveNativeContext(run, context);
      const owner = resolved?.owner ?? context;
      const ownerReceipt =
        owner && (!context?.nativeSessionOwner || resolved)
          ? contextSessionReceipt(
              run,
              { ...owner, nativeSession: resolved?.binding ?? owner.nativeSession },
              run.updatedAt,
            )
          : null;
      const followsOwner = (usage: RunnerSessionUsage): boolean => {
        if (!context) return true;
        const key = sessionUsageKey(usage);
        if (!ownerReceipt || !key) return false;
        const matched = upsertSessionUsage([ownerReceipt], usage, 'session');
        return matched.length === 1 && sessionUsageKey(matched[0]) === key;
      };

      const recorded = round.usage;
      const recordedSession = recorded && sessionUsageKey(recorded);
      const traceSession = round.sessionIdentity && sessionUsageKey(round.sessionIdentity);
      const scopedSession = recordedSession || traceSession;
      const associated =
        recorded && scopedSession
          ? (capturedBySession.get(scopedSession) ??
            (ownerReceipt && sessionUsageKey(ownerReceipt) === scopedSession
              ? ownerReceipt
              : undefined))
          : scopedSession
            ? bySession.get(scopedSession)
            : byContext.get(round.key)?.filter(followsOwner);
      let recovered = Array.isArray(associated)
        ? associated.length === 1
          ? associated[0]
          : undefined
        : associated;
      // A pending native reservation can acquire its exact conversation identity from
      // the Family session table. Only a session-total receipt can follow that promotion.
      if (
        !recorded &&
        !recovered?.runnerSessionId &&
        !scopedSession &&
        ownerReceipt?.nativeSession &&
        !ownerReceipt.runnerSessionId
      ) {
        const promoted = [...sessions.values()].filter(
          (session) =>
            session.usage.scope !== 'run-delta' &&
            session.usage.runnerSessionId &&
            session.participations.some(
              (participant) =>
                participant.runId === run.id && participant.contextIds.includes(round.key),
            ) &&
            followsOwner(session.usage),
        );
        if (promoted.length === 1) recovered = promoted[0].usage;
      }
      const exactRecovery =
        !recorded ||
        recorded.source === 'unavailable' ||
        Boolean(recorded.error) ||
        (recovered?.contextIds?.includes(round.key) &&
          (recorded.scope === 'run-delta' || recovered.measuredAt <= recorded.measuredAt));
      const source =
        recorded &&
        recovered &&
        exactRecovery &&
        sameReviewUsageWindow(recorded, recovered, round.key) &&
        (recorded.source === 'unavailable' ||
          recorded.error ||
          (recorded.scope ?? 'session-total') === (recovered.scope ?? 'session-total'))
          ? preferRunUsageReceipt(recorded, recovered)
          : (recorded ?? recovered);
      const usage = source ? { ...source, runner: source.runner ?? round.runner } : undefined;
      return {
        id: JSON.stringify([run.id, round.key]),
        runId: run.id,
        reviewId: round.reviewId,
        roundNumber: round.roundNumber,
        runner: round.runner,
        model: round.model,
        review: { startedAt: round.startedAt, completedAt: round.completedAt },
        fixes: fixes.map((fix) => ({ startedAt: fix.startedAt, completedAt: fix.completedAt })),
        usage,
        usageOrigin:
          recorded && source === recorded
            ? ('round-receipt' as const)
            : usage
              ? ('associated-session' as const)
              : ('unavailable' as const),
      };
    });
  });
  const roundCounts = new Map<string, number>();
  for (const round of rounds) {
    const key = round.usage ? sessionUsageKey(round.usage) : null;
    if (key) roundCounts.set(key, (roundCounts.get(key) ?? 0) + 1);
  }
  return {
    sessions: [...sessions.values()],
    contributions,
    runCoverage: [...inventory].map(([run, rows]) => ({
      runId: run.id,
      receipts: rows.length,
      tokenCaptures: rows.filter(
        (row) => row.source !== 'unavailable' && !row.error && row.totalTokens != null,
      ).length,
      costCaptures: rows.filter(
        (row) =>
          row.source !== 'unavailable' &&
          !row.error &&
          row.costUsd != null &&
          row.costStatus !== 'unpriced',
      ).length,
    })),
    rounds: rounds.map((round) => {
      const usage = round.usage;
      const key = usage ? sessionUsageKey(usage) : null;
      const retained = key ? sessions.get(key)?.usage : undefined;
      const participation = key ? (sessions.get(key)?.participations ?? []) : [];
      const shared =
        !!key &&
        ((roundCounts.get(key) ?? 0) > 1 ||
          (key ? (sessions.get(key)?.runIds.length ?? 0) : 0) > 1 ||
          (retained?.contextIds?.length ?? 0) > 1 ||
          participation.some(
            (row) => row.contextIds.length > 1 || row.roles.some((role) => role !== 'review'),
          ) ||
          retained?.roles?.some((role) => role !== 'review') === true);
      return {
        ...round,
        costScope:
          !usage ||
          usage.source === 'unavailable' ||
          usage.error ||
          (usage.totalTokens == null && (usage.costUsd == null || usage.costStatus === 'unpriced'))
            ? 'unavailable'
            : shared ||
                !key ||
                sessionUsageIncludesPriorRun(usage) ||
                sessionUsageIncludesPriorRun(retained)
              ? 'shared-session'
              : 'session-total',
      };
    }),
  };
}
