import type {
  FamilyObservabilityUsage,
  FamilyUsageParticipation,
  FamilyUsageSession,
  Run,
  RunnerSessionUsage,
} from '@farmslot/protocol';
import { reviewHistoryView } from '@farmslot/review-dispatch';

import { sessionUsageKey, upsertSessionUsage } from '../runtime/agent-session-rows.js';
import {
  allRunSessionUsageReceipts,
  sessionUsageContributions,
} from '../runtime/session-usage-selection.js';

/** Project existing accounting facts. Capture, preference and deltas remain data-owned. */
export function buildFamilyUsage(runs: readonly Run[]): FamilyObservabilityUsage {
  const ordered = [...runs].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  const sessions = new Map<string, FamilyUsageSession>();
  const runOrder = new Map(ordered.map((run, index) => [run.id, index]));
  const histories = ordered.map((run) => ({ run, history: reviewHistoryView(run) }));
  const inventory = ordered.map((run) => ({ run, rows: allRunSessionUsageReceipts(run) }));
  const add = (run: Run, usage: RunnerSessionUsage, fallback: string): void => {
    const runId = run.id;
    const id = sessionUsageKey(usage) ?? JSON.stringify(['unbound', runId, fallback]);
    const before = [...sessions.values()];
    const mergedRows = sessionUsageKey(usage)
      ? upsertSessionUsage(
          before.map((row) => row.usage),
          usage,
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
  const rows = inventory.flatMap(({ run, rows }) =>
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
  const canonical = sessionUsageContributions(ordered);
  const contributions = ordered.flatMap((run) =>
    (canonical.get(run.id) ?? []).map((usage) => ({
      runId: run.id,
      sessionId: sessionUsageKey(usage),
      usage,
    })),
  );

  const rounds = histories.flatMap(({ run, history }) =>
    history.cards.map(({ round, fixes }) => {
      const source =
        round.usage ??
        [...sessions.values()].find((session) =>
          session.participations.some(
            (participant) =>
              participant.runId === run.id && participant.contextIds.includes(round.key),
          ),
        )?.usage;
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
        usageOrigin: round.usage
          ? ('round-receipt' as const)
          : usage
            ? ('associated-session' as const)
            : ('unavailable' as const),
      };
    }),
  );
  const roundCounts = new Map<string, number>();
  for (const round of rounds) {
    const key = round.usage ? sessionUsageKey(round.usage) : null;
    if (key) roundCounts.set(key, (roundCounts.get(key) ?? 0) + 1);
  }
  return {
    sessions: [...sessions.values()],
    contributions,
    runCoverage: inventory.map(({ run, rows }) => ({
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
            : shared || !key
              ? 'shared-session'
              : 'session-total',
      };
    }),
  };
}
