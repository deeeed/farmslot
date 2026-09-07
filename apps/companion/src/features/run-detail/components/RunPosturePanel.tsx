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

import {
  gateParkStateLabel,
  gateParkSummaryLine,
  type GateParkView,
  type ResourcePostureRowStatus,
} from '@farmslot/protocol';

import {
  postureCountsLine,
  posturePolicyLine,
  postureTransitionLine,
  rejectionMessage,
  resourceWaitLine,
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

/**
 * Where the run's slot went, from the shared protocol reading.
 *
 * The posture rows say what the run is HOLDING; this says what happened to its
 * slot. A parked run needs both: its posture reads `parked` on every surface,
 * and only this names the slot dispatch was handed and the branch that was
 * taken out of its working tree. Availability is whatever the Gateway said, and
 * `null` is reported as not read rather than as free.
 */
function GateParkLines({ view }: { view: GateParkView | null }) {
  if (!view) return null;
  const target = view.restoreTarget;
  return (
    <View style={styles.row} testID="companion-run-posture-gate-park">
      <Text style={styles.capability} testID="companion-run-posture-gate-park-state">
        {gateParkStateLabel(view)}
      </Text>
      <Text style={styles.mono} testID="companion-run-posture-gate-park-summary">
        {gateParkSummaryLine(view)}
      </Text>
      {/*
        Historical, not current. The record proves this run RELEASED the slot; a
        successor takes it routinely, so "is free for dispatch" read as a claim
        about now and sat next to RESTORE_SLOT_TAKEN. Current occupancy is only
        ever the restore target's Gateway verdict, rendered below.
      */}
      {view.freedSlotId ? (
        <Text style={styles.muted} testID="companion-run-posture-gate-park-freed">
          This run released {view.freedSlotId} to dispatch.
        </Text>
      ) : null}
      <Text style={styles.mono} testID="companion-run-posture-gate-park-target">
        Restore target {target.slotId} —{' '}
        {target.available === null
          ? 'availability not read'
          : target.available
            ? 'available'
            : `not available${target.reason ? `: ${target.reason}` : ''}`}
      </Text>
      {view.refusal ? (
        <Text style={styles.failure} testID="companion-run-posture-gate-park-refusal">
          Last restore refused ({view.refusal.code}): {view.refusal.reason}
        </Text>
      ) : null}
    </View>
  );
}

export function RunPosturePanel({
  state,
  gatePark = null,
}: {
  state: RunPostureStatusState;
  /** The run's live gate park, when it has one. Read from the park record, not the posture. */
  gatePark?: GateParkView | null;
}) {
  // A live park is worth a panel on its own: the posture read can be idle or
  // failed exactly when a run is parked, and hiding where its slot went because
  // a different request has not landed is the wrong thing to hide.
  if (state.status === 'idle' && !gatePark) return null;

  if (state.status === 'idle') {
    return (
      <View style={styles.card} testID="companion-run-posture">
        <Text style={styles.title}>Resource posture</Text>
        <GateParkLines view={gatePark} />
        <Text style={styles.muted} testID="companion-run-posture-unread">
          Posture status has not been read for this run.
        </Text>
      </View>
    );
  }

  if (state.status === 'loading' && !state.state) {
    return (
      <View style={styles.card} testID="companion-run-posture">
        <Text style={styles.title}>Resource posture</Text>
        <GateParkLines view={gatePark} />
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
        <GateParkLines view={gatePark} />
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
      {summary.resourceWait ? (
        <Text style={styles.mono} testID="companion-run-posture-resource-wait">
          {resourceWaitLine(summary.resourceWait)}
        </Text>
      ) : null}
      <GateParkLines view={gatePark} />
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
            {row.targetLabel ? (
              <Text style={styles.mono} testID={`companion-run-posture-target-${row.capabilityId}`}>
                target {row.targetLabel}
              </Text>
            ) : null}
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
