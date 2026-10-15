import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { Run, TaskProgressStructured } from '@farmslot/protocol';
import {
  type ChecklistPhaseView,
  type ChecklistProgressFallback,
  checklistProgressView,
} from '@farmslot/review-dispatch';

import { activeTaskProgressStepId } from '../lib/task-progress';
import { subtaskBlockKey, taskStepStatusColor } from '../lib/task-progress-view';
import { colors, fonts, radii, spacing } from '../lib/theme';

import { TaskSubtaskBlock } from './TaskSubtaskBlock';

function renderPhases(phases: ChecklistPhaseView[], runId?: string, nested = false) {
  return phases.map((phase) => (
    <View key={phase.name} style={styles.phase}>
      <View style={styles.phaseHeader}>
        <Text
          style={[
            styles.phaseName,
            {
              color: phase.running
                ? colors.accent
                : phase.complete
                  ? colors.statusOk
                  : colors.textPrimary,
            },
          ]}
        >
          {phase.name}
        </Text>
        <Text style={styles.phaseCount}>{phase.counts}</Text>
      </View>
      {phase.rows.map(({ step, icon }) => (
        <React.Fragment key={`${phase.name}-${step.index}`}>
          <View style={[styles.step, step.status === 'running' && styles.runningStep]}>
            <Text style={[styles.stepIcon, { color: taskStepStatusColor(step.status) }]}>
              {icon}
            </Text>
            <Text
              style={[
                styles.stepName,
                (step.status === 'done' || step.status === 'skipped') && styles.settledStep,
              ]}
            >
              {step.name}
            </Text>
          </View>
          {step.subtask && !nested ? (
            <TaskSubtaskBlock
              key={subtaskBlockKey(runId, step.subtask.id)}
              subtask={step.subtask}
              renderProgress={renderChildProgress}
            />
          ) : null}
        </React.Fragment>
      ))}
    </View>
  ));
}

function renderChildProgress(progress: TaskProgressStructured) {
  return renderPhases(checklistProgressView(progress)?.phases ?? [], undefined, true);
}

/** Native renderer of the same compact checklist view used by Command Center. */
export function TaskProgressPanel({
  run = null,
  progress,
  summary,
  error,
  compact,
}: {
  run?: Run | null;
  progress?: TaskProgressStructured | null;
  summary?: ChecklistProgressFallback;
  error?: string | null;
  compact?: boolean;
}) {
  const view = checklistProgressView(progress, {
    activeStep: activeTaskProgressStepId(run, progress),
    activeTaskBasename: run?.activeTaskFile?.split('/').pop(),
    fallback: summary,
  });
  if (!view) return null;
  return (
    <View style={[styles.panel, compact && styles.compact]} testID="checklist-progress">
      <Text style={styles.heading}>{view.heading}</Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {view.waiting ? (
        <Text style={styles.waiting}>
          {view.message}
          {'\n'}Waiting for the worker checklist.
        </Text>
      ) : null}
      {renderPhases(view.phases, run?.id)}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { backgroundColor: colors.bgCard, borderRadius: radii.md, padding: spacing.lg },
  compact: { padding: spacing.md },
  heading: {
    fontFamily: fonts.mono,
    fontSize: fonts.sizeSm,
    fontWeight: '600',
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: spacing.sm,
  },
  phase: { marginBottom: spacing.lg },
  phaseHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.sm,
    marginBottom: 2,
  },
  phaseName: { fontFamily: fonts.mono, flex: 1, fontSize: fonts.sizeSm, fontWeight: '600' },
  phaseCount: { fontFamily: fonts.mono, color: colors.textSecondary, fontSize: fonts.sizeSm },
  step: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderLeftWidth: 2,
    borderLeftColor: 'transparent',
  },
  runningStep: {
    borderLeftColor: colors.accent,
    backgroundColor: colors.bgSurface,
    borderRadius: radii.sm,
  },
  stepIcon: { width: 12, textAlign: 'center', fontFamily: fonts.mono, fontSize: fonts.sizeSm },
  stepName: {
    fontFamily: fonts.mono,
    flex: 1,
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    lineHeight: 18,
  },
  settledStep: { color: colors.textSecondary },
  error: { color: colors.statusWarn, fontSize: fonts.sizeSm, marginBottom: spacing.sm },
  waiting: { color: colors.textSecondary, fontSize: fonts.sizeSm },
});
