import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { Pressable, type StyleProp, StyleSheet, Text, type ViewStyle } from 'react-native';

import type { TerminalOrientationControls } from '../lib/terminal-orientation';
import { colors, fonts, spacing } from '../lib/theme';

export type TerminalOrientationButtonProps = {
  controls: TerminalOrientationControls;
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
};

export function TerminalOrientationButton({
  controls,
  compact = false,
  style,
}: TerminalOrientationButtonProps) {
  const unavailable = controls.status === 'unsupported' || controls.status === 'failed';
  const disabled = controls.status === 'applying' || unavailable;
  const iconName =
    controls.mode === 'landscape' ? 'phone-portrait-outline' : 'phone-landscape-outline';
  const label = unavailable
    ? 'No orient'
    : controls.status === 'applying'
      ? '…'
      : controls.mode === 'landscape'
        ? 'Portrait'
        : 'Landscape';

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Toggle terminal orientation"
      style={[
        styles.button,
        compact && styles.compactButton,
        unavailable && styles.disabled,
        style,
      ]}
      onPress={controls.toggle}
      disabled={disabled}
    >
      <Ionicons name={iconName} size={compact ? 15 : 16} color={colors.textSecondary} />
      {!compact ? <Text style={styles.text}>{label}</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    backgroundColor: colors.bgCard,
    borderColor: colors.bgCardHover,
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.xs,
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  compactButton: {
    height: 34,
    paddingHorizontal: spacing.sm,
    width: 42,
  },
  disabled: {
    opacity: 0.55,
  },
  text: {
    color: colors.textSecondary,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
});
