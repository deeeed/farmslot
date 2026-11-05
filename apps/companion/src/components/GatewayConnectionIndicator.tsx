import React from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FullWindowOverlay } from 'react-native-screens';

import { gatewayOfflineLabel } from '@farmslot/protocol';

import { colors, fonts } from '../lib/theme';
import { useConnectionStore } from '../store/connection';

/** Root overlay covers nested workspaces without moving any held content. */
export function GatewayConnectionIndicator() {
  const insets = useSafeAreaInsets();
  const state = useConnectionStore((s) => s.status);
  const signedOut = useConnectionStore((s) => s.signedOut);
  const client = useConnectionStore((s) => s.client);
  const label = gatewayOfflineLabel(state, !signedOut && (client?.recoveryEnabled ?? false));
  if (!label) return null;
  const badge = (
    <View
      testID="gateway-offline-indicator"
      pointerEvents="none"
      style={[styles.badge, { top: insets.top + 8 }]}
    >
      <Text accessibilityRole="text" accessibilityLiveRegion="polite" style={styles.text}>
        {label}
      </Text>
    </View>
  );
  return Platform.OS === 'ios' ? <FullWindowOverlay>{badge}</FullWindowOverlay> : badge;
}

const styles = StyleSheet.create({
  badge: {
    position: 'absolute',
    right: 12,
    zIndex: 100,
    elevation: 10,
    backgroundColor: colors.bgCard,
    borderRadius: 6,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  text: { color: colors.statusWarn, fontSize: fonts.sizeXs },
});
