import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  deriveRunLifecycleView,
  type RunStatus,
  type RunStep,
  runStepDisplayDetail,
  type RunStepDisplayStatus,
  runStepDisplayStatus,
  type WorkerOperatorWait,
} from '@farmslot/protocol';

import { colors, fonts, spacing } from '../lib/theme';

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

export function RunPipelineMini({
  steps,
  runStatus,
  waitingForOperator,
  error,
}: {
  steps: RunStep[];
  runStatus?: RunStatus;
  waitingForOperator?: WorkerOperatorWait;
  error?: string;
}) {
  const isCancelled = runStatus === 'cancelled';
  const visible = steps.filter((s) => s.status !== 'skipped');
  if (visible.length === 0) return null;

  const run = runStatus ? { status: runStatus, steps, error } : undefined;
  const eff = (s: RunStep) => (run ? runStepDisplayStatus(run, s) : s.status);
  const runningIdx = visible.findIndex((s) => eff(s) === 'running');
  const nextIdx = visible.findIndex((s) => eff(s) === 'pending');
  const labelIdx = runningIdx >= 0 ? runningIdx : nextIdx >= 0 ? nextIdx : visible.length - 1;
  const active = visible[labelIdx];
  const remaining = active
    ? visible.slice(labelIdx + 1).filter((s) => eff(s) === 'pending').length
    : 0;
  const allDone = visible.every((s) => eff(s) === 'done');
  const hasFailed = visible.some((s) => eff(s) === 'failed');
  const blocked = visible.find((s) => eff(s) === 'blocked');
  const detail = blocked && run ? runStepDisplayDetail(run, blocked) : active?.detail;
  const duration = active ? stepDuration(active) : null;
  const label = isCancelled
    ? 'cancelled'
    : ((runStatus
        ? deriveRunLifecycleView({ status: runStatus, waitingForOperator, error }).activityLabel
        : undefined) ??
      (allDone
        ? 'done'
        : hasFailed
          ? 'failed'
          : active
            ? `${shortName(active.name)}${duration ? ` · ${duration}` : ''}${remaining > 0 ? ` · +${remaining}` : ''}`
            : ''));

  return (
    <View style={miniStyles.container}>
      <View style={miniStyles.bars}>
        {visible.map((step, i) => {
          const vis = eff(step);
          return (
            <View
              key={`${step.name}-${i}`}
              style={[
                miniStyles.segment,
                { backgroundColor: stepColor(vis) },
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
        {!allDone && !isCancelled && detail && !label.includes(detail) ? (
          <Text style={miniStyles.detail} numberOfLines={2}>
            {detail}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

export function RunPipelineFull({
  steps,
  runStatus,
  onStepPress,
}: {
  steps: RunStep[];
  runStatus?: RunStatus;
  onStepPress?: (stepName: string, index: number) => void;
}) {
  const visible = steps.filter((s) => s.status !== 'skipped');
  if (visible.length === 0) return null;

  const eff = (s: RunStep) =>
    runStatus ? runStepDisplayStatus({ status: runStatus, steps }, s) : s.status;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={fullStyles.scrollContent}
    >
      {visible.map((step, i) => {
        const vis = eff(step);
        const color = stepColor(vis);
        const prevDone = i > 0 && eff(visible[i - 1]) === 'done';
        return (
          <React.Fragment key={`${step.name}-${i}`}>
            {i > 0 && (
              <View style={fullStyles.connectorWrap}>
                <View
                  style={[
                    fullStyles.connector,
                    {
                      backgroundColor: prevDone ? colors.statusOk + '66' : colors.textMuted + '33',
                    },
                  ]}
                />
              </View>
            )}
            <Pressable
              style={fullStyles.stepColumn}
              onPress={onStepPress ? () => onStepPress(step.name, i) : undefined}
            >
              <View
                style={[
                  fullStyles.dot,
                  { backgroundColor: color },
                  (vis === 'pending' || vis === 'skipped') && fullStyles.dotPending,
                  vis === 'running' && fullStyles.dotRunning,
                ]}
              >
                <Text style={fullStyles.dotIcon}>{stepDotIcon(vis)}</Text>
              </View>
              <Text
                style={[
                  fullStyles.stepName,
                  { color: vis === 'pending' || vis === 'skipped' ? colors.textMuted : color },
                ]}
                numberOfLines={1}
              >
                {shortName(step.name)}
              </Text>
              {step.durationMs != null && step.durationMs > 0 ? (
                <Text style={fullStyles.duration}>{formatStepDuration(step.durationMs)}</Text>
              ) : vis === 'running' ? (
                <Text style={[fullStyles.duration, { color: '#3b82f6' }]}>…</Text>
              ) : null}
            </Pressable>
          </React.Fragment>
        );
      })}
    </ScrollView>
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
