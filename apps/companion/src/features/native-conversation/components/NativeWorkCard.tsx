import { memo } from 'react';
import { Pressable, Text } from 'react-native';

import { nativeStyles as styles } from '../styles/native-conversation.styles';

interface NativeWorkCardProps {
  /** The key of the entry that ended the turn, passed back to `onToggle`. */
  foldKey: number;
  label: string;
  open: boolean;
  onToggle: (foldKey: number) => void;
}

/** A finished turn's tool calls behind one row, "Worked for 4m 12s · 6 tools", above its end. */
export const NativeWorkCard = memo(function NativeWorkCard({
  foldKey,
  label,
  open,
  onToggle,
}: NativeWorkCardProps) {
  return (
    <Pressable
      testID="companion-native-work-fold"
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      style={[styles.card, styles.messageToggle]}
      onPress={() => onToggle(foldKey)}
    >
      <Text style={styles.buttonText}>
        {open ? '▾' : '▸'} {label}
      </Text>
    </Pressable>
  );
});
