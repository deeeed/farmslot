import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { HeldTerminalInput } from '../lib/terminal-input-queue';
import { colors, radii, spacing } from '../lib/theme';

/** Shows Return and Backspace as symbols and other control keys as a dot, so held keys read. */
export function heldInputPreview(data: string, max = 40): string {
  const text = data
    .replace(/\r/g, '⏎')
    .replace(/\x7f/g, '⌫')
    .replace(/[\x00-\x1f]/g, '·');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Keys that may already be in the pane: nothing more is sent until the user resends or discards
 * them. A gateway instance that numbers input resends them on its own; this shows only when that
 * cannot be known: a gateway without `terminalInputSequence`, a different instance after a
 * restart, or a remote node that never answered (TERMINAL_INPUT_UNCERTAIN).
 */
export function TerminalHeldInput({
  held,
  onResend,
  onDiscard,
}: {
  held: HeldTerminalInput | null;
  onResend: () => void;
  onDiscard: () => void;
}) {
  if (!held) return null;
  const reason = held.error instanceof Error ? held.error.message : String(held.error);
  return (
    <View testID="terminal-held-input" style={styles.panel}>
      <Text style={styles.text}>
        Not sure “{heldInputPreview(held.data)}” reached the terminal ({reason}). Keys typed since
        wait behind it.
      </Text>
      <View style={styles.actions}>
        <Pressable testID="terminal-held-input-resend" style={styles.button} onPress={onResend}>
          <Text style={styles.buttonText}>Resend</Text>
        </Pressable>
        <Pressable testID="terminal-held-input-discard" style={styles.button} onPress={onDiscard}>
          <Text style={styles.buttonText}>Discard</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    backgroundColor: colors.statusWarn + '22',
    gap: spacing.xs,
    padding: spacing.sm,
    width: '100%',
  },
  text: { color: colors.textPrimary, fontSize: 13 },
  actions: { flexDirection: 'row', gap: spacing.sm },
  button: {
    borderColor: colors.accent,
    borderRadius: radii.md,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  buttonText: { color: colors.accent, fontWeight: '600' },
});
