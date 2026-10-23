import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {
  deriveRunLifecycleView,
  type Run,
  runElapsedTimeView,
  type RunStep,
  runStepDisplayDetail,
  type RunStepDisplayStatus,
  type TaskProgressStructured,
} from '@farmslot/protocol';
import {
  recoveredReviewFailureColor,
  runActivityStepStatus,
  runActivityView,
  runRecoveredReviewFailures,
} from '@farmslot/review-dispatch';

import { useRunChecklistProgress } from '../hooks/useRunChecklistProgress';
import { colors, fonts, spacing } from '../lib/theme';

import { RunChecklistProgress } from './RunChecklistProgress';

function stepColor(status: RunStepDisplayStatus): string {
  if (status === 'done') return colors.statusOk;
  if (status === 'running') return '#3b82f6';
  if (status === 'failed') return colors.statusFail;
  if (status === 'blocked') return colors.statusWarn;
  if (status === 'skipped') return colors.textMuted;
  return colors.textMuted;
}

function shortName(name: string): string {
  return name
    .replace('human-gate', 'gate')
    .replace('ci-watch', 'CI')
    .replace('find-slot', 'slot')
    .replace('write-task', 'task');
}

function formatStepDuration(ms: number): string {
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return `${Math.round(ms / 1000)}s`;
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h${mins % 60}m`;
}

function stepDuration(step: RunStep): string | null {
  if (step.durationMs != null && step.durationMs > 0) {
    return formatStepDuration(step.durationMs);
  }
  if (step.status !== 'running' || !step.startedAt) return null;
  const startedAt = Date.parse(step.startedAt);
  if (!Number.isFinite(startedAt)) return null;
  return formatStepDuration(Math.max(0, Date.now() - startedAt));
}

function usePipelineClock(running: boolean, intervalMs = 1000) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => tick((value) => value + 1), intervalMs);
    return () => clearInterval(timer);
  }, [running, intervalMs]);
}

export function RunElapsedTime({ run }: { run: Run }) {
  const timing = runElapsedTimeView(run);
  usePipelineClock(timing.live, 60000);
  return (
    <Text
      testID="run-elapsed-time"
      numberOfLines={1}
      style={{ color: colors.textMuted, fontSize: fonts.sizeSm, flexShrink: 1 }}
    >
      {timing.label}
    </Text>
  );
}

export function RunPipelineMini({ run }: { run: Run }) {
  const { steps, status: runStatus } = run;
  const checklist = useRunChecklistProgress(run);
  const activity = runActivityView(run);
  usePipelineClock(Boolean(activity));
  const isCancelled = runStatus === 'cancelled';
  const failures = runRecoveredReviewFailures(run);
  const reasons = new Map(failures.map((step) => [step.name, step.reason]));
  const visible = (activity?.steps ?? steps)
    .filter((s) => s.status !== 'skipped')
    .flatMap((step) => (step.name === 'review' ? [step, ...failures] : [step]));
  if (visible.length === 0) return null;

  const eff = (s: RunStep) => runActivityStepStatus(run, s);
  const runningIdx = visible.findIndex((s) => eff(s) === 'running');
  const nextIdx = visible.findIndex((s) => eff(s) === 'pending');
  const labelIdx = runningIdx >= 0 ? runningIdx : nextIdx >= 0 ? nextIdx : visible.length - 1;
  const active = visible[labelIdx];
  const remaining = active
    ? visible.slice(labelIdx + 1).filter((s) => eff(s) === 'pending').length
    : 0;
  const allDone = visible.every((s) => eff(s) === 'done' || reasons.has(s.name));
  const hasFailed = visible.some((s) => eff(s) === 'failed' && !reasons.has(s.name));
  const blocked = visible.find((s) => eff(s) === 'blocked');
  const shown = blocked ?? active;
  const detail = shown ? runStepDisplayDetail(run, shown) : active?.detail;
  const duration = active ? stepDuration(active) : null;
  const label = isCancelled
    ? 'cancelled'
    : ((activity ? `${activity.label}${duration ? ` · ${duration}` : ''}` : undefined) ??
      deriveRunLifecycleView(run).activityLabel ??
      (allDone
        ? 'done'
        : hasFailed
          ? 'failed'
          : active
            ? `${shortName(active.name)}${duration ? ` · ${duration}` : ''}${remaining > 0 ? ` · +${remaining}` : ''}`
            : ''));

  return (
    <View>
      <View style={miniStyles.container}>
        <View style={miniStyles.bars}>
          {visible.map((step, i) => {
            const vis = eff(step);
            const reason = reasons.get(step.name);
            return (
              <Pressable
                accessibilityLabel={reason ?? step.name}
                accessibilityHint={reason}
                disabled={!reason}
                hitSlop={20}
                onPress={() => reason && Alert.alert('Review attempt recovered', reason)}
                key={`${step.name}-${i}`}
                style={[
                  miniStyles.segment,
                  { backgroundColor: reason ? recoveredReviewFailureColor : stepColor(vis) },
                  vis === 'pending' && miniStyles.segmentPending,
                  vis === 'done' && miniStyles.segmentDone,
                  vis === 'skipped' && miniStyles.segmentPending,
                ]}
              />
            );
          })}
        </View>
        <View style={miniStyles.summary}>
          <Text
            style={[
              miniStyles.label,
              allDone && { color: colors.statusOk },
              // A held run's failed step is what it waits on a person for, not a failure.
              hasFailed && runStatus !== 'needs-decision' && { color: colors.statusFail },
              blocked && { color: colors.statusWarn },
              isCancelled && { color: colors.statusFail },
            ]}
            numberOfLines={1}
          >
            {label}
          </Text>
          {/* A blocked run's label already carries its reason. */}
          {!activity && !allDone && !isCancelled && detail && !label.includes(detail) ? (
            <Text style={miniStyles.detail} numberOfLines={2}>
              {detail}
            </Text>
          ) : null}
        </View>
      </View>
      <RunChecklistProgress run={run} progress={checklist?.progress} error={checklist?.error} />
    </View>
  );
}

export function RunPipelineFull({
  run,
  onStepPress,
  taskProgress,
}: {
  run: Run;
  taskProgress?: TaskProgressStructured | null;
  onStepPress?: (stepName: string, index: number) => void;
}) {
  const { steps } = run;
  const activity = runActivityView(run);
  usePipelineClock(Boolean(activity));
  const visible = (activity?.steps ?? steps).filter((s) => s.status !== 'skipped');
  if (visible.length === 0) return null;

  const eff = (s: RunStep) => runActivityStepStatus(run, s);

  return (
    <View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={fullStyles.scrollContent}
      >
        {visible.map((step, i) => {
          const vis = eff(step);
          const color = stepColor(vis);
          const prevDone = i > 0 && eff(visible[i - 1]) === 'done';
          const ownerName = step.name === activity?.nodeId ? activity.ownerStepName : step.name;
          return (
            <React.Fragment key={`${step.name}-${i}`}>
              {i > 0 && (
                <View style={fullStyles.connectorWrap}>
                  <View
                    style={[
                      fullStyles.connector,
                      {
                        backgroundColor: prevDone
                          ? colors.statusOk + '66'
                          : colors.textMuted + '33',
                      },
                    ]}
                  />
                </View>
              )}
              <Pressable
                style={fullStyles.stepColumn}
                accessibilityLabel={step.name === activity?.nodeId ? activity.label : step.name}
                onPress={
                  onStepPress
                    ? () =>
                        onStepPress(
                          ownerName,
                          steps.findIndex((owner) => owner.name === ownerName),
                        )
                    : undefined
                }
              >
                <View
                  style={[
                    fullStyles.dot,
                    { backgroundColor: color },
                    (vis === 'pending' || vis === 'skipped') && fullStyles.dotPending,
                    vis === 'running' && fullStyles.dotRunning,
                  ]}
                >
                  {vis === 'running' ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={fullStyles.dotIcon}>{stepDotIcon(vis)}</Text>
                  )}
                </View>
                <Text
                  style={[
                    fullStyles.stepName,
                    { color: vis === 'pending' || vis === 'skipped' ? colors.textMuted : color },
                  ]}
                  numberOfLines={1}
                >
                  {step.name === activity?.nodeId ? activity.nodeLabel : shortName(step.name)}
                </Text>
                {stepDuration(step) ? (
                  <Text style={[fullStyles.duration, vis === 'running' && { color: '#3b82f6' }]}>
                    {stepDuration(step)}
                  </Text>
                ) : null}
              </Pressable>
            </React.Fragment>
          );
        })}
      </ScrollView>
      <RunChecklistProgress run={run} progress={taskProgress} />
    </View>
  );
}

function stepDotIcon(status: RunStepDisplayStatus): string {
  if (status === 'done') return '✓';
  if (status === 'running') return '▸';
  if (status === 'failed') return '✗';
  if (status === 'blocked') return '!';
  return '';
}

const MINI_SEGMENT_WIDTH = 14;
const MINI_SEGMENT_HEIGHT = 4;

const miniStyles = StyleSheet.create({
  container: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  bars: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 2,
  },
  segment: {
    borderRadius: 2,
    height: MINI_SEGMENT_HEIGHT,
    width: MINI_SEGMENT_WIDTH,
  },
  segmentPending: {
    opacity: 0.3,
  },
  segmentDone: {
    opacity: 0.85,
  },
  label: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  summary: {
    flex: 1,
    minWidth: 0,
  },
  detail: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    lineHeight: 15,
    marginTop: 2,
  },
});

const DOT_SIZE = 22;

const fullStyles = StyleSheet.create({
  scrollContent: {
    alignItems: 'flex-start',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.md,
  },
  connectorWrap: {
    height: DOT_SIZE,
    justifyContent: 'center',
    width: 12,
  },
  connector: {
    height: 2,
    width: 12,
  },
  stepColumn: {
    alignItems: 'center',
    minWidth: 42,
    paddingHorizontal: spacing.xs,
  },
  dot: {
    alignItems: 'center',
    borderRadius: DOT_SIZE / 2,
    height: DOT_SIZE,
    justifyContent: 'center',
    width: DOT_SIZE,
  },
  dotPending: {
    backgroundColor: 'transparent',
    borderColor: colors.textMuted + '55',
    borderWidth: 1.5,
  },
  dotRunning: {
    borderColor: '#3b82f6',
    borderWidth: 2,
    shadowColor: '#3b82f6',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 4,
  },
  dotIcon: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '900',
  },
  stepName: {
    fontSize: 9,
    fontWeight: '800',
    marginTop: 3,
    textTransform: 'uppercase',
  },
  duration: {
    color: colors.textMuted,
    fontSize: 8,
    fontWeight: '700',
    marginTop: 1,
  },
});
