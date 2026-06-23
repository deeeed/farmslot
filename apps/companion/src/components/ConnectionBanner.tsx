import { useRouter } from 'expo-router';
import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, fonts, spacing } from '../lib/theme';
import { useConnectionStore } from '../store/connection';
import { useRunStore } from '../store/runs';

interface ConnectionBannerProps {
  compact?: boolean;
}

type BannerTone = 'connected' | 'connecting' | 'syncError' | 'disconnected';

interface BannerContent {
  title: string;
  detail: string;
  tone: BannerTone;
}

function resolveBannerContent(
  status: ReturnType<typeof useConnectionStore.getState>['status'],
  lastSyncError: string | null,
  runsSyncMessage: string | null,
  gatewayUrl: string,
  activeProfileAuthMode: string,
): BannerContent | null {
  if (status === 'disconnected') {
    return {
      title: 'Disconnected from gateway',
      detail: 'Tap to open connection settings',
      tone: 'disconnected',
    };
  }
  if (status === 'connecting') {
    return {
      title: 'Connecting to gateway…',
      detail: 'Waiting for authentication',
      tone: 'connecting',
    };
  }
  if (runsSyncMessage) {
    return {
      title: runsSyncMessage,
      detail: 'Gateway is connected — downloading run data',
      tone: 'connecting',
    };
  }
  if (lastSyncError) {
    return {
      title: lastSyncError,
      detail: 'Gateway is connected — data sync failed. Tap for settings.',
      tone: 'syncError',
    };
  }
  return {
    title: `Connected · ${gatewayUrl}`,
    detail: activeProfileAuthMode !== 'none' ? `${activeProfileAuthMode} auth` : 'Ready',
    tone: 'connected',
  };
}

export function ConnectionBanner({ compact = false }: ConnectionBannerProps) {
  const router = useRouter();
  const status = useConnectionStore((s) => s.status);
  const lastSyncError = useConnectionStore((s) => s.lastSyncError);
  const gatewayUrl = useConnectionStore((s) => s.gatewayUrl);
  const profiles = useConnectionStore((s) => s.profiles);
  const activeProfileId = useConnectionStore((s) => s.activeProfileId);
  const activeProfileAuthMode = useConnectionStore((s) => s.activeProfileAuthMode);
  const activeLoading = useRunStore((s) => s.activeLoading);
  const historyLoading = useRunStore((s) => s.historyLoading);

  const activeProfile = useMemo(
    () => profiles.find((profile) => profile.id === activeProfileId) ?? null,
    [activeProfileId, profiles],
  );
  const runsSyncMessage = historyLoading
    ? 'Downloading run history…'
    : activeLoading
      ? 'Downloading active runs…'
      : null;

  const banner = resolveBannerContent(
    status,
    lastSyncError,
    runsSyncMessage,
    activeProfile?.name ?? gatewayUrl,
    activeProfileAuthMode ?? 'none',
  );

  if (!banner || banner.tone === 'connected') return null;

  const onPress = () => {
    router.push('/settings');
  };

  return (
    <Pressable
      style={[
        styles.banner,
        compact && styles.compactBanner,
        banner.tone === 'connecting'
          ? styles.connecting
          : banner.tone === 'syncError'
            ? styles.syncError
            : styles.disconnected,
      ]}
      onPress={onPress}
    >
      <View style={styles.contentRow}>
        <View
          style={[
            styles.statusDot,
            {
              backgroundColor:
                banner.tone === 'connecting'
                  ? colors.statusWarn
                  : banner.tone === 'syncError'
                    ? colors.statusWarn
                    : colors.statusFail,
            },
          ]}
        />
        <View style={styles.textBlock}>
          <Text style={styles.text} numberOfLines={2}>
            {banner.title}
          </Text>
          {!compact && (
            <Text style={styles.detailText} numberOfLines={2}>
              {banner.detail}
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
