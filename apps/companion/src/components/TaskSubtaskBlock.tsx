import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { TaskStepSubtaskProgress } from '@farmslot/protocol';

import { subtaskProgressView, taskStepStatusColor } from '../lib/task-progress-view';
import { baseStyles, colors, fonts, radii, spacing } from '../lib/theme';

/**
 * A child checklist unit under its parent step (ADR-060), read-only. The header
 * always shows source, status and counts; the child's own steps stay collapsed
 * until tapped, so a long child does not push the parent checklist off screen.
 *
 * One level only: child steps render as plain rows and never draw another block,
 * even though the projection nests recursively.
 */
export function TaskSubtaskBlock({ subtask }: { subtask: TaskStepSubtaskProgress }) {
  const [expanded, setExpanded] = React.useState(false);
  const view = subtaskProgressView(subtask);
  return (
    <View
      style={[
        styles.unit,
        { borderLeftColor: view.color },
        subtask.status === 'stale' && styles.unitStale,
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Child unit ${subtask.id}, ${view.statusLabel}, ${view.counts} steps`}
        onPress={() => setExpanded((previous) => !previous)}
        style={styles.header}
      >
        <Text style={styles.caret}>{expanded ? '▾' : '▸'}</Text>
        <Text style={styles.title} numberOfLines={1}>
          {view.title}
        </Text>
        <Text style={[styles.pill, { color: view.color, borderColor: view.color }]}>
          {view.statusLabel}
        </Text>
        <Text style={styles.counts}>{view.counts}</Text>
      </Pressable>
      {view.currentStep ? (
        <Text style={baseStyles.textMuted} numberOfLines={1}>
          {view.currentStep}
        </Text>
      ) : null}
      {view.staleNote ? <Text style={styles.staleNote}>{view.staleNote}</Text> : null}
      {expanded
        ? subtask.progress.phases.map((phase) => (
            <View key={`${subtask.id}-${phase.name}`} style={styles.childPhase}>
              <View style={styles.childPhaseHeader}>
                <Text style={styles.childPhaseName} numberOfLines={1}>
                  {phase.name}
                </Text>
                <Text style={baseStyles.textMuted}>
                  {phase.completedSteps}/{phase.totalSteps}
                </Text>
              </View>
              {phase.steps.map((step) => (
                <View key={`${subtask.id}-${phase.name}-${step.index}`} style={styles.childStepRow}>
                  <Text style={[styles.childStepIcon, { color: taskStepStatusColor(step.status) }]}>
                    {step.status === 'done' ? '✓' : step.status === 'running' ? '▶' : '○'}
                  </Text>
                  <Text style={styles.childStepName} numberOfLines={1}>
                    {step.name}
                  </Text>
                </View>
              ))}
            </View>
          ))
        : null}
    </View>
  );
}

const styles = StyleSheet.create({
  unit: {
    marginLeft: spacing.lg,
    paddingLeft: spacing.md,
    paddingVertical: spacing.xs,
    borderLeftWidth: 2,
    borderRadius: radii.sm,
    backgroundColor: colors.bgCard,
    gap: spacing.xs,
  },
  unitStale: {
    borderStyle: 'dashed',
    opacity: 0.85,
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
  pill: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: spacing.sm,
    fontSize: fonts.sizeXs,
    fontWeight: '700',
  },
  counts: {
    color: colors.textSecondary,
    fontSize: fonts.sizeXs,
    fontFamily: fonts.mono,
  },
  staleNote: {
    color: colors.statusWarn,
    fontSize: fonts.sizeXs,
  },
  childPhase: {
    gap: spacing.xs,
    paddingTop: spacing.xs,
  },
  childPhaseHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  childPhaseName: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: fonts.sizeXs,
    fontWeight: '700',
  },
  childStepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  childStepIcon: {
    width: 14,
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
  },
  childStepName: {
    flex: 1,
    minWidth: 0,
    color: colors.textSecondary,
    fontSize: fonts.sizeXs,
  },
});
