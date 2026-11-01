import React, { useState } from 'react';
import { Pressable, type StyleProp, StyleSheet, Text, View, type ViewStyle } from 'react-native';

import { usePaneRunnerContext } from '../hooks/usePaneRunnerContext';
import {
  resolveRunnerKeyProfile,
  runnerKeyProfileSummary,
  TERMINAL_CONTROL_KEYS,
  type TerminalControlKey,
  terminalExtraKeyRows,
  type TerminalRunnerPane,
} from '../lib/terminal-controls';
import { colors, fonts, radii, spacing } from '../lib/theme';
import { useTerminalPrefsStore } from '../store/terminal-prefs';

import { CustomTerminalKeysModal, RunnerKeyProfilePicker } from './TerminalKeyModals';

export type TerminalControlKeyBarProps = {
  activeLabel?: string | null;
  disabled?: boolean;
  label?: string | null;
  /** Adds the runner row, the Yours row and their pickers for the pane this bar drives. */
  runnerPane?: TerminalRunnerPane | null;
  /** Typing goes to the terminal itself instead of the input line. */
  directInput?: boolean;
  onPress: (control: TerminalControlKey) => void;
  onToggleDirectInput?: () => void;
  style?: StyleProp<ViewStyle>;
};

type RenderKey = (control: TerminalControlKey, testID?: string) => React.ReactNode;

export function TerminalControlKeyBar({
  activeLabel = null,
  disabled = false,
  label = 'Terminal keys · arrows / Tab / Esc / ^C / ^D',
  runnerPane,
  directInput,
  onPress,
  onToggleDirectInput,
  style,
}: TerminalControlKeyBarProps) {
  const renderKey: RenderKey = (control, testID) => (
    <Pressable
      key={control.label}
      testID={testID}
      accessibilityRole="button"
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
  );
  return (
    <View style={[styles.panel, style]}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <View style={styles.row}>
        {onToggleDirectInput ? (
          <Pressable
            testID="terminal-direct-input-toggle"
            accessibilityRole="switch"
            accessibilityLabel="Type directly in the terminal"
            accessibilityState={{ checked: Boolean(directInput) }}
            style={[styles.button, directInput && styles.keyboardButtonActive]}
            onPress={onToggleDirectInput}
          >
            <Text style={[styles.buttonText, directInput && styles.keyboardButtonTextActive]}>
              {directInput ? '⌨ Direct' : '⌨ Line'}
            </Text>
          </Pressable>
        ) : null}
        {TERMINAL_CONTROL_KEYS.map((control) => renderKey(control))}
      </View>
      {runnerPane !== undefined ? <RunnerKeyRows pane={runnerPane} renderKey={renderKey} /> : null}
    </View>
  );
}

function RunnerKeyRows({
  pane,
  renderKey,
}: {
  pane: TerminalRunnerPane | null;
  renderKey: RenderKey;
}) {
  const { context } = usePaneRunnerContext(pane);
  const overrides = useTerminalPrefsStore((s) => s.runnerKeyOverrides);
  const customKeys = useTerminalPrefsStore((s) => s.customKeys);
  const setRunnerKeyOverride = useTerminalPrefsStore((s) => s.setRunnerKeyOverride);
  const [openModal, setOpenModal] = useState<'profile' | 'custom' | null>(null);
  const resolved = resolveRunnerKeyProfile(context, overrides);
  const { paneKey } = context;
  return (
    <>
      <View style={styles.extraRow}>
        <Pressable
          testID="terminal-runner-profile"
          accessibilityRole="button"
          style={[styles.chip, !paneKey && styles.disabledButton]}
          disabled={!paneKey}
          onPress={() => setOpenModal('profile')}
        >
          <Text style={styles.chipText}>{runnerKeyProfileSummary(resolved)}</Text>
        </Pressable>
        <Pressable
          testID="terminal-custom-keys-manage"
          accessibilityRole="button"
          style={styles.chip}
          onPress={() => setOpenModal('custom')}
        >
          <Text style={styles.chipText}>＋ Your keys</Text>
        </Pressable>
      </View>
      {terminalExtraKeyRows(resolved.profile, customKeys).map((row) => (
        <View key={row.id} testID={`terminal-${row.id}-keys-row`} style={styles.extraRow}>
          <Text style={styles.rowTitle}>{row.title}</Text>
          {row.keys.map((control, index) => renderKey(control, `terminal-${row.id}-key-${index}`))}
        </View>
      ))}
      {paneKey ? (
        <RunnerKeyProfilePicker
          visible={openModal === 'profile'}
          resolved={resolved}
          onClose={() => setOpenModal(null)}
          onSelect={(runnerId) => {
            setRunnerKeyOverride(paneKey, runnerId);
            setOpenModal(null);
          }}
        />
      ) : null}
      {/* Mounted only while open, so a closed editor keeps no draft. */}
      {openModal === 'custom' ? (
        <CustomTerminalKeysModal visible onClose={() => setOpenModal(null)} />
      ) : null}
    </>
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
  extraRow: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  rowTitle: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '700',
    marginRight: spacing.xs,
  },
  chip: {
    borderColor: colors.bgCardHover,
    borderRadius: radii.md,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  chipText: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '700',
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
