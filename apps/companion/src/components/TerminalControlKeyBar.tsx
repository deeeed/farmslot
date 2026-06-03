import React from 'react';
import { Pressable, type StyleProp, StyleSheet, Text, View, type ViewStyle } from 'react-native';

import { TERMINAL_CONTROL_KEYS, type TerminalControlKey } from '../lib/terminal-controls';
import { colors, fonts, radii, spacing } from '../lib/theme';

export type TerminalControlKeyBarProps = {
  activeLabel?: string | null;
  disabled?: boolean;
  label?: string | null;
  touchKeyboardEnabled?: boolean;
  onPress: (control: TerminalControlKey) => void;
  onToggleTouchKeyboard?: () => void;
  style?: StyleProp<ViewStyle>;
};

export function TerminalControlKeyBar({
  activeLabel = null,
  disabled = false,
  label = 'Terminal keys · arrows / Tab / Esc / ^C / ^D',
  touchKeyboardEnabled,
  onPress,
  onToggleTouchKeyboard,
  style,
}: TerminalControlKeyBarProps) {
  return (
    <View style={[styles.panel, style]}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <View style={styles.row}>
        {onToggleTouchKeyboard ? (
          <Pressable
            accessibilityRole="switch"
            accessibilityLabel="Allow terminal tap to open keyboard"
            accessibilityState={{ checked: Boolean(touchKeyboardEnabled) }}
            style={[styles.button, touchKeyboardEnabled && styles.keyboardButtonActive]}
            onPress={onToggleTouchKeyboard}
          >
            <Text
              style={[styles.buttonText, touchKeyboardEnabled && styles.keyboardButtonTextActive]}
            >
              {touchKeyboardEnabled ? '⌨ On' : '⌨ Off'}
            </Text>
          </Pressable>
        ) : null}
        {TERMINAL_CONTROL_KEYS.map((control) => (
          <Pressable
            key={control.label}
            style={[
              styles.button,
              control.danger && styles.dangerButton,
              disabled && styles.disabledButton,
            ]}
            onPress={() => onPress(control)}
            disabled={disabled}
          >
            <Text style={[styles.buttonText, control.danger && styles.dangerText]}>
              {activeLabel === control.label ? '…' : control.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    alignItems: 'stretch',
    gap: spacing.sm,
  },
  label: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  button: {
    alignItems: 'center',
    backgroundColor: colors.bgCard + '99',
    borderColor: colors.bgCardHover,
    borderRadius: radii.md,
    borderWidth: 1,
    flexGrow: 1,
    justifyContent: 'center',
    minWidth: 44,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  keyboardButtonActive: {
    backgroundColor: colors.accent + '22',
    borderColor: colors.accent,
  },
  keyboardButtonTextActive: {
    color: colors.accent,
  },
  dangerButton: {
    backgroundColor: colors.statusFail + '20',
    borderColor: colors.statusFail + '70',
  },
  disabledButton: { opacity: 0.5 },
  buttonText: {
    color: colors.textSecondary,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
    textAlign: 'center',
  },
  dangerText: { color: colors.statusFail },
});
