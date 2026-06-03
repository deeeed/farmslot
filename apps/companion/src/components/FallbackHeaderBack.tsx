import { useRouter } from 'expo-router';
import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';

import { colors, fonts, spacing } from '../lib/theme';

interface FallbackHeaderBackProps {
  fallbackHref: string;
  label?: string;
}

export function FallbackHeaderBack({ fallbackHref, label = 'Back' }: FallbackHeaderBackProps) {
  const router = useRouter();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Go back"
      hitSlop={12}
      style={styles.button}
      onPress={() => {
        if (router.canGoBack()) {
          router.back();
          return;
        }
        router.replace(fallbackHref as Parameters<typeof router.replace>[0]);
      }}
    >
      <Text style={styles.text}>‹ {label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  text: {
    color: colors.accent,
    fontSize: fonts.sizeSm,
    fontWeight: '800',
  },
});
