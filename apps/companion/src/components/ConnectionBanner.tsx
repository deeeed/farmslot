import { useRouter } from 'expo-router';
import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, fonts, spacing } from '../lib/theme';
import { useConnectionStore } from '../store/connection';
import { useRunStore } from '../store/runs';

interface ConnectionBannerProps {
  compact?: boolean;
}

type BannerTone = 'healthy' | 'connecting' | 'syncError' | 'disconnected';

interface BannerContent {
  title: string;
  detail: string;
  tone: BannerTone;
}

function resolveBannerContent(
  healthStatus: ReturnType<typeof useConnectionStore.getState>['healthStatus'],
  lastProbeError: string | null,
  lastSyncError: string | null,
  runsSyncMessage: string | null,
  gatewayUrl: string,
  activeProfileAuthMode: string,
): BannerContent | null {
  if (healthStatus === 'disconnected') {
    return {
      title: 'Disconnected from gateway',
      detail: lastProbeError ?? 'Retry, or switch to another LAN, tailnet, or remote profile.',
      tone: 'disconnected',
    };
  }
  if (healthStatus === 'connecting') {
    return {
      title: 'Connecting to gateway…',
      detail: 'Waiting for authentication',
      tone: 'connecting',
    };
  }
  if (healthStatus === 'socket-up-not-proven') {
    return {
      title: 'Gateway socket connected — proving response…',
      detail: 'Waiting for an authenticated gateway.ping response.',
      tone: 'connecting',
    };
  }
  if (healthStatus === 'degraded') {
    return {
      title: 'Gateway connection degraded',
      detail: lastProbeError ?? 'The socket is open, but the gateway did not answer.',
      tone: 'syncError',
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
    title: `Healthy · ${gatewayUrl}`,
    detail: activeProfileAuthMode !== 'none' ? `${activeProfileAuthMode} auth` : 'Ready',
    tone: 'healthy',
  };
}

export function ConnectionBanner({ compact = false }: ConnectionBannerProps) {
  const router = useRouter();
  const healthStatus = useConnectionStore((s) => s.healthStatus);
  const lastProbeError = useConnectionStore((s) => s.lastProbeError);
  const probeInProgress = useConnectionStore((s) => s.probeInProgress);
  const retryConnection = useConnectionStore((s) => s.retryConnection);
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
    healthStatus,
    lastProbeError,
    lastSyncError,
    runsSyncMessage,
    activeProfile?.name ?? gatewayUrl,
    activeProfileAuthMode ?? 'none',
  );

  if (!banner || banner.tone === 'healthy') return null;

  const openProfiles = () => {
    router.push('/settings');
  };

  return (
    <View
      style={[
        styles.banner,
        compact && styles.compactBanner,
        banner.tone === 'connecting'
          ? styles.connecting
          : banner.tone === 'syncError'
            ? styles.syncError
            : styles.disconnected,
      ]}
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
        <View style={styles.actions}>
          <Pressable
            style={styles.actionButton}
            onPress={() => void retryConnection()}
            disabled={probeInProgress}
          >
            <Text style={styles.actionText}>{probeInProgress ? 'Testing…' : 'Retry'}</Text>
          </Pressable>
          <Pressable style={styles.actionButton} onPress={openProfiles}>
            <Text style={styles.actionText}>{compact ? 'Profiles' : 'Switch profile'}</Text>
          </Pressable>
        </View>
      </View>
    </View>
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
  actions: {
    alignItems: 'flex-end',
    gap: spacing.xs,
  },
  actionButton: {
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
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
