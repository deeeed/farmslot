import React from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { ReleaseNotesPayload } from '../lib/release-notes';
import { colors, fonts, radii, spacing } from '../lib/theme';

interface WhatsNewModalProps {
  visible: boolean;
  notes: ReleaseNotesPayload;
  onDismiss: () => void;
}

export function WhatsNewModal({ visible, notes, onDismiss }: WhatsNewModalProps) {
  if (!notes.items.length) return null;

  const dateSuffix = notes.date ? ` · ${notes.date}` : '';

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onDismiss}>
      <View style={styles.backdrop}>
        <View style={styles.panel}>
          <Text style={styles.kicker}>What's new</Text>
          <Text style={styles.title}>
            Companion v{notes.version}
            {dateSuffix}
          </Text>
          <ScrollView style={styles.listScroll} contentContainerStyle={styles.listContent}>
            {notes.items.map((item, index) => (
              <View key={`${index}-${item}`} style={styles.itemRow}>
                <Text style={styles.bullet}>•</Text>
                <Text style={styles.itemText}>{item}</Text>
              </View>
            ))}
          </ScrollView>
          <Pressable style={styles.button} onPress={onDismiss}>
            <Text style={styles.buttonText}>Got it</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  panel: {
    backgroundColor: colors.bgCard,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.bgCardHover,
    padding: spacing.xl,
    maxHeight: '70%',
  },
  kicker: {
    color: colors.textMuted,
    fontFamily: fonts.mono,
    fontSize: fonts.sizeXs,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  title: {
    color: colors.textPrimary,
    fontSize: fonts.sizeLg,
    fontWeight: '600',
    marginTop: spacing.sm,
    marginBottom: spacing.lg,
  },
  listScroll: {
    marginBottom: spacing.lg,
  },
  listContent: {
    gap: spacing.md,
  },
  itemRow: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  bullet: {
    color: colors.accent,
    fontSize: fonts.sizeMd,
    lineHeight: 20,
  },
  itemText: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: fonts.sizeMd,
    lineHeight: 20,
  },
  button: {
    alignSelf: 'flex-end',
    backgroundColor: colors.accent,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  buttonText: {
    color: colors.bgBase,
    fontFamily: fonts.mono,
    fontSize: fonts.sizeSm,
    fontWeight: '600',
  },
});
