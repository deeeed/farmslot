import React from 'react';
import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';

import { baseStyles, colors, fonts, radii, spacing } from '../lib/theme';

interface FilterEmptyStateProps {
  message: string;
  onClear: () => void;
  style?: ViewStyle;
}

export function FilterEmptyState({ message, onClear, style }: FilterEmptyStateProps) {
  return (
    <View style={[styles.container, style]}>
      <Text style={baseStyles.textSecondary}>{message}</Text>
      <Text style={styles.hint}>Clear filters to return to the full fleet view.</Text>
      <Pressable style={styles.clearButton} onPress={onClear}>
        <Text style={styles.clearButtonText}>Clear filters</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    gap: spacing.sm,
    justifyContent: 'center',
    padding: spacing.xl,
  },
  hint: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    textAlign: 'center',
  },
  clearButton: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
    borderRadius: radii.md,
    borderWidth: 1,
    marginTop: spacing.xs,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  clearButtonText: {
    color: '#fff',
    fontSize: fonts.sizeSm,
    fontWeight: '800',
  },
});
