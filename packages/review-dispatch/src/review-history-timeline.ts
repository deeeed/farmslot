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
  | { kind: 'fix'; key: string; at: string | null; fix: ReviewHistoryFix }
  | { kind: 'gate'; key: string; at: string | null; label: string };

/** A replay keeps its own event, even if the engine resets the charged loop number. */
export function reviewHistoryTimeline(
  run: Run,
  rounds: ReviewHistoryRound[],
): ReviewHistoryEvent[] {
  const ordered = [...rounds].sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''));
  const events: ReviewHistoryEvent[] = [];
  const fixes: ReviewHistoryFix[] = [];
  for (const round of ordered) {
    if (round.hasFix) {
      const key = round.fixDiffPath ?? `${round.reviewId}:fix:${round.key}`;
      let fix = fixes.find((entry) => entry.key === key);
      if (!fix) {
        fix = {
          key,
          label: `Fix before round ${round.roundNumber}`,
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
          at: fix.startedAt ?? fix.completedAt ?? round.startedAt,
          fix,
        });
      }
    }
    events.push({ kind: 'review', key: round.key, at: round.startedAt, round });
  }
  // Match the same finding across line/severity changes. A different reviewer's omission is
  // not confirmation, and an incomplete/failed result cannot resolve another round's work.
  for (let index = 0; index < ordered.length; index++) {
    const round = ordered[index];
    const prior = ordered.slice(0, index);
    for (const finding of round.findings) {
      if (prior.some((entry) => entry.findings.some((other) => other.id === finding.id))) {
        finding.status = 'still-open';
        finding.statusLabel = 'Still open';
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
    events.push({ kind: 'fix', key: fix.key, at: fix.startedAt, fix });
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
  return events.sort(
    (a, b) =>
      (a.at ?? '').localeCompare(b.at ?? '') || (a.kind === b.kind ? 0 : a.kind === 'fix' ? -1 : 1),
  );
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
