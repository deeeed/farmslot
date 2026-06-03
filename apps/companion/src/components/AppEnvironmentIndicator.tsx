import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getCompanionEnvironment } from '../lib/app-environment';

export function AppEnvironmentIndicator() {
  const insets = useSafeAreaInsets();
  const environment = getCompanionEnvironment();

  if (environment.isProduction) return null;

  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.strip,
        {
          top: insets.top,
          backgroundColor: environment.appAccentColor,
        },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  strip: {
    elevation: 6,
    height: 3,
    left: 0,
    opacity: 0.9,
    position: 'absolute',
    right: 0,
    zIndex: 40,
  },
});
