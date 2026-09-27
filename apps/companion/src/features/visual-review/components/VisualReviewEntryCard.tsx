import { Pressable, Text, View } from 'react-native';

import { visualReviewStyles as styles } from '../styles/visual-review.styles';

/** Entry from a run surface into the touch review of its visual-review source. */
export function VisualReviewEntryCard({ onOpen }: { onOpen: () => void }) {
  return (
    <View style={styles.card}>
      <Text style={styles.eyebrow}>Visual review</Text>
      <Text style={styles.muted}>
        Annotate this run&apos;s captured screens and send the feedback to its worker.
      </Text>
      <Pressable
        testID="companion-open-visual-review"
        accessibilityRole="button"
        style={styles.button}
        onPress={onOpen}
      >
        <Text style={styles.buttonText}>Open visual review</Text>
      </Pressable>
    </View>
  );
}
