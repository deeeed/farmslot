import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  COMPANION_DEMO_BANNER_TEXT,
  isCompanionDemoBannerEnabled,
} from '../lib/demo-banner';

export function DemoMonitoringBanner() {
  const insets = useSafeAreaInsets();
  if (!isCompanionDemoBannerEnabled()) return null;

  return (
    <View
      pointerEvents="none"
      accessibilityRole="text"
      accessibilityLabel={COMPANION_DEMO_BANNER_TEXT}
      style={[styles.banner, { paddingTop: insets.top + 6 }]}
    >
      <Text style={styles.text}>{COMPANION_DEMO_BANNER_TEXT}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: '#ff4444',
    elevation: 8,
    left: 0,
    paddingBottom: 6,
    paddingHorizontal: 12,
    position: 'absolute',
    right: 0,
    top: 0,
    zIndex: 50,
  },
  text: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.6,
    textAlign: 'center',
  },
});