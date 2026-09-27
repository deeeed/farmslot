import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import { visualReviewStyles as styles } from '../styles/visual-review.styles';
import type { VisualReviewDelivery } from '../visual-review-controller';

function deliveryCopy(delivery: VisualReviewDelivery, targetRunId: string): string {
  switch (delivery.status) {
    case 'idle':
      return `Sends this feedback document to run ${targetRunId}'s worker as a message. It does not approve, publish, or complete the run.`;
    case 'pending':
      return `Delivering to run ${delivery.targetRunId}…`;
    case 'accepted':
      return `Delivery accepted: sent to run ${delivery.targetRunId}'s worker input. Not an approval. Edit the draft to send again.`;
    case 'failed':
      return `Delivery failed: ${delivery.message} Your draft is kept.`;
  }
}

export function FeedbackDelivery({
  delivery,
  targetRunId,
  noteCount,
  annotationCount,
  exportMessage,
  onExport,
  onSend,
}: {
  delivery: VisualReviewDelivery;
  targetRunId: string;
  noteCount: number;
  annotationCount: number;
  exportMessage: string | null;
  onExport: () => void;
  onSend: () => void;
}) {
  const pending = delivery.status === 'pending';
  // An accepted send stays accepted until the draft changes, so a second tap cannot duplicate it.
  const sendDisabled = pending || delivery.status === 'accepted';
  const statusStyle =
    delivery.status === 'accepted'
      ? styles.statusAccepted
      : delivery.status === 'failed'
        ? styles.statusFailed
        : delivery.status === 'pending'
          ? styles.statusPending
          : styles.muted;
  return (
    <View style={styles.card} testID="visual-review-delivery">
      <Text style={styles.eyebrow}>Feedback</Text>
      <Text style={styles.body} testID="visual-review-draft-summary">
        {noteCount} note{noteCount === 1 ? '' : 's'} · {annotationCount} annotation
        {annotationCount === 1 ? '' : 's'}
      </Text>
      <View style={styles.row}>
        <Pressable
          testID="visual-review-export"
          style={[styles.button, styles.buttonSecondary]}
          onPress={onExport}
        >
          <Text style={styles.buttonText}>Export JSON</Text>
        </Pressable>
        <Pressable
          testID="visual-review-send"
          accessibilityState={{ disabled: sendDisabled }}
          disabled={sendDisabled}
          style={[styles.button, sendDisabled && styles.buttonDisabled]}
          onPress={onSend}
        >
          {pending ? <ActivityIndicator /> : <Text style={styles.buttonText}>Send to worker</Text>}
        </Pressable>
      </View>
      {exportMessage ? <Text style={styles.muted}>{exportMessage}</Text> : null}
      <Text
        testID="visual-review-delivery-status"
        accessibilityLiveRegion="polite"
        style={[styles.body, statusStyle]}
      >
        {deliveryCopy(delivery, targetRunId)}
      </Text>
    </View>
  );
}
