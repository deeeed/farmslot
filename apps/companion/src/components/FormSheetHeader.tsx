import { useRouter } from 'expo-router';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, fonts, spacing } from '../lib/theme';

export function FormSheetHeader({ title }: { title: string }) {
  const router = useRouter();

  return (
    <View style={styles.container}>
      <Text style={styles.title}>{title}</Text>
      <Pressable accessibilityRole="button" onPress={() => router.back()}>
        <Text style={styles.done}>Done</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    borderBottomColor: colors.bgCard,
    borderBottomWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingBottom: spacing.md,
  },
  title: { color: colors.textPrimary, fontSize: fonts.sizeLg, fontWeight: '900' },
  done: { color: colors.accent, fontSize: fonts.sizeSm, fontWeight: '900' },
});
