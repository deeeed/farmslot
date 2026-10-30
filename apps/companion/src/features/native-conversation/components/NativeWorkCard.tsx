import { Pressable, Text } from 'react-native';

import { nativeStyles as styles } from '../styles/native-conversation.styles';

/** A finished turn's tool calls behind one row, "Worked for 4m 12s · 6 tools", above its end. */
export function NativeWorkCard({
  label,
  open,
  onToggle,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <Pressable
      testID="companion-native-work-fold"
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      style={[styles.card, styles.messageToggle]}
      onPress={onToggle}
    >
      <Text style={styles.buttonText}>
        {open ? '▾' : '▸'} {label}
      </Text>
    </Pressable>
  );
}
