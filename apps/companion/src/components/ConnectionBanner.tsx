import { useRouter } from 'expo-router';
import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { connectionHealthCanRetry } from '../lib/connection-liveness';
import { retryNativeDecisions } from '../lib/run-collections';
import { colors, fonts, spacing } from '../lib/theme';
import { useConnectionStore } from '../store/connection';
import { useHeldConnection } from '../store/held-connection';
import { useRunStore } from '../store/runs';

import {
  OUTAGE_BANNER,
  resolveBannerContent,
  useVisibleConnectionBanner,
} from './connection-banner-visibility';

interface ConnectionBannerProps {
  compact?: boolean;
}

export function ConnectionBanner({ compact = false }: ConnectionBannerProps) {
  const router = useRouter();
  const healthStatus = useConnectionStore((s) => s.healthStatus);
  const transportStatus = useConnectionStore((s) => s.status);
  const probeInProgress = useConnectionStore((s) => s.probeInProgress);
  const retryConnection = useConnectionStore((s) => s.retryConnection);
  const retryDecisionSync = retryNativeDecisions;
  const lastSyncError = useConnectionStore((s) => s.lastSyncError);
  const gatewayCompatibilityHint = useConnectionStore((s) => s.gatewayCompatibilityHint);
  const gatewayUrl = useConnectionStore((s) => s.gatewayUrl);
  const profiles = useConnectionStore((s) => s.profiles);
  const activeProfileId = useConnectionStore((s) => s.activeProfileId);
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
    lastSyncError,
    runsSyncMessage,
    gatewayCompatibilityHint,
    activeProfile?.name ?? gatewayUrl,
  );

  const heldConnected = useHeldConnection();
  const visible = useVisibleConnectionBanner(banner, {
    held: heldConnected,
    stuck: banner.tone === 'syncError' || healthStatus === 'socket-up-not-proven',
    outage: OUTAGE_BANNER,
  });
  if (!visible) return null;
  const canRetry = connectionHealthCanRetry(
    healthStatus,
    transportStatus,
    gatewayCompatibilityHint !== null,
  );
  const canRetryDecisionSync = Boolean(
    healthStatus === 'healthy' && lastSyncError?.startsWith('Failed to refresh decisions'),
  );

  const openProfiles = () => {
    router.push('/settings');
  };

  return (
    <View style={[styles.banner, compact && styles.compactBanner]}>
      <View style={styles.contentRow}>
        <View
          style={[
            styles.statusDot,
            {
              backgroundColor:
                visible.tone === 'connecting'
                  ? colors.statusWarn
                  : visible.tone === 'syncError'
                    ? colors.statusWarn
                    : colors.statusFail,
            },
          ]}
        />
        <Text style={styles.text} numberOfLines={1}>
          {visible.title}
        </Text>
        <View style={styles.actions}>
          {canRetryDecisionSync ? (
            <Pressable style={styles.actionButton} onPress={() => void retryDecisionSync()}>
              <Text style={styles.actionText}>Retry</Text>
            </Pressable>
          ) : null}
          {canRetry ? (
            <Pressable
              style={styles.actionButton}
              onPress={() => void retryConnection()}
              disabled={probeInProgress}
            >
              <Text style={styles.actionText}>{probeInProgress ? 'Testing…' : 'Retry'}</Text>
            </Pressable>
          ) : null}
          {!canRetryDecisionSync ? (
            <Pressable style={styles.actionButton} onPress={openProfiles}>
              <Text style={styles.actionText}>Profiles</Text>
            </Pressable>
          ) : null}
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
  actions: {
    flexDirection: 'row',
    gap: spacing.xs,
  },
  actionButton: {
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
  },
  text: {
    color: colors.textSecondary,
    flex: 1,
    fontSize: fonts.sizeXs,
    minWidth: 0,
  },
  actionText: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
});
