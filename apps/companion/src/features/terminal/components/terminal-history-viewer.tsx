import React, { forwardRef } from 'react';
import { ScrollView, type StyleProp, StyleSheet, Text, View, type ViewStyle } from 'react-native';

import {
  type TerminalSize,
  XtermTerminalView,
  type XtermTerminalViewHandle,
} from '../../../components/XtermTerminalView';
import { terminalHistoryTextFromText } from '../../../lib/terminal-tail';
import { colors, fonts, radii, spacing } from '../../../lib/theme';

export type TerminalViewMode = 'tmux' | 'history';
export type { TerminalSize, XtermTerminalViewHandle };

const TERMINAL_HISTORY_VIEWER_LINES = 1000;

export function TerminalModeToggle({
  mode,
  onChange,
  style,
}: {
  mode: TerminalViewMode;
  onChange: (mode: TerminalViewMode) => void;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.toggle, style]}>
      <Text
        style={[styles.toggleOption, mode === 'tmux' && styles.toggleOptionActive]}
        onPress={() => onChange('tmux')}
      >
        Tmux
      </Text>
      <Text
        style={[styles.toggleOption, mode === 'history' && styles.toggleOptionActive]}
        onPress={() => onChange('history')}
      >
        History
      </Text>
    </View>
  );
}

export function TerminalHistoryPanel({ rawText }: { rawText: string }) {
  const body = terminalHistoryTextFromText(rawText, TERMINAL_HISTORY_VIEWER_LINES);
  return (
    <ScrollView style={styles.panel} contentContainerStyle={styles.panelContent}>
      <ScrollView horizontal showsHorizontalScrollIndicator>
        <Text selectable style={styles.historyText}>
          {body.trim() ? body : 'No terminal history yet.'}
        </Text>
      </ScrollView>
    </ScrollView>
  );
}

export const TerminalViewSurface = forwardRef<
  XtermTerminalViewHandle,
  {
    allowTouchKeyboard?: boolean;
    initialText: string;
    mode: TerminalViewMode;
    onInput: (data: string) => void;
    onResize: (size: TerminalSize) => void;
    rawHistoryText: string;
    readOnlyReason?: string | null;
  }
>(function TerminalViewSurface(
  { allowTouchKeyboard, initialText, mode, onInput, onResize, rawHistoryText, readOnlyReason },
  ref,
) {
  if (mode === 'history') return <TerminalHistoryPanel rawText={rawHistoryText} />;
  return (
    <XtermTerminalView
      ref={ref}
      allowTouchKeyboard={allowTouchKeyboard}
      initialText={initialText}
      onInput={onInput}
      onResize={onResize}
      readOnlyReason={readOnlyReason}
    />
  );
});

const styles = StyleSheet.create({
  toggle: {
    backgroundColor: colors.bgCard,
    borderColor: colors.bgCardHover,
    borderRadius: radii.md,
    borderWidth: 1,
    flexDirection: 'row',
    overflow: 'hidden',
  },
  toggleOption: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  toggleOptionActive: {
    backgroundColor: colors.accent + '22',
    color: colors.accent,
  },
  panel: {
    backgroundColor: '#000',
    flex: 1,
  },
  panelContent: {
    padding: spacing.md,
  },
  historyText: {
    color: colors.textPrimary,
    fontFamily: fonts.mono,
    fontSize: fonts.sizeXs,
    lineHeight: 18,
    minWidth: 320,
  },
});
