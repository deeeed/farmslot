import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { CancelledRunSlotHold } from '@farmslot/protocol';

import { colors, fonts, lifecycleColor, spacing } from '../../lib/theme';

import { useCancelledRunSlotRelease } from './use-cancelled-run-slot-release';

/** The run view's other choice, shown before the release. */
export interface CancelledRunSlotReplay {
  label: string;
  disabled: boolean;
  onReplay: () => void;
}

/** A slot a cancelled run keeps for replay, with its release (ADR-054, 2026-10-19). */
export function CancelledRunSlotRelease({
  hold,
  replay,
}: {
  hold: CancelledRunSlotHold;
  replay?: CancelledRunSlotReplay;
}) {
  const release = useCancelledRunSlotRelease(hold);
  return (
    <View style={styles.container} testID="companion-cancelled-run-slot">
      <Text style={styles.held}>{hold.label}</Text>
      <View style={styles.actions}>
        {replay ? (
          <Pressable
            style={[styles.action, (replay.disabled || release.releasing) && styles.disabled]}
            disabled={replay.disabled || release.releasing}
            onPress={replay.onReplay}
            hitSlop={8}
            testID="companion-cancelled-run-slot-replay"
          >
            <Text style={styles.actionText}>{replay.label}</Text>
          </Pressable>
        ) : null}
        <Pressable
          style={[styles.action, release.disabled && styles.disabled]}
          disabled={release.disabled}
          onPress={release.confirmRelease}
          hitSlop={8}
          testID="companion-cancelled-run-slot-release"
        >
          <Text style={styles.actionText}>
            {release.releasing ? 'Releasing…' : hold.releaseLabel}
          </Text>
        </Pressable>
      </View>
      {release.error ? <Text style={styles.error}>{release.error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: spacing.xs,
    marginTop: spacing.sm,
  },
  held: {
    color: lifecycleColor('held'),
    fontSize: fonts.sizeXs,
    fontWeight: '700',
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  action: {
    backgroundColor: colors.accent + '22',
    borderColor: colors.accent + '70',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  actionText: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
  },
  disabled: {
    opacity: 0.5,
  },
  error: {
    color: colors.statusFail,
    fontSize: fonts.sizeXs,
  },
});
