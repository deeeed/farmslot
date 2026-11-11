import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { type Run, type TaskProgressStructured, viewToggleField } from '@farmslot/protocol';
import {
  type ChecklistPhaseView,
  type ChecklistProgressExecution,
  checklistProgressExecution,
  type ChecklistProgressFallback,
  checklistProgressIsLive,
  checklistProgressView,
  type ChecklistRowView,
  checklistStepDetailKey,
  type ChecklistStepDetailScope,
} from '@farmslot/review-dispatch';

import { activeTaskProgressStepId } from '../lib/task-progress';
import { subtaskBlockKey, taskStepStatusColor } from '../lib/task-progress-view';
import { colors, fonts, radii, spacing } from '../lib/theme';

import { TaskSubtaskBlock } from './TaskSubtaskBlock';
import { useViewChoice } from './view-state';

function ChecklistStepRow({
  row,
  detailScope,
}: {
  row: ChecklistRowView;
  detailScope: ChecklistStepDetailScope;
}) {
  const { step, icon, duration, live } = row;
  const [expanded, setExpanded] = useViewChoice(
    viewToggleField('stepDetails', checklistStepDetailKey(step.index, detailScope), false),
  );
  const content = (
    <>
      {step.detail ? (
        <Text style={styles.caret} accessibilityElementsHidden>
          {expanded ? '▾' : '▸'}
        </Text>
      ) : null}
      <Text style={[styles.stepIcon, { color: taskStepStatusColor(step.status) }]}>{icon}</Text>
      <Text
        style={[
          styles.stepName,
          (step.status === 'done' || step.status === 'skipped') && styles.settledStep,
        ]}
      >
        {step.name}
      </Text>
      {duration ? (
        <Text style={styles.duration} testID={live ? 'checklist-elapsed' : 'checklist-duration'}>
          {duration}
        </Text>
      ) : null}
    </>
  );
  const rowStyle = [styles.step, step.status === 'running' && styles.runningStep];
  return (
    <View>
      {step.detail ? (
        <Pressable
          style={[rowStyle, styles.disclosure]}
          accessibilityRole="button"
          accessibilityLabel={step.name}
          accessibilityHint={expanded ? 'Hides step detail' : 'Shows step detail'}
          accessibilityState={{ expanded }}
          onPress={() => setExpanded((value) => !value)}
        >
          {content}
        </Pressable>
      ) : (
        <View style={rowStyle}>{content}</View>
      )}
      {step.detail && expanded ? <Text style={styles.instructions}>{step.detail}</Text> : null}
    </View>
  );
}

function renderPhases(
  phases: ChecklistPhaseView[],
  runId?: string,
  nested = false,
  nowMs?: number,
  run?: Run | null,
  execution?: ChecklistProgressExecution,
  detailScope: ChecklistStepDetailScope = {},
) {
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
      {phase.rows.map((row) => {
        const { step } = row;
        return (
          <React.Fragment key={`${phase.name}-${row.step.index}`}>
            <ChecklistStepRow row={row} detailScope={detailScope} />
            {step.subtask && !nested ? (
              <TaskSubtaskBlock
                key={subtaskBlockKey(runId, step.subtask.id)}
                runId={runId}
                subtask={step.subtask}
                renderProgress={(progress) =>
                  renderPhases(
                    checklistProgressView(progress, { nowMs, run, execution })?.phases ?? [],
                    undefined,
                    true,
                    nowMs,
                    run,
                    execution,
                    {
                      ...detailScope,
                      checklist: progress.timing?.source,
                      subtaskId: step.subtask?.id,
                    },
                  )
                }
              />
            ) : null}
          </React.Fragment>
        );
      })}
    </View>
  ));
}

/** Native renderer of the same compact checklist view used by Command Center. */
export function TaskProgressPanel({
  run = null,
  progress,
  markdown,
  summary,
  error,
  compact,
}: {
  run?: Run | null;
  progress?: TaskProgressStructured | null;
  markdown?: string;
  summary?: ChecklistProgressFallback;
  error?: string | null;
  compact?: boolean;
}) {
  const [nowMs, setNowMs] = React.useState(Date.now);
  const live = checklistProgressIsLive(progress, run);
  React.useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  const view = checklistProgressView(progress, {
    nowMs,
    run,
    activeStep: activeTaskProgressStepId(run, progress),
    activeTaskBasename: run?.activeTaskFile?.split('/').pop(),
    fallback: summary,
    markdown,
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
      {renderPhases(
        view.phases,
        run?.id,
        false,
        nowMs,
        run,
        checklistProgressExecution(progress, run),
        {
          runId: run?.id,
          checklist: progress?.timing?.source ?? run?.activeTaskFile ?? run?.taskFile,
        },
      )}
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
  disclosure: { minHeight: 44 },
  caret: { width: 10, color: colors.textSecondary, fontFamily: fonts.mono, fontSize: fonts.sizeSm },
  instructions: {
    color: colors.textSecondary,
    fontFamily: fonts.mono,
    fontSize: fonts.sizeSm,
    lineHeight: 18,
    paddingLeft: 40,
    paddingBottom: spacing.md,
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
  duration: {
    fontFamily: fonts.mono,
    fontSize: fonts.sizeSm,
    color: colors.textSecondary,
    fontVariant: ['tabular-nums'],
    lineHeight: 18,
  },
  error: { color: colors.statusWarn, fontSize: fonts.sizeSm, marginBottom: spacing.sm },
  waiting: { color: colors.textSecondary, fontSize: fonts.sizeSm },
});
