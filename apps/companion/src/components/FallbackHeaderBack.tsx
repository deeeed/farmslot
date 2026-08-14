import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React from 'react';
import { Pressable, StyleSheet } from 'react-native';

import { colors } from '../lib/theme';

interface FallbackHeaderBackProps {
  fallbackHref: string;
}

export function HeaderBackButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Go back"
      hitSlop={12}
      style={styles.button}
      onPress={onPress}
    >
      <Ionicons color={colors.accent} name="chevron-back" size={24} />
    </Pressable>
  );
}

export function FallbackHeaderBack({ fallbackHref }: FallbackHeaderBackProps) {
  const router = useRouter();
  return (
    <HeaderBackButton
      onPress={() => {
        if (router.canGoBack()) {
          router.back();
          return;
        }
        router.replace(fallbackHref as Parameters<typeof router.replace>[0]);
      }}
    />
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
});
