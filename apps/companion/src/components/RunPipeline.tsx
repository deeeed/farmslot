import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { RunStatus, RunStep, RunStepStatus } from '@farmslot/protocol';

import { colors, fonts, spacing } from '../lib/theme';

function effectiveStatus(stepStatus: RunStepStatus, runStatus?: RunStatus): RunStepStatus {
  if (runStatus === 'cancelled' && (stepStatus === 'running' || stepStatus === 'pending')) {
    return 'skipped';
  }
  return stepStatus;
}

function stepColor(status: RunStepStatus): string {
  if (status === 'done') return colors.statusOk;
  if (status === 'running') return '#3b82f6';
  if (status === 'failed') return colors.statusFail;
  if (status === 'skipped') return colors.textMuted;
  return colors.textMuted;
}

function shortName(name: string): string {
  return name
    .replace('self-review', 'review')
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

export function RunPipelineMini({ steps, runStatus }: { steps: RunStep[]; runStatus?: RunStatus }) {
  const isCancelled = runStatus === 'cancelled';
  const visible = steps.filter((s) => s.status !== 'skipped');
  if (visible.length === 0) return null;

  const eff = (s: RunStepStatus) => effectiveStatus(s, runStatus);
  const runningIdx = visible.findIndex((s) => eff(s.status) === 'running');
  const nextIdx = visible.findIndex((s) => eff(s.status) === 'pending');
  const labelIdx = runningIdx >= 0 ? runningIdx : nextIdx >= 0 ? nextIdx : visible.length - 1;
  const active = visible[labelIdx];
  const remaining = active
    ? visible.slice(labelIdx + 1).filter((s) => eff(s.status) === 'pending').length
    : 0;
  const allDone = visible.every((s) => eff(s.status) === 'done');
  const hasFailed = visible.some((s) => eff(s.status) === 'failed');

  return (
    <View style={miniStyles.container}>
      <View style={miniStyles.bars}>
        {visible.map((step, i) => {
          const vis = eff(step.status);
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
      <Text
        style={[
          miniStyles.label,
          allDone && { color: colors.statusOk },
          hasFailed && { color: colors.statusFail },
          isCancelled && { color: colors.statusFail },
        ]}
        numberOfLines={1}
      >
        {isCancelled
          ? 'cancelled'
          : allDone
            ? 'done'
            : hasFailed
              ? 'failed'
              : active
                ? `${shortName(active.name)}${remaining > 0 ? ` +${remaining}` : ''}`
                : ''}
      </Text>
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

  const eff = (s: RunStepStatus) => effectiveStatus(s, runStatus);

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={fullStyles.scrollContent}
    >
      {visible.map((step, i) => {
        const vis = eff(step.status);
        const color = stepColor(vis);
        const prevDone = i > 0 && eff(visible[i - 1].status) === 'done';
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

function stepDotIcon(status: RunStepStatus): string {
  if (status === 'done') return '✓';
  if (status === 'running') return '▸';
  if (status === 'failed') return '✗';
  return '';
}

const MINI_SEGMENT_WIDTH = 14;
const MINI_SEGMENT_HEIGHT = 4;

const miniStyles = StyleSheet.create({
  container: {
    alignItems: 'center',
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
    marginLeft: spacing.xs,
    maxWidth: 100,
    textTransform: 'uppercase',
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
