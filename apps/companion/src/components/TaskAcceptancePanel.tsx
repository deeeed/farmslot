import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { EvidenceReviewModel } from '@farmslot/adapter-sdk/evidence';
import type {
  AcceptanceCriterionRef,
  AcceptanceEvidenceLink,
  AcceptanceStatusLedger,
} from '@farmslot/protocol';

import { acceptanceLedgerView } from '../lib/task-progress-view';
import { baseStyles, colors, fonts, radii, spacing } from '../lib/theme';

/**
 * The run's acceptance ledger (ADR-060), read-only and compact: the assessed and
 * proven counts always visible, the per-criterion rows collapsed until tapped so a
 * long criteria list does not push the checklist off a phone screen.
 *
 * With `onOpenEvidence`, each evidence file opens in the artifact viewer. Verdicts
 * are the worker's claim, rendered as recorded.
 */
export function TaskAcceptancePanel({
  acceptanceStatus,
  acceptanceCriteria,
  acceptanceEvidenceLinks,
  error,
  onOpenEvidence,
  evidenceModel,
  showOccurrences,
  onOpenOccurrence,
}: {
  evidenceModel?: EvidenceReviewModel | null;
  showOccurrences?: boolean;
  onOpenOccurrence?: (traceIndex: number) => void;
  acceptanceStatus: AcceptanceStatusLedger | null;
  /** Registered criteria, so one awaiting a verdict still gets a row. */
  acceptanceCriteria?: AcceptanceCriterionRef[] | null;
  /** Manifest-linked evidence for criteria with no recorded verdict. */
  acceptanceEvidenceLinks?: AcceptanceEvidenceLink[] | null;
  /** Why the ledger could not be read; shown instead of an empty panel. */
  error?: string | null;
  onOpenEvidence?: (criterionId: string, path: string) => void;
}) {
  const ledger = acceptanceStatus ?? { schemaVersion: 1 as const, criteria: [] };
  const view = acceptanceLedgerView(
    ledger,
    acceptanceCriteria ?? ledger.criteria,
    acceptanceEvidenceLinks ?? [],
    evidenceModel ?? undefined,
  );
  const [expanded, setExpanded] = React.useState(view.hasOpenCriteria || Boolean(error));
  React.useEffect(() => {
    if (
      error ||
      evidenceModel?.errors.length ||
      evidenceModel?.claims.some((claim) => claim.kind === 'qa-case')
    )
      setExpanded(true);
  }, [error, evidenceModel]);
  if (
    view.rows.length === 0 &&
    !error &&
    !evidenceModel?.errors.length &&
    !evidenceModel?.occurrences.length
  )
    return null;
  return (
    <View style={styles.panel} testID="companion-ac-panel">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Acceptance criteria: ${view.counts}; ${view.countsLabel}`}
        onPress={() => setExpanded((previous) => !previous)}
        style={styles.header}
      >
        <Text style={styles.caret}>{expanded ? '▾' : '▸'}</Text>
        <Text style={styles.title} numberOfLines={1}>
          Acceptance criteria
        </Text>
        <Text
          testID="companion-ac-panel-counts"
          style={[styles.counts, { color: view.countsColor }]}
        >
          {view.counts}
        </Text>
      </Pressable>
      {expanded && error ? <Text style={styles.error}>ledger unreadable: {error}</Text> : null}
      {expanded
        ? evidenceModel?.warnings.map((warning, index) => (
            <Text key={index} style={baseStyles.textMuted}>
              {warning}
            </Text>
          ))
        : null}
      {expanded
        ? evidenceModel?.errors.map((message, index) => (
            <Text key={index} style={styles.error}>
              {message}
            </Text>
          ))
        : null}
      {expanded
        ? view.rows.map(({ criterion, verdict, color, evidence, review }) => (
            <View key={criterion.id} style={styles.row} testID={`companion-ac-row-${criterion.id}`}>
              <View style={styles.rowHeader}>
                <Text style={styles.id}>{criterion.id}</Text>
                <Text style={[styles.pill, { color, borderColor: color }]}>
                  {verdict ?? 'not assessed'}
                </Text>
                {criterion.status?.proofMode ? (
                  <Text style={baseStyles.textMuted}>{criterion.status.proofMode}</Text>
                ) : null}
              </View>
              <Text style={styles.text}>{criterion.text}</Text>
              {review?.timing && review?.timing !== 'measured' ? (
                <Text style={baseStyles.textMuted}>{review?.timing}</Text>
              ) : null}
              {review?.moments.length &&
              evidenceModel &&
              !evidenceModel.errors.length &&
              onOpenEvidence ? (
                <Pressable
                  accessibilityRole="button"
                  testID={`companion-ac-clip-${criterion.id}`}
                  onPress={() => {
                    const selected = evidenceModel.selectClaim(criterion.id);
                    const path = selected?.clips[0]?.videoPath;
                    if (path) onOpenEvidence(criterion.id, evidenceModel.artifactPath(path));
                  }}
                >
                  <Text style={styles.evidence}>Play proof</Text>
                </Pressable>
              ) : null}
              {review?.occurrences.map((occurrence) => (
                <View key={occurrence.traceIndex}>
                  <Text style={styles.text}>{occurrence.intent}</Text>
                  {occurrence.expectation ? (
                    <Text style={baseStyles.textMuted}>
                      {JSON.stringify(occurrence.expectation)}
                    </Text>
                  ) : null}
                </View>
              ))}
              {evidence.length > 0 && onOpenEvidence ? (
                <View style={styles.evidenceList}>
                  {evidence.map((entry, index) => (
                    <Pressable
                      key={entry.path}
                      accessibilityRole="button"
                      accessibilityLabel={`Open ${entry.name} evidence for ${criterion.id}`}
                      testID={`companion-ac-evidence-${criterion.id}-${index}`}
                      onPress={() => onOpenEvidence(criterion.id, entry.path)}
                      style={({ pressed }) => [styles.evidenceChip, pressed && styles.pressed]}
                    >
                      <Text style={styles.evidence} numberOfLines={1}>
                        {entry.name} ›
                      </Text>
                    </Pressable>
                  ))}
                </View>
              ) : evidence.length > 0 ? (
                <Text style={styles.evidence} numberOfLines={1}>
                  {evidence.map((entry) => entry.name).join(' · ')}
                </Text>
              ) : null}
              {criterion.status?.note ? (
                <Text style={baseStyles.textMuted}>{criterion.status.note}</Text>
              ) : null}
            </View>
          ))
        : null}
      {expanded && showOccurrences
        ? evidenceModel?.occurrences.map((occurrence) => (
            <Pressable
              key={occurrence.traceIndex}
              accessibilityRole="button"
              testID={`companion-proof-step-${occurrence.traceIndex}`}
              onPress={() => onOpenOccurrence?.(occurrence.traceIndex)}
            >
              <Text style={styles.evidence}>
                {occurrence.nodeId}: {occurrence.intent} · {occurrence.ok ? 'pass' : 'fail'}
              </Text>
            </Pressable>
          ))
        : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    marginTop: spacing.sm,
    padding: spacing.md,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.bgCardHover,
    backgroundColor: colors.bgSurface,
    gap: spacing.xs,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  caret: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
  },
  title: {
    flex: 1,
    minWidth: 0,
    color: colors.textPrimary,
    fontSize: fonts.sizeXs,
    fontWeight: '700',
  },
  counts: {
    fontSize: fonts.sizeXs,
    fontFamily: fonts.mono,
    fontWeight: '700',
  },
  row: {
    gap: 2,
    paddingTop: spacing.xs,
  },
  rowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  id: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontFamily: fonts.mono,
  },
  pill: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: spacing.sm,
    fontSize: fonts.sizeXs,
    fontWeight: '700',
  },
  text: {
    color: colors.textSecondary,
    fontSize: fonts.sizeXs,
  },
  error: {
    color: colors.statusFail,
    fontSize: fonts.sizeXs,
    fontFamily: fonts.mono,
  },
  evidence: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontFamily: fonts.mono,
  },
  evidenceList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  evidenceChip: {
    maxWidth: '100%',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.accent + '66',
  },
  pressed: {
    opacity: 0.6,
  },
});
