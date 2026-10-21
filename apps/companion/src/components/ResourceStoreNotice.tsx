import React, { useSyncExternalStore } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getResourceStoreNotice, subscribeResourceCache } from '../lib/resource-cache';

export function ResourceStoreNotice() {
  const notice = useSyncExternalStore(
    subscribeResourceCache,
    getResourceStoreNotice,
    getResourceStoreNotice,
  );
  const insets = useSafeAreaInsets();
  if (!notice) return null;
  return (
    <View pointerEvents="none" style={[styles.notice, { bottom: insets.bottom + 52 }]}>
      <Text
        testID="resource-store-notice"
        accessibilityRole="text"
        style={styles.text}
        numberOfLines={1}
      >
        Offline data will not survive a restart on this device.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  notice: {
    position: 'absolute',
    left: 12,
    right: 12,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: '#70551e',
    borderRadius: 4,
    backgroundColor: '#241d10',
    zIndex: 200,
  },
  text: { color: '#f2cf83', fontSize: 11, lineHeight: 16 },
});
