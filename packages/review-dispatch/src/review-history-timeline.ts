import { type GitShowParams, type Run } from '@farmslot/protocol';

import type { ReviewHistoryFinding, ReviewHistoryRound } from './review-history.js';

export interface ReviewHistoryFix {
  key: string;
  label: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  running: boolean;
  range: string | null;
  stat: string | null;
  files: string[];
  diffPath: string | null;
  diffText: string | null;
  resolved: ReviewHistoryFinding[];
  reconstructed: boolean;
  diffError: string | null;
  verifiedAt: string | null;
}

export type ReviewHistoryEvent =
  | { kind: 'review'; key: string; at: string | null; round: ReviewHistoryRound }
  | { kind: 'fix'; key: string; roundKey: string; at: string | null; fix: ReviewHistoryFix }
  | { kind: 'gate'; key: string; at: string | null; label: string };

/** A completed result without a start belongs at its completion, never before the first round. */
export function compareReviewHistoryRounds(a: ReviewHistoryRound, b: ReviewHistoryRound): number {
  const time = (round: ReviewHistoryRound) => round.startedAt ?? round.completedAt ?? '\uffff';
  // Recovery attempts can share their start and loop. Keep producer order for that tie.
  return time(a).localeCompare(time(b)) || a.loopNumber - b.loopNumber;
}

/** A replay keeps its own event, even if the engine resets the charged loop number. */
export function reviewHistoryTimeline(
  run: Run,
  rounds: ReviewHistoryRound[],
): ReviewHistoryEvent[] {
  const ordered = [...rounds].sort(compareReviewHistoryRounds);
  const events: ReviewHistoryEvent[] = [];
  const fixes: ReviewHistoryFix[] = [];
  for (const [roundIndex, round] of ordered.entries()) {
    if (round.hasFix) {
      // Artifact hydration may replace a pathname with a Git alias for the same code fix.
      const key =
        round.fixBaseSha && round.fixHeadSha
          ? `${round.reviewId}:fix:${round.fixBaseSha}:${round.fixHeadSha}`
          : (round.fixDiffPath ?? `${round.reviewId}:fix:${round.key}`);
      const previous = ordered.slice(0, roundIndex);
      const prior = previous.filter((entry) => entry.reviewId === round.reviewId);
      const trigger =
        [...previous]
          .reverse()
          .find(
            (entry) =>
              entry.verdict === 'issues' && entry.headSha && entry.headSha === round.fixBaseSha,
          ) ??
        [...prior].reverse().find((entry) => entry.verdict === 'issues') ??
        prior.at(-1) ??
        previous.at(-1);
      let fix = fixes.find((entry) => entry.key === key);
      if (!fix) {
        fix = {
          key,
          label: trigger
            ? `Fix after round ${trigger.roundNumber}`
            : 'Fix before first recorded review',
          startedAt: round.fixStartedAt,
          completedAt: round.fixCompletedAt,
          durationMs: round.fixDurationMs,
          running: false,
          range: round.fixRange,
          stat: round.fixStat,
          files: round.fixFiles,
          diffPath: round.fixDiffPath,
          diffText: round.fixDiffText,
          resolved: [],
          reconstructed: round.fixReconstructed,
          diffError: round.fixDiffError,
          verifiedAt: round.fixReconstructed ? round.startedAt : null,
        };
        fixes.push(fix);
        events.push({
          kind: 'fix',
          key,
          roundKey: trigger?.key ?? round.key,
          at: fix.startedAt ?? fix.completedAt ?? round.startedAt,
          fix,
        });
      }
    }
    events.push({
      kind: 'review',
      key: round.key,
      at: round.startedAt ?? round.completedAt,
      round,
    });
  }
  // Match the same finding across line/severity changes. A different reviewer's omission is
  // not confirmation, and an incomplete/failed result cannot resolve another round's work.
  for (let index = 0; index < ordered.length; index++) {
    const round = ordered[index];
    const prior = ordered.slice(0, index);
    for (const finding of round.findings) {
      if (prior.some((entry) => entry.findings.some((other) => other.id === finding.id))) {
        finding.status = 'still-open';
        finding.statusLabel = 'Carried forward';
      }
      const later = ordered
        .slice(index + 1)
        .find(
          (entry) =>
            entry.reviewId === round.reviewId &&
            entry.runner === round.runner &&
            entry.model === round.model &&
            entry.resultRecorded &&
            ['pass', 'issues'].includes(entry.verdict),
        );
      if (!later || later.findings.some((other) => other.id === finding.id)) continue;
      const fix = fixes
        .filter(
          (entry) =>
            (entry.completedAt ?? entry.verifiedAt) &&
            round.completedAt &&
            later.startedAt &&
            (entry.completedAt ?? entry.verifiedAt ?? '') > round.completedAt &&
            (entry.completedAt ?? entry.verifiedAt ?? '') <= later.startedAt,
        )
        .at(-1);
      if (!fix) continue;
      finding.status = 'resolved';
      finding.resolvedBy = fix.key;
      finding.statusLabel = `Resolved after ${fix.label.toLowerCase()} · not raised in round ${later.roundNumber}`;
      if (!fix.resolved.some((entry) => entry.id === finding.id)) fix.resolved.push(finding);
    }
  }
  for (const round of ordered.filter((entry) => entry.fixRunning)) {
    const fix: ReviewHistoryFix = {
      key: `${round.key}:active-fix`,
      label: `Fix after round ${round.roundNumber}`,
      startedAt: round.activeFixStartedAt,
      completedAt: null,
      durationMs: null,
      running: true,
      range: null,
      stat: null,
      files: [],
      diffPath: null,
      diffText: null,
      resolved: [],
      reconstructed: false,
      diffError: null,
      verifiedAt: null,
    };
    const index = events.findIndex((event) => event.kind === 'review' && event.key === round.key);
    events.splice(index + 1, 0, {
      kind: 'fix',
      key: fix.key,
      roundKey: round.key,
      at: fix.startedAt,
      fix,
    });
  }
  const gate = [...run.decisions]
    .reverse()
    .find(
      (decision) =>
        !decision.resolvedAt && ['ready', 'review'].includes(decision.payload?.kind ?? ''),
    );
  if (gate)
    events.push({
      kind: 'gate',
      key: gate.id,
      at: gate.createdAt,
      label: 'Waiting for your decision',
    });
  return events;
}

/** Both clients open source at the head owned by this round, never the current checkout. */
export function reviewHistorySourceRequest(
  run: Run,
  round: ReviewHistoryRound,
  finding: ReviewHistoryFinding,
): GitShowParams | null {
  if (!round.headSha || !finding.file || !finding.line || !Number.isSafeInteger(finding.line))
    return null;
  return {
    slotId: run.slotId ?? '',
    ...(run.slotId ? {} : { runId: run.id }),
    ref: round.headSha,
    path: finding.file,
  };
}

export interface ReviewHistoryRoundCard {
  round: ReviewHistoryRound;
  fixes: ReviewHistoryFix[];
  totalDurationMs: number | null;
  openFindings: ReviewHistoryFinding[];
}

/** Both clients keep the review and the fixes it triggered inside one stable card. */
export function reviewHistoryRoundCards(events: ReviewHistoryEvent[]): ReviewHistoryRoundCard[] {
  return events.flatMap((event) => {
    if (event.kind !== 'review') return [];
    const fixes = events.flatMap((candidate) =>
      candidate.kind === 'fix' && candidate.roundKey === event.key ? [candidate.fix] : [],
    );
    return [
      {
        round: event.round,
        fixes,
        totalDurationMs:
          event.round.durationMs === null || fixes.some((fix) => fix.durationMs === null)
            ? null
            : event.round.durationMs + fixes.reduce((sum, fix) => sum + (fix.durationMs ?? 0), 0),
        openFindings:
          event.round.unresolvedCount === 0
            ? []
            : event.round.findings.filter(
                (finding) => finding.status !== 'resolved' && finding.status !== 'accepted',
              ),
      },
    ];
  });
}
