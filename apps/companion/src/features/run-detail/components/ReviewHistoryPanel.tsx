import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import {
  deriveChecklistStepDurations,
  type IndependentReviewAttempt,
  type IndependentReviewStatus,
  observedReviewSessionContinuity,
  type ReadyGatePayload,
  type ReviewChainEntry,
  type Run,
} from '@farmslot/protocol';

import { colors, fonts, radii, spacing } from '../../../lib/theme';

function latestReadyReviews(run: Run): IndependentReviewStatus[] {
  for (let index = run.decisions.length - 1; index >= 0; index -= 1) {
    const payload = run.decisions[index]?.payload;
    if (payload?.kind === 'ready') return (payload as ReadyGatePayload).independentReviews ?? [];
  }
  return [];
}

function shaRange(attempt: IndependentReviewAttempt): string {
  const snapshot = attempt.reviewSnapshot;
  const base = snapshot?.baseSha?.slice(0, 7);
  const head = snapshot?.headSha?.slice(0, 7);
  return base || head ? `${base ?? '?'} → ${head ?? '?'}` : 'SHA unavailable';
}

function stat(attempt: IndependentReviewAttempt): string | null {
  const delta = attempt.fixDelta;
  const diff = delta?.diffStat;
  if (!diff) return null;
  const untracked = delta.untrackedFiles?.length ?? 0;
  const tracked = Math.max(0, diff.files - untracked);
  const paths = untracked
    ? `${tracked} tracked + ${untracked} untracked`
    : `${diff.files} file${diff.files === 1 ? '' : 's'}`;
  return `${paths} · +${diff.additions} −${diff.deletions}`;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function totalDuration(attempt: IndependentReviewAttempt): string | null {
  if (!attempt.startedAt || !attempt.completedAt) return null;
  const durationMs = Date.parse(attempt.completedAt) - Date.parse(attempt.startedAt);
  return Number.isFinite(durationMs) && durationMs >= 0 ? formatDuration(durationMs) : null;
}

function reviewSource(review: IndependentReviewStatus): string {
  if (review.source === 'self-review') return 'Self-review';
  if (review.source === 'human-gate') return 'Independent review (requested)';
  return 'Independent review';
}

function ReviewAttemptCard({
  attempt,
  attemptIndex,
  defaultExpanded,
  feedbackSent,
  onOpenArtifact,
}: {
  attempt: IndependentReviewAttempt;
  attemptIndex: number;
  defaultExpanded: boolean;
  feedbackSent: boolean;
  onOpenArtifact: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const findings = attempt.issues ?? [];
  const passed = attempt.verdict === 'pass';
  const findingLabel = `${findings.length} finding${findings.length === 1 ? '' : 's'}`;
  const timing = deriveChecklistStepDurations(attempt.checklistTiming, attempt.startedAt);
  const elapsed = totalDuration(attempt);

  return (
    <View style={styles.attempt}>
      <Pressable style={styles.attemptSummary} onPress={() => setExpanded((value) => !value)}>
        <View style={styles.grow}>
          <Text style={styles.attemptTitle}>Review round {attemptIndex + 1}</Text>
          <Text style={styles.meta}>
            {shaRange(attempt)} · {attempt.validationDepth || 'static-code'}
            {elapsed ? ` · ${elapsed}` : ''}
          </Text>
        </View>
        <View style={styles.outcome}>
          <Text style={[styles.verdict, passed ? styles.passed : styles.issues]}>
            {attempt.verdict}
          </Text>
          <Text style={styles.findingCount}>
            {findingLabel} · {attempt.unresolvedCount} unresolved
          </Text>
        </View>
        <Text style={styles.expand}>{expanded ? '−' : '+'}</Text>
      </Pressable>

      {expanded ? (
        <View style={styles.roundDetails}>
          <Text style={passed ? styles.roundPassed : styles.roundIssues}>
            {passed
              ? 'No unresolved findings in this round.'
              : `${findingLabel} recorded${feedbackSent ? ' and sent to the worker' : ''}.`}
          </Text>
          {attemptIndex > 0 && stat(attempt) ? (
            <Text style={styles.fixStat}>
              Fix after review round {attemptIndex}: {stat(attempt)}
            </Text>
          ) : null}
          {timing.length ? (
            <View style={styles.timing}>
              <Text style={styles.timingTitle}>Checklist timing · {timing.length} steps</Text>
              {timing.map((step) => (
                <View key={`${step.stepNumber}:${step.label}`} style={styles.timingRow}>
                  <Text style={styles.timingStep}>{step.stepNumber}</Text>
                  <Text style={styles.timingLabel}>{step.label}</Text>
                  <Text style={styles.timingDuration}>{formatDuration(step.durationMs)}</Text>
                </View>
              ))}
            </View>
          ) : null}
          {findings.map((issue, issueIndex) => (
            <View key={`${issue.file}:${issue.line ?? ''}:${issueIndex}`} style={styles.finding}>
              <Text style={styles.findingLocation}>
                {issue.file || 'General finding'}
                {issue.line ? `:${issue.line}` : ''}
              </Text>
              <Text style={styles.issue}>{issue.description}</Text>
            </View>
          ))}
          <View style={styles.actions}>
            {attempt.reviewSnapshot?.diffPath ? (
              <Pressable
                style={styles.diffButton}
                onPress={() => onOpenArtifact(attempt.reviewSnapshot!.diffPath!)}
              >
                <Text style={styles.diffButtonText}>Reviewed diff</Text>
              </Pressable>
            ) : null}
            {attempt.fixDelta?.diffPath ? (
              <Pressable
                style={styles.fixButton}
                onPress={() => onOpenArtifact(attempt.fixDelta!.diffPath!)}
              >
                <Text style={styles.fixButtonText}>Changes since prior round</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : null}
    </View>
  );
}

function ReviewCard({
  review,
  reviewIndex,
  defaultExpanded,
  continuationActive,
  reviewerActive,
  onOpenArtifact,
}: {
  review: IndependentReviewStatus;
  reviewIndex: number;
  defaultExpanded: boolean;
  continuationActive: boolean;
  reviewerActive: boolean;
  onOpenArtifact: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const attempts = review.attempts?.length
    ? review.attempts
    : ([review] as IndependentReviewAttempt[]);
  const findingCount = attempts.reduce(
    (total, attempt) => total + (attempt.issues?.length ?? 0),
    0,
  );
  const passed = review.verdict === 'pass';
  const pendingContinuation =
    review.recoveryContinuationPending === true &&
    (attempts.at(-1)?.unresolvedCount ?? review.unresolvedCount) > 0;

  return (
    <View style={styles.reviewerCard}>
      <Pressable style={styles.reviewSummary} onPress={() => setExpanded((value) => !value)}>
        <View style={styles.reviewNumber}>
          <Text style={styles.reviewNumberText}>{reviewIndex + 1}</Text>
        </View>
        <View style={styles.grow}>
          <Text style={styles.reviewerTitle}>
            {review.runner || 'Unknown runner'} / {review.model || 'default'}
          </Text>
          <Text style={styles.meta}>
            Check {reviewIndex + 1} · {reviewSource(review)} · {attempts.length} round
            {attempts.length === 1 ? '' : 's'}
          </Text>
          <Text style={styles.meta}>
            {findingCount} finding{findingCount === 1 ? '' : 's'} across all rounds
          </Text>
        </View>
        <View style={styles.outcome}>
          <Text style={[styles.verdict, passed ? styles.passed : styles.issues]}>
            {review.verdict}
          </Text>
          <Text style={styles.findingCount}>{review.unresolvedCount} unresolved</Text>
        </View>
        <Text style={styles.expand}>{expanded ? '−' : '+'}</Text>
      </Pressable>
      {expanded ? (
        <View style={styles.reviewDetails}>
          {review.stale ? (
            <Text style={styles.stale}>This review no longer matches the current package.</Text>
          ) : null}
          {pendingContinuation ? (
            <Text style={styles.pending}>
              {reviewerActive
                ? 'The worker fix is complete; the next review round is running.'
                : continuationActive
                  ? `Worker is fixing the latest ${review.unresolvedCount} finding${review.unresolvedCount === 1 ? '' : 's'}.`
                  : `Stopped after the retry limit: the latest ${review.unresolvedCount} finding${review.unresolvedCount === 1 ? '' : 's'} still need delivery to the worker.`}
            </Text>
          ) : null}
          {attempts.map((attempt, attemptIndex) => (
            <ReviewAttemptCard
              key={`${review.id}:${attempt.loopNumber}:${attemptIndex}`}
              attempt={attempt}
              attemptIndex={attemptIndex}
              defaultExpanded={attempt.verdict !== 'pass' && attemptIndex === attempts.length - 1}
              feedbackSent={attemptIndex < attempts.length - 1 || review.feedbackSent === true}
              onOpenArtifact={onOpenArtifact}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

export function ReviewHistoryPanel({
  run,
  chain,
  onOpenArtifact,
}: {
  run: Run;
  chain: ReviewChainEntry[];
  onOpenArtifact: (path: string) => void;
}) {
  const reviews = latestReadyReviews(run);
  if (chain.length === 0 && reviews.length === 0) return null;
  const attemptCount = reviews.reduce((total, review) => total + (review.attempts?.length || 1), 0);
  const continuationActive = (run.agentContexts ?? []).some(
    (context) =>
      context.role === 'self-review-fix' &&
      ['launching', 'working', 'waiting'].includes(context.status),
  );

  return (
    <View style={styles.section}>
      <View style={styles.header}>
        <Text style={styles.title}>Review history</Text>
        <Text style={styles.count}>
          {chain.length ? `${chain.length} diff generation${chain.length === 1 ? '' : 's'} · ` : ''}
          {reviews.length} review check{reviews.length === 1 ? '' : 's'} · {attemptCount} round
          {attemptCount === 1 ? '' : 's'}
        </Text>
      </View>

      {chain.length ? (
        <View style={styles.chain}>
          {chain.map((entry, index) => {
            const diffPath = entry.artifactRefs.find((artifact) =>
              artifact.path.endsWith('.diff'),
            )?.path;
            return (
              <View key={entry.runId} style={styles.generation}>
                <View style={styles.timelineRail}>
                  <View
                    style={[
                      styles.timelineDot,
                      entry.unresolvedCount === 0 && styles.timelineDotPassed,
                    ]}
                  />
                  {index < chain.length - 1 ? <View style={styles.timelineLine} /> : null}
                </View>
                <View style={styles.generationBody}>
                  <View style={styles.row}>
                    <Text style={styles.generationTitle}>Generation {entry.generation}</Text>
                    <Text
                      style={[
                        styles.verdict,
                        entry.unresolvedCount === 0 ? styles.passed : styles.issues,
                      ]}
                    >
                      {entry.verdict}
                    </Text>
                  </View>
                  <Text style={styles.meta}>
                    {entry.runner || 'unknown runner'} / {entry.model || 'default'} ·{' '}
                    {entry.reviewScope} · {entry.validationDepth}
                  </Text>
                  <Text style={styles.meta}>
                    {entry.baseSha?.slice(0, 7) ?? '?'} → {entry.headSha?.slice(0, 7) ?? '?'} ·{' '}
                    {entry.unresolvedCount ?? '?'} unresolved
                  </Text>
                  <Text style={styles.meta}>session {observedReviewSessionContinuity(entry)}</Text>
                  {diffPath ? (
                    <Pressable style={styles.diffButton} onPress={() => onOpenArtifact(diffPath)}>
                      <Text style={styles.diffButtonText}>Open generation diff</Text>
                    </Pressable>
                  ) : null}
                </View>
              </View>
            );
          })}
        </View>
      ) : null}

      {reviews.map((review, reviewIndex) => (
        <ReviewCard
          key={review.id}
          review={review}
          reviewIndex={reviewIndex}
          defaultExpanded={review.verdict !== 'pass' && reviewIndex === reviews.length - 1}
          continuationActive={continuationActive}
          reviewerActive={(run.agentContexts ?? []).some(
            (context) =>
              context.role === 'self-review' &&
              ['launching', 'working', 'waiting'].includes(context.status) &&
              context.artifactScope === review.id,
          )}
          onOpenArtifact={onOpenArtifact}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    backgroundColor: colors.bgSurface,
    borderRadius: radii.lg,
    gap: spacing.lg,
    padding: spacing.lg,
  },
  header: { gap: spacing.xs },
  title: { color: colors.textPrimary, fontSize: fonts.sizeMd, fontWeight: '900' },
  count: { color: colors.textMuted, fontSize: fonts.sizeXs },
  chain: { gap: 0 },
  generation: { flexDirection: 'row', gap: spacing.md },
  timelineRail: { alignItems: 'center', width: 14 },
  timelineDot: {
    backgroundColor: colors.statusWarn,
    borderRadius: 999,
    height: 10,
    marginTop: spacing.sm,
    width: 10,
  },
  timelineDotPassed: { backgroundColor: colors.statusOk },
  timelineLine: {
    backgroundColor: colors.bgCardHover,
    flex: 1,
    marginVertical: spacing.xs,
    width: 2,
  },
  generationBody: { flex: 1, gap: spacing.sm, paddingBottom: spacing.lg },
  generationTitle: {
    color: colors.textPrimary,
    flex: 1,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
  },
  row: { alignItems: 'center', flexDirection: 'row', gap: spacing.md },
  verdict: { fontFamily: fonts.mono, fontSize: fonts.sizeXs, fontWeight: '900' },
  passed: { color: colors.statusOk },
  issues: { color: colors.statusWarn },
  meta: { color: colors.textMuted, fontSize: fonts.sizeXs, lineHeight: 16 },
  reviewerCard: { backgroundColor: colors.bgCard, borderRadius: radii.md, padding: spacing.md },
  reviewSummary: { alignItems: 'center', flexDirection: 'row', gap: spacing.md },
  reviewNumber: {
    alignItems: 'center',
    backgroundColor: colors.bgSurface,
    borderRadius: 999,
    height: 28,
    justifyContent: 'center',
    width: 28,
  },
  reviewNumberText: {
    color: colors.accent,
    fontFamily: fonts.mono,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  reviewerTitle: { color: colors.textPrimary, fontSize: fonts.sizeSm, fontWeight: '900' },
  reviewDetails: { gap: spacing.md, paddingTop: spacing.sm },
  stale: { color: colors.statusWarn, fontSize: fonts.sizeXs, fontWeight: '800' },
  pending: {
    backgroundColor: colors.bgSurface,
    borderColor: colors.statusWarn,
    borderRadius: radii.md,
    borderWidth: 1,
    color: colors.statusWarn,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
    padding: spacing.md,
  },
  attempt: {
    borderTopColor: colors.bgCardHover,
    borderTopWidth: 1,
    gap: spacing.sm,
    paddingTop: spacing.md,
  },
  attemptSummary: { alignItems: 'center', flexDirection: 'row', gap: spacing.md },
  grow: { flex: 1, gap: spacing.xs },
  attemptTitle: { color: colors.textSecondary, fontSize: fonts.sizeXs, fontWeight: '900' },
  outcome: { alignItems: 'flex-end', gap: spacing.xs },
  findingCount: { color: colors.textMuted, fontSize: fonts.sizeXs },
  expand: { color: colors.accent, fontSize: fonts.sizeLg, fontWeight: '900', width: 14 },
  roundDetails: { gap: spacing.sm },
  roundPassed: { color: colors.statusOk, fontSize: fonts.sizeXs, fontWeight: '800' },
  roundIssues: { color: colors.statusWarn, fontSize: fonts.sizeXs, fontWeight: '800' },
  fixStat: { color: colors.accent, fontFamily: fonts.mono, fontSize: fonts.sizeXs },
  timing: {
    backgroundColor: colors.bgSurface,
    borderRadius: radii.md,
    gap: spacing.xs,
    padding: spacing.sm,
  },
  timingTitle: { color: colors.textSecondary, fontSize: fonts.sizeXs, fontWeight: '900' },
  timingRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  timingStep: {
    color: colors.textMuted,
    fontFamily: fonts.mono,
    fontSize: fonts.sizeXs,
    width: 20,
  },
  timingLabel: { color: colors.textMuted, flex: 1, fontSize: fonts.sizeXs },
  timingDuration: { color: colors.textSecondary, fontFamily: fonts.mono, fontSize: fonts.sizeXs },
  finding: {
    backgroundColor: colors.bgSurface,
    borderRadius: radii.md,
    gap: spacing.xs,
    padding: spacing.md,
  },
  findingLocation: {
    color: colors.statusWarn,
    fontFamily: fonts.mono,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  issue: { color: colors.textSecondary, fontSize: fonts.sizeXs, lineHeight: 16 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  diffButton: {
    borderColor: colors.accent,
    borderRadius: radii.md,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  diffButtonText: { color: colors.accent, fontSize: fonts.sizeXs, fontWeight: '900' },
  fixButton: {
    backgroundColor: colors.accent,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  fixButtonText: { color: colors.bgBase, fontSize: fonts.sizeXs, fontWeight: '900' },
});
