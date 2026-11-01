import { forwardRef, useImperativeHandle, useRef } from 'react';
import { StyleSheet, TextInput } from 'react-native';

import { inputLineDelta, TERMINAL_BACKSPACE } from '../lib/terminal-input-line';
import { colors, fonts, radii, spacing } from '../lib/theme';

export type TerminalInputLineHandle = {
  /** Starts a new line without sending anything, after a key from the key bar changed the pane. */
  reset: () => void;
  focus: () => void;
};

type TerminalInputLineProps = {
  autoFocus?: boolean;
  disabled?: boolean;
  onSend: (data: string) => void;
};

/**
 * Typing for a terminal. The phone's keyboard edits a native field, which shows each character as
 * typed; every change goes to the pane in order, and Return sends Enter. The terminal itself only
 * displays: xterm in a WebView garbles fast keyboard input.
 */
export const TerminalInputLine = forwardRef<TerminalInputLineHandle, TerminalInputLineProps>(
  function TerminalInputLine({ autoFocus = false, disabled = false, onSend }, ref) {
    const inputRef = useRef<TextInput>(null);
    // What the pane already has from this line. The field stays uncontrolled: a controlled value
    // would fight fast typing while the JS thread is busy.
    const sent = useRef('');
    const startLine = () => {
      sent.current = '';
      inputRef.current?.clear();
    };
    useImperativeHandle(
      ref,
      () => ({ reset: startLine, focus: () => inputRef.current?.focus() }),
      [],
    );
    return (
      <TextInput
        ref={inputRef}
        testID="terminal-input-line"
        accessibilityLabel="Terminal input"
        autoFocus={autoFocus}
        editable={!disabled}
        autoCapitalize="none"
        autoComplete="off"
        autoCorrect={false}
        spellCheck={false}
        returnKeyType="send"
        submitBehavior="submit"
        placeholder="Type here · Return sends Enter"
        placeholderTextColor={colors.textMuted}
        style={[styles.input, disabled && styles.disabled]}
        onChangeText={(next) => {
          const data = inputLineDelta(sent.current, next);
          sent.current = next;
          if (data) onSend(data);
        }}
        onKeyPress={({ nativeEvent }) => {
          // Backspace in an empty line keeps deleting in the pane when the keyboard reports it
          // (a hardware keyboard does; Gboard does not, so the key bar also has ⌫).
          if (nativeEvent.key === 'Backspace' && sent.current === '') onSend(TERMINAL_BACKSPACE);
        }}
        onSubmitEditing={() => {
          onSend('\r');
          startLine();
        }}
      />
    );
  },
);

const styles = StyleSheet.create({
  input: {
    width: '100%',
    backgroundColor: colors.bgCard,
    borderColor: colors.bgCardHover,
    borderRadius: radii.md,
    borderWidth: 1,
    color: colors.textPrimary,
    fontFamily: fonts.mono,
    fontSize: 14,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  disabled: { opacity: 0.5 },
});
