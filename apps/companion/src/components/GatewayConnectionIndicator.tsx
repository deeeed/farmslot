import React from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FullWindowOverlay } from 'react-native-screens';

import { gatewayOfflineLabel } from '@farmslot/protocol';

import { useQuickActionsField } from '../features/quick-actions/quick-actions-context';
import { colors, fonts } from '../lib/theme';
import { useConnectionStore } from '../store/connection';

/** Root overlay covers nested workspaces without moving any held content. */
export function GatewayConnectionIndicator({ inModal = false }: { inModal?: boolean } = {}) {
  const insets = useSafeAreaInsets();
  const modalOutlet = useQuickActionsField('activeOutlet');
  const state = useConnectionStore((s) => s.status);
  const signedOut = useConnectionStore((s) => s.signedOut);
  const client = useConnectionStore((s) => s.client);
  const label = gatewayOfflineLabel(state, !signedOut && (client?.recoveryEnabled ?? false));
  if (!label || (Platform.OS === 'android' && !inModal && modalOutlet)) return null;
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
  return Platform.OS === 'ios' ? (
    <FullWindowOverlay unstable_accessibilityContainerViewIsModal={false}>
      {badge}
    </FullWindowOverlay>
  ) : (
    badge
  );
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
