import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { Run, TaskProgressStructured } from '@farmslot/protocol';

import {
  type TaskProgressFallbackSummary,
  taskProgressPercent,
  taskProgressTitle,
} from '../lib/task-progress';
import { baseStyles, colors, fonts, radii, spacing } from '../lib/theme';

export function TaskProgressPanel({
  run,
  progress,
  error,
  compact,
}: {
  run: Run | null;
  progress: TaskProgressStructured;
  error?: string | null;
  compact?: boolean;
}) {
  const pct = taskProgressPercent(progress);
  return (
    <View style={[styles.card, compact && styles.cardCompact]}>
      <View style={styles.headerRow}>
        <View style={styles.headerTextWrap}>
          <Text style={styles.title}>{taskProgressTitle(run, progress)}</Text>
          <Text style={baseStyles.textMuted} numberOfLines={1}>
            {progress.completedSteps}/{progress.totalSteps}
            {progress.currentPhase ? ` · ${progress.currentPhase}` : ''}
            {progress.currentStep ? ` · ${progress.currentStep}` : ''}
          </Text>
        </View>
        <Text style={styles.percent}>{Math.round(pct)}%</Text>
      </View>
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${pct}%` }]} />
      </View>
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
      {progress.phases.map((phase) => (
        <View key={phase.name} style={styles.phaseCard}>
          <View style={styles.phaseHeader}>
            <Text style={styles.phaseName} numberOfLines={1}>
              {phase.name}
            </Text>
            <Text style={baseStyles.textMuted}>
              {phase.completedSteps}/{phase.totalSteps}
            </Text>
          </View>
          {phase.steps.map((step) => (
            <View key={`${phase.name}-${step.index}`} style={styles.stepRow}>
              <Text style={[styles.stepIcon, { color: statusColor(step.status) }]}>
                {step.status === 'done' ? '✓' : step.status === 'running' ? '▶' : '○'}
              </Text>
              <Text
                style={[styles.stepName, step.status === 'done' && styles.stepNameDone]}
                numberOfLines={1}
              >
                {step.name}
              </Text>
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

export function TaskProgressFallbackPanel({
  summary,
  error,
  compact,
}: {
  summary: TaskProgressFallbackSummary;
  error?: string | null;
  compact?: boolean;
}) {
  const hasPercent = summary.percent != null;
  const displayPercent = summary.percent ?? 14;
  return (
    <View style={[styles.card, styles.fallbackCard, compact && styles.cardCompact]}>
      <View style={styles.headerRow}>
        <View style={styles.headerTextWrap}>
          <Text style={styles.title}>{summary.title}</Text>
          <Text style={baseStyles.textMuted} numberOfLines={1}>
            {summary.meta}
          </Text>
        </View>
        <Text style={styles.percent}>{hasPercent ? `${Math.round(displayPercent)}%` : 'live'}</Text>
      </View>
      <View style={styles.progressTrack}>
        <View
          style={[
            styles.progressFill,
            styles.fallbackProgressFill,
            { width: `${displayPercent}%` },
          ]}
        />
      </View>
      <Text style={styles.fallbackText}>
        Waiting for the structured checklist from the active worker. The slot is still reporting
        active progress.
      </Text>
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
    </View>
  );
}

function statusColor(status: string): string {
  if (status === 'done') return colors.statusOk;
  if (status === 'running') return colors.statusWarn;
  if (status === 'skipped') return colors.textMuted;
  return colors.accent;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.bgCard,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.accent + '44',
    padding: spacing.lg,
    gap: spacing.md,
  },
  cardCompact: {
    padding: spacing.md,
  },
  fallbackCard: {
    borderColor: colors.statusWarn + '55',
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.md,
    alignItems: 'flex-start',
  },
  headerTextWrap: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    color: colors.textPrimary,
    fontSize: fonts.sizeMd,
    fontWeight: '800',
  },
  percent: {
    color: colors.accent,
    fontSize: fonts.sizeSm,
    fontWeight: '800',
    fontFamily: fonts.mono,
  },
  progressTrack: {
    height: 7,
    borderRadius: 999,
    backgroundColor: colors.bgSurface,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: colors.accent,
  },
  fallbackProgressFill: {
    backgroundColor: colors.statusWarn,
  },
  fallbackText: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    lineHeight: 16,
  },
  phaseCard: {
    backgroundColor: colors.bgSurface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.textMuted + '44',
    padding: spacing.md,
    gap: spacing.sm,
  },
  phaseHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  phaseName: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '700',
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  stepIcon: {
    width: 18,
    fontSize: fonts.sizeSm,
    fontWeight: '800',
  },
  stepName: {
    flex: 1,
    minWidth: 0,
    color: colors.textSecondary,
    fontSize: fonts.sizeSm,
  },
  stepNameDone: {
    color: colors.textMuted,
  },
  errorText: {
    color: colors.statusWarn,
    fontSize: fonts.sizeXs,
  },
});
