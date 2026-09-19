import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { AcceptanceCriterionRef, AcceptanceStatusLedger } from '@farmslot/protocol';

import { acceptanceLedgerView } from '../lib/task-progress-view';
import { baseStyles, colors, fonts, radii, spacing } from '../lib/theme';

/**
 * The run's acceptance ledger (ADR-060 phase 5), read-only and compact: the
 * proven count always visible, the per-criterion rows collapsed until tapped so a
 * long criteria list does not push the checklist off a phone screen.
 *
 * Evidence shows as basenames, not links: the Companion has no artifact viewer, so
 * naming the file is the honest surface. Verdicts are the worker's claim, rendered
 * as recorded.
 */
export function TaskAcceptancePanel({
  acceptanceStatus,
  acceptanceCriteria,
}: {
  acceptanceStatus: AcceptanceStatusLedger | null;
  /** Registered criteria, so one awaiting a verdict still gets a row. */
  acceptanceCriteria?: AcceptanceCriterionRef[] | null;
}) {
  const ledger = acceptanceStatus ?? { schemaVersion: 1 as const, criteria: [] };
  const view = acceptanceLedgerView(ledger, acceptanceCriteria ?? ledger.criteria);
  const [expanded, setExpanded] = React.useState(view.hasOpenCriteria);
  if (view.rows.length === 0) return null;
  return (
    <View style={styles.panel}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Acceptance criteria: ${view.countsLabel}`}
        onPress={() => setExpanded((previous) => !previous)}
        style={styles.header}
      >
        <Text style={styles.caret}>{expanded ? '▾' : '▸'}</Text>
        <Text style={styles.title} numberOfLines={1}>
          Acceptance criteria
        </Text>
        <Text style={styles.counts}>{view.counts}</Text>
      </Pressable>
      {expanded
        ? view.rows.map(({ criterion, verdict, color, evidence }) => (
            <View key={criterion.id} style={styles.row}>
              <View style={styles.rowHeader}>
                <Text style={styles.id}>{criterion.id}</Text>
                <Text style={[styles.pill, { color, borderColor: color }]}>
                  {verdict ?? 'no verdict'}
                </Text>
                {criterion.status?.proofMode ? (
                  <Text style={baseStyles.textMuted}>{criterion.status.proofMode}</Text>
                ) : null}
              </View>
              <Text style={styles.text}>{criterion.text}</Text>
              {evidence.length > 0 ? (
                <Text style={styles.evidence} numberOfLines={1}>
                  {evidence.join(' · ')}
                </Text>
              ) : null}
              {criterion.status?.note ? (
                <Text style={baseStyles.textMuted}>{criterion.status.note}</Text>
              ) : null}
            </View>
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
    color: colors.textSecondary,
    fontSize: fonts.sizeXs,
    fontFamily: fonts.mono,
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
  evidence: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontFamily: fonts.mono,
  },
});
