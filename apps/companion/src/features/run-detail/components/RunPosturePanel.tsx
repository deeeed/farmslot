/**
 * Compact resource-posture summary for Companion Run Detail (ADR-054).
 *
 * Renders what `runtime.posture.status` returned and nothing else: the Gateway's
 * posture, the precedence level that produced it, the observed counts, and each
 * capability's desired disposition beside the state that was actually observed.
 * ADR-054 makes capability administration an explicit Companion non-goal, so
 * there are no acquire, restart, or release controls here — only what is true.
 */
import { StyleSheet, Text, View } from 'react-native';

import type { ResourcePostureRowStatus } from '@farmslot/protocol';

import {
  postureCountsLine,
  posturePolicyLine,
  postureTransitionLine,
  rejectionMessage,
  type RunPostureStatusState,
  summarizeRunPosture,
} from '../../../lib/run-resource-posture';
import { colors, fonts, radii, spacing } from '../../../lib/theme';

function rowStatusColor(rowStatus: ResourcePostureRowStatus): string {
  if (rowStatus === 'matches') return colors.statusOk;
  if (rowStatus === 'mismatch') return colors.statusFail;
  // `pending` and `unproven` are both "not settled yet"; neither is a verdict.
  return colors.textMuted;
}

export function RunPosturePanel({ state }: { state: RunPostureStatusState }) {
  if (state.status === 'idle') return null;

  if (state.status === 'loading' && !state.state) {
    return (
      <View style={styles.card} testID="companion-run-posture">
        <Text style={styles.title}>Resource posture</Text>
        <Text style={styles.muted}>Loading posture…</Text>
      </View>
    );
  }

  // An unreadable status is its own state. Falling back to "no posture" would
  // tell the operator this run holds nothing, which is a different claim.
  if (state.status === 'error' || !state.state) {
    return (
      <View style={styles.card} testID="companion-run-posture">
        <Text style={styles.title}>Resource posture</Text>
        <Text style={styles.failure} testID="companion-run-posture-error">
          {state.message ?? 'Posture status is unavailable.'}
        </Text>
      </View>
    );
  }

  const summary = summarizeRunPosture(state.state);
  const transition = summary.lastTransition;
  return (
    <View style={styles.card} testID="companion-run-posture">
      <View style={styles.headline}>
        <Text style={styles.title}>Resource posture</Text>
        <Text style={styles.postureName} testID="companion-run-posture-name">
          {summary.postureLabel}
        </Text>
      </View>
      <Text style={styles.counts} testID="companion-run-posture-counts">
        {postureCountsLine(summary.counts)}
      </Text>
      <Text style={styles.muted} testID="companion-run-posture-policy">
        {posturePolicyLine(summary)}
      </Text>
      <Text style={styles.muted} testID="companion-run-posture-worker">
        worker {summary.workerRetained ? 'retained' : 'stopped'}
      </Text>
      {transition ? (
        <Text style={styles.muted} testID="companion-run-posture-transition">
          {postureTransitionLine(transition)}
        </Text>
      ) : null}
      {transition?.effects.length ? (
        <Text style={styles.muted} testID="companion-run-posture-effects">
          Effects: {transition.effects.join('; ')}
        </Text>
      ) : null}
      {transition?.rejection ? (
        <Text style={styles.failure} testID="companion-run-posture-rejection">
          {rejectionMessage(transition.rejection)}
        </Text>
      ) : null}
      {summary.unreportedFailures.map((failure) => (
        <Text
          key={`${failure.capabilityId}-${failure.leaseId ?? ''}-${failure.reason}`}
          style={styles.failure}
          testID={`companion-run-posture-failure-${failure.capabilityId}`}
        >
          {failure.capabilityId}: {failure.reason}
        </Text>
      ))}
      {summary.rows.length === 0 ? (
        <Text style={styles.muted} testID="companion-run-posture-empty">
          This run holds no runtime capabilities.
        </Text>
      ) : (
        summary.rows.map((row) => (
          <View
            key={row.capabilityId}
            style={styles.row}
            testID={`companion-run-posture-row-${row.capabilityId}`}
          >
            <Text style={styles.capability}>{row.capabilityId}</Text>
            <Text style={styles.mono}>
              wants {row.desiredLabel} ·{' '}
              <Text style={{ color: rowStatusColor(row.rowStatus) }}>
                observed {row.observedState} ({row.rowStatusLabel})
              </Text>
            </Text>
            {row.warmUntil ? <Text style={styles.mono}>warm until {row.warmUntil}</Text> : null}
            <Text style={styles.muted}>{row.reason}</Text>
            {row.cleanupFailure ? (
              <Text style={styles.failure}>Cleanup failed: {row.cleanupFailure}</Text>
            ) : null}
          </View>
        ))
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  capability: {
    color: colors.textPrimary,
    fontFamily: fonts.mono,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  card: {
    backgroundColor: colors.bgCard,
    borderColor: colors.bgCardHover,
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.sm,
    marginBottom: spacing.xl,
    padding: spacing.lg,
  },
  counts: {
    color: colors.textSecondary,
    fontFamily: fonts.mono,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
  },
  failure: {
    color: colors.statusFail,
    fontSize: fonts.sizeXs,
    lineHeight: 16,
  },
  headline: {
    alignItems: 'baseline',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
  },
  mono: {
    color: colors.textMuted,
    fontFamily: fonts.mono,
    fontSize: fonts.sizeXs,
  },
  muted: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    lineHeight: 16,
  },
  postureName: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
  },
  row: {
    borderTopColor: colors.bgCardHover,
    borderTopWidth: 1,
    gap: spacing.xs,
    paddingTop: spacing.md,
  },
  title: {
    color: colors.textSecondary,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
});
