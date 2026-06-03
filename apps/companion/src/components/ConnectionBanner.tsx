import { useRouter } from 'expo-router';
import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, fonts, spacing } from '../lib/theme';
import { useConnectionStore } from '../store/connection';

interface ConnectionBannerProps {
  compact?: boolean;
}

export function ConnectionBanner({ compact = false }: ConnectionBannerProps) {
  const router = useRouter();
  const status = useConnectionStore((s) => s.status);
  const lastSyncError = useConnectionStore((s) => s.lastSyncError);
  const gatewayUrl = useConnectionStore((s) => s.gatewayUrl);
  const profiles = useConnectionStore((s) => s.profiles);
  const activeProfileId = useConnectionStore((s) => s.activeProfileId);
  const activeProfileAuthMode = useConnectionStore((s) => s.activeProfileAuthMode);

  const activeProfile = useMemo(
    () => profiles.find((profile) => profile.id === activeProfileId) ?? null,
    [activeProfileId, profiles],
  );
  const isConnecting = status === 'connecting';
  const isSyncError = status === 'connected' && Boolean(lastSyncError);
  const isConnected = status === 'connected' && !lastSyncError;
  if (isConnected) return null;

  const connectionTitle = isConnected
    ? `Connected · ${activeProfile?.name ?? 'Custom gateway'}`
    : isSyncError
      ? lastSyncError
      : isConnecting
        ? 'Connecting to gateway...'
        : 'Disconnected from gateway';
  const connectionDetail = isConnected
    ? `${gatewayUrl}${activeProfileAuthMode !== 'none' ? ` · ${activeProfileAuthMode} auth` : ''}`
    : 'Tap to open connection settings';
  const onPress = () => {
    router.push('/settings');
  };

  return (
    <Pressable
      style={[
        styles.banner,
        compact && styles.compactBanner,
        isConnected
          ? styles.connected
          : isSyncError
            ? styles.syncError
            : isConnecting
              ? styles.connecting
              : styles.disconnected,
      ]}
      onPress={onPress}
    >
      <View style={styles.contentRow}>
        <View
          style={[
            styles.statusDot,
            {
              backgroundColor: isConnected
                ? colors.statusOk
                : isConnecting
                  ? colors.statusWarn
                  : colors.statusFail,
            },
          ]}
        />
        <View style={styles.textBlock}>
          <Text style={styles.text} numberOfLines={1}>
            {connectionTitle}
          </Text>
          {!compact && (
            <Text style={styles.detailText} numberOfLines={1}>
              {connectionDetail}
            </Text>
          )}
        </View>
        <Text style={styles.actionText}>{compact ? 'Edit' : 'Settings'}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  banner: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  compactBanner: {
    paddingVertical: spacing.xs,
  },
  connected: {
    backgroundColor: colors.statusOk + '18',
  },
  connecting: {
    backgroundColor: colors.statusWarn + '30',
  },
  disconnected: {
    backgroundColor: colors.statusFail + '30',
  },
  syncError: {
    backgroundColor: colors.statusWarn + '30',
  },
  contentRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
  },
  statusDot: {
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  textBlock: {
    flex: 1,
    minWidth: 0,
  },
  text: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '600',
  },
  detailText: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    marginTop: 2,
  },
  actionText: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
});
