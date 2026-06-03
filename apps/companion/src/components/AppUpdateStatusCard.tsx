import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { type AppUpdateStatus, useAppUpdates } from '../hooks/useAppUpdates';
import { colors, fonts, radii, spacing } from '../lib/theme';

const STATUS_LABEL: Record<AppUpdateStatus, string> = {
  disabled: 'disabled',
  idle: 'current',
  checking: 'checking',
  downloading: 'downloading',
  downloaded: 'ready',
  restarting: 'restarting',
  error: 'error',
};

function statusColor(status: AppUpdateStatus): string {
  if (status === 'error') return colors.statusFail;
  if (status === 'downloaded' || status === 'restarting') return colors.statusWarn;
  if (status === 'disabled') return colors.textMuted;
  return colors.statusOk;
}

export function AppUpdateStatusCard() {
  const updateState = useAppUpdates();
  const busy =
    updateState.status === 'checking' ||
    updateState.status === 'downloading' ||
    updateState.status === 'restarting';
  const canCheck = updateState.status !== 'disabled' && !busy;
  const canRestart = updateState.status === 'downloaded' && !busy;
  const color = statusColor(updateState.status);

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View style={styles.titleBlock}>
          <Text style={styles.eyebrow}>OTA Updates</Text>
          <Text style={styles.title}>Expo Update Channel</Text>
        </View>
        <View style={[styles.pill, { borderColor: color + '88' }]}>
          <View style={[styles.dot, { backgroundColor: color }]} />
          <Text style={[styles.pillText, { color }]}>{STATUS_LABEL[updateState.status]}</Text>
        </View>
      </View>

      <Text style={styles.message}>{updateState.message}</Text>
      <View style={styles.metaGrid}>
        <UpdateDetail label="Channel" value={updateState.channel ?? 'unknown'} />
        <UpdateDetail label="Runtime" value={updateState.runtimeVersion ?? 'unknown'} />
        <UpdateDetail label="Launch" value={updateState.isEmbeddedLaunch ? 'embedded' : 'OTA'} />
        <UpdateDetail label="Update ID" value={updateState.currentUpdateId ?? 'embedded'} />
      </View>

      <View style={styles.buttonRow}>
        <Pressable
          style={[styles.button, !canCheck && styles.disabledButton]}
          onPress={() => void updateState.checkUpdates({ silent: false })}
          disabled={!canCheck}
        >
          {busy && updateState.status !== 'restarting' ? <ActivityIndicator color="#fff" /> : null}
          <Text style={styles.buttonText}>Check Now</Text>
        </Pressable>
        {canRestart ? (
          <Pressable
            style={[styles.button, styles.secondaryButton]}
            onPress={() => void updateState.reloadDownloadedUpdate()}
          >
            <Text style={styles.buttonText}>Restart</Text>
          </Pressable>
        ) : null}
      </View>
      {updateState.isEmergencyLaunch ? (
        <Text style={styles.warningText}>Expo Updates started from emergency fallback.</Text>
      ) : null}
    </View>
  );
}

function UpdateDetail({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.bgCard,
    borderColor: colors.bgCardHover,
    borderRadius: radii.lg,
    borderWidth: 1,
    marginBottom: spacing.xxl,
    padding: spacing.lg,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  titleBlock: {
    flex: 1,
    minWidth: 0,
  },
  eyebrow: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  title: {
    color: colors.textPrimary,
    fontSize: fonts.sizeMd,
    fontWeight: '800',
    marginTop: spacing.xs,
  },
  pill: {
    alignItems: 'center',
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  dot: {
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  pillText: {
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  message: {
    color: colors.textSecondary,
    fontSize: fonts.sizeSm,
    lineHeight: 18,
    marginBottom: spacing.md,
  },
  metaGrid: {
    gap: spacing.sm,
  },
  detailRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
  },
  detailLabel: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  detailValue: {
    color: colors.textSecondary,
    flex: 1,
    fontFamily: fonts.mono,
    fontSize: fonts.sizeXs,
    textAlign: 'right',
  },
  buttonRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    marginTop: spacing.lg,
  },
  button: {
    alignItems: 'center',
    backgroundColor: colors.accent,
    borderRadius: radii.md,
    flex: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'center',
    minWidth: 140,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  secondaryButton: {
    backgroundColor: colors.bgCardHover,
  },
  disabledButton: {
    opacity: 0.5,
  },
  buttonText: {
    color: '#fff',
    fontSize: fonts.sizeMd,
    fontWeight: '700',
  },
  warningText: {
    color: colors.statusWarn,
    fontSize: fonts.sizeXs,
    lineHeight: 16,
    marginTop: spacing.md,
  },
});
