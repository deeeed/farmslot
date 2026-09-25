import { Pressable, Text, TextInput, View } from 'react-native';

import type { VisualReviewAnnotation } from '@farmslot/protocol';

import { colors } from '../../../lib/theme';
import { VISUAL_REVIEW_PALETTE } from '../../../lib/visual-review';
import { visualReviewStyles as styles } from '../styles/visual-review.styles';

/** Nudge step in normalized image units; drags cover large moves. */
const NUDGE = 0.02;
const NUDGES = [
  { id: 'up', label: '↑', delta: { x: 0, y: -NUDGE } },
  { id: 'down', label: '↓', delta: { x: 0, y: NUDGE } },
  { id: 'left', label: '←', delta: { x: -NUDGE, y: 0 } },
  { id: 'right', label: '→', delta: { x: NUDGE, y: 0 } },
] as const;

export function AnnotationInspector({
  annotations,
  selectedAnnotationId,
  onSelect,
  onUpdate,
  onMove,
  onRemove,
}: {
  annotations: VisualReviewAnnotation[];
  selectedAnnotationId: string | null;
  onSelect: (annotationId: string | null) => void;
  onUpdate: (annotationId: string, patch: { body?: string; color?: string }) => void;
  onMove: (annotationId: string, delta: { x: number; y: number }) => void;
  onRemove: (annotationId: string) => void;
}) {
  const selectedIndex = annotations.findIndex(({ id }) => id === selectedAnnotationId);
  const selected = annotations[selectedIndex];
  return (
    <View style={styles.card} testID="visual-review-annotations">
      <Text style={styles.eyebrow}>Annotations on this capture · {annotations.length}</Text>
      {annotations.length === 0 ? <Text style={styles.muted}>No annotations here yet.</Text> : null}
      {annotations.map((annotation, index) => (
        <Pressable
          key={annotation.id}
          testID={`visual-review-annotation-${annotation.id}`}
          accessibilityRole="button"
          accessibilityState={{ selected: annotation.id === selectedAnnotationId }}
          style={[styles.listItem, annotation.id === selectedAnnotationId && styles.listItemActive]}
          onPress={() => onSelect(annotation.id === selectedAnnotationId ? null : annotation.id)}
        >
          <View style={[styles.dot, { backgroundColor: annotation.color ?? colors.accent }]} />
          <Text style={styles.chipText}>
            {index + 1}. {annotation.shape === 'area' ? 'Area' : 'Point'}
          </Text>
          <Text style={[styles.muted, { flex: 1 }]} numberOfLines={1}>
            {annotation.body.trim() || 'Needs a comment'}
          </Text>
        </Pressable>
      ))}
      {selected ? (
        <View style={{ gap: 10 }} testID="visual-review-annotation-editor">
          <Text style={styles.eyebrow} testID="visual-review-annotation-position">
            Editing {selected.shape} {selectedIndex + 1} · x {Math.round(selected.x * 100)}% · y{' '}
            {Math.round(selected.y * 100)}%
          </Text>
          <TextInput
            testID="visual-review-annotation-body"
            style={styles.input}
            multiline
            placeholder="What should change here?"
            placeholderTextColor={colors.textMuted}
            value={selected.body}
            onChangeText={(body) => onUpdate(selected.id, { body })}
          />
          <View style={styles.row}>
            {VISUAL_REVIEW_PALETTE.map((color) => (
              <Pressable
                key={color}
                testID={`visual-review-color-${color.slice(1)}`}
                accessibilityRole="button"
                accessibilityLabel={`Color ${color}`}
                accessibilityState={{ selected: selected.color === color }}
                style={[
                  styles.swatch,
                  { backgroundColor: color },
                  selected.color === color && styles.swatchActive,
                ]}
                onPress={() => onUpdate(selected.id, { color })}
              />
            ))}
          </View>
          <View style={styles.nudgeGrid}>
            {NUDGES.map((nudge) => (
              <Pressable
                key={nudge.id}
                testID={`visual-review-nudge-${nudge.id}`}
                accessibilityLabel={`Move ${nudge.id}`}
                style={[styles.button, styles.buttonSecondary]}
                onPress={() => onMove(selected.id, nudge.delta)}
              >
                <Text style={styles.buttonText}>{nudge.label}</Text>
              </Pressable>
            ))}
          </View>
          <View style={styles.row}>
            <Pressable
              testID="visual-review-annotation-remove"
              style={[styles.button, styles.buttonDanger]}
              onPress={() => onRemove(selected.id)}
            >
              <Text style={styles.buttonText}>Remove</Text>
            </Pressable>
            <Pressable
              testID="visual-review-annotation-done"
              style={[styles.button, styles.buttonSecondary]}
              onPress={() => onSelect(null)}
            >
              <Text style={styles.buttonText}>Done</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}
