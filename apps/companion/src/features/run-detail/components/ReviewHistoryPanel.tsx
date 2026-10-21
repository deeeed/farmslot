import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { type ReviewChainEntry, type Run } from '@farmslot/protocol';
import { type ReviewHistoryCheck, type ReviewHistoryRound } from '@farmslot/review-dispatch';

import { MobileDiffViewer } from '../../../components/MobileDiffViewer';
import { colors, fonts, radii, spacing } from '../../../lib/theme';
import { formatPreciseDuration } from '../../workspace-shared/format';
import { useReviewHistory } from '../use-review-history';

function ReviewAttemptCard({
  round,
  defaultExpanded,
  onOpenArtifact,
}: {
  round: ReviewHistoryRound;
  defaultExpanded: boolean;
  onOpenArtifact: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const passed = round.verdict === 'pass';
  return (
    <View style={styles.attempt}>
      <Pressable style={styles.attemptSummary} onPress={() => setExpanded((value) => !value)}>
        <View style={styles.grow}>
          <Text style={styles.attemptTitle}>Review round {round.loopNumber}</Text>
          <Text style={styles.meta}>
            {round.runner} / {round.model} · {round.modeLabel}
          </Text>
          <Text style={styles.meta}>
            {round.reviewRange} · {round.validationDepth}
            {round.durationMs !== null ? ` · ${formatPreciseDuration(round.durationMs)}` : ''}
          </Text>
        </View>
        <View style={styles.outcome}>
          <Text style={[styles.verdict, passed ? styles.passed : styles.issues]}>
            {round.verdict}
          </Text>
          <Text style={styles.findingCount}>{round.unresolvedLabel}</Text>
        </View>
        <Text style={styles.expand}>{expanded ? '−' : '+'}</Text>
      </Pressable>
      {expanded ? (
        <View style={styles.roundDetails}>
          <Text style={styles.meta}>Started {round.startedAt ?? 'not recorded'}</Text>
          {round.earlierAttempts.map((attempt, index) => (
            <Text key={index} style={styles.meta}>
              Earlier attempt: {attempt.status} · {attempt.startedAt ?? 'start not recorded'} ·{' '}
              {attempt.durationMs !== null
                ? formatPreciseDuration(attempt.durationMs)
                : 'duration not recorded'}
            </Text>
          ))}
          {round.hasFix ? (
            <>
              <Text style={styles.fixStat}>
                Fix before round {round.loopNumber}: {round.fixRange ?? 'SHA not recorded'}
              </Text>
              <Text style={styles.meta}>
                {round.fixStat ?? 'Diffstat not recorded'} ·{' '}
                {round.fixDurationMs !== null
                  ? formatPreciseDuration(round.fixDurationMs)
                  : 'Fix duration not recorded'}
              </Text>
              <Text style={styles.meta}>Resolved findings: {round.resolution}</Text>
            </>
          ) : null}
          {round.fixRunning ? (
            <Text style={styles.pending}>
              Worker fixing findings · started {round.activeFixStartedAt ?? 'not recorded'}
            </Text>
          ) : null}
          <Text style={styles.meta}>{round.findingsLabel}</Text>
          {round.timing.length ? (
            <View style={styles.timing}>
              <Text style={styles.timingTitle}>Checklist timing · {round.timing.length} steps</Text>
              {round.timing.map((step) => (
                <View key={`${step.stepNumber}:${step.label}`} style={styles.timingRow}>
                  <Text style={styles.timingStep}>{step.stepNumber}</Text>
                  <Text style={styles.timingLabel}>{step.label}</Text>
                  <Text style={styles.timingDuration}>
                    {formatPreciseDuration(step.durationMs)}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}
          {round.findings.map((issue, index) => (
            <View key={`${issue.file}:${issue.line}:${index}`} style={styles.finding}>
              <Text style={styles.findingLocation}>
                {issue.file}
                {issue.line ? `:${issue.line}` : ''} · {issue.severity}
              </Text>
              <Text style={styles.issue}>{issue.title}</Text>
              {issue.details ? <Text style={styles.meta}>{issue.details}</Text> : null}
            </View>
          ))}
          {round.unavailable.length ? (
            <Text style={styles.stale}>
              Some history artifacts are unavailable. Refresh history to try again.
            </Text>
          ) : null}
          {round.fixDiffText ? (
            <MobileDiffViewer
              title={`Changed files before round ${round.loopNumber}`}
              diffText={round.fixDiffText}
              maxHeight={240}
            />
          ) : null}
          <View style={styles.actions}>
            {round.diffPath && round.reviewDiffRetained ? (
              <Pressable style={styles.diffButton} onPress={() => onOpenArtifact(round.diffPath!)}>
                <Text style={styles.diffButtonText}>Reviewed diff</Text>
              </Pressable>
            ) : null}
            {round.fixDiffPath && !round.fixDiffText ? (
              <Pressable
                disabled={Boolean(round.fixDiffError)}
                accessibilityHint={round.fixDiffError ?? undefined}
                style={styles.fixButton}
                onPress={() => onOpenArtifact(round.fixDiffPath!)}
              >
                <Text style={styles.fixButtonText}>Changed files and diff</Text>
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
  defaultExpanded,
  onOpenArtifact,
}: {
  review: ReviewHistoryCheck;
  defaultExpanded: boolean;
  onOpenArtifact: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  return (
    <View style={styles.reviewerCard}>
      <Pressable style={styles.reviewSummary} onPress={() => setExpanded((value) => !value)}>
        <View style={styles.reviewNumber}>
          <Text style={styles.reviewNumberText}>{review.checkNumber}</Text>
        </View>
        <View style={styles.grow}>
          <Text style={styles.reviewerTitle}>
            {review.runner} / {review.model}
          </Text>
          <Text style={styles.meta}>
            Check {review.checkNumber} · {review.source} · {review.rounds.length} rounds
          </Text>
          <Text style={styles.meta}>
            {review.findingCount} findings across all rounds · {review.unresolvedCount ?? '?'}{' '}
            unresolved
          </Text>
        </View>
        <Text style={[styles.verdict, review.verdict === 'pass' ? styles.passed : styles.issues]}>
          {review.verdict}
        </Text>
        <Text style={styles.expand}>{expanded ? '−' : '+'}</Text>
      </Pressable>
      {expanded ? (
        <View style={styles.reviewDetails}>
          {review.stale ? (
            <Text style={styles.stale}>This review no longer matches the current package.</Text>
          ) : null}
          {review.continuation ? <Text style={styles.pending}>{review.continuation}</Text> : null}
          {review.rounds.map((round, index) => (
            <ReviewAttemptCard
              key={round.key}
              round={round}
              defaultExpanded={round.verdict !== 'pass' && index === review.rounds.length - 1}
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
  const history = useReviewHistory(run, chain);
  if (!history.chain.length && !history.checks.length) return null;
  return (
    <View style={styles.section} testID="run-review-history">
      <View style={styles.header}>
        <Text style={styles.title}>Review history</Text>
        <Pressable style={styles.diffButton} onPress={history.refresh}>
          <Text style={styles.diffButtonText}>Refresh history</Text>
        </Pressable>
        {history.loading ? <Text style={styles.meta}>Loading recorded round details…</Text> : null}
        <Text style={styles.count}>{history.summary}</Text>
      </View>
      {history.chain.length ? (
        <View style={styles.chain}>
          {history.chain.map((entry, index) => (
            <View key={entry.runId} style={styles.generation}>
              <View style={styles.timelineRail}>
                <View
                  style={[
                    styles.timelineDot,
                    entry.unresolvedCount === 0 && styles.timelineDotPassed,
                  ]}
                />
                {index < history.chain.length - 1 ? <View style={styles.timelineLine} /> : null}
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
                  {entry.mode.toUpperCase()} · {entry.validationDepth}
                </Text>
                <Text style={styles.meta}>
                  {entry.range} · {entry.unresolvedCount ?? '?'} unresolved
                </Text>
                <Text style={styles.meta}>session {entry.continuity}</Text>
                {entry.diffPath ? (
                  <Pressable
                    style={styles.diffButton}
                    onPress={() => onOpenArtifact(entry.diffPath!)}
                  >
                    <Text style={styles.diffButtonText}>Open generation diff</Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
          ))}
        </View>
      ) : null}
      {history.checks.map((review, index) => (
        <ReviewCard
          key={review.id}
          review={review}
          defaultExpanded={index === history.checks.length - 1}
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
    minHeight: 44,
    justifyContent: 'center',
    borderColor: colors.accent,
    borderRadius: radii.md,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  diffButtonText: { color: colors.accent, fontSize: fonts.sizeXs, fontWeight: '900' },
  fixButton: {
    minHeight: 44,
    justifyContent: 'center',
    backgroundColor: colors.accent,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  fixButtonText: { color: colors.bgBase, fontSize: fonts.sizeXs, fontWeight: '900' },
});
