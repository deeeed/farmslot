import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { getCompanionEnvironment } from '../lib/app-environment';
import { colors, fonts, radii, spacing } from '../lib/theme';

export function AppEnvironmentCard() {
  const appEnvironment = getCompanionEnvironment();
  return (
    <View style={[styles.card, { borderColor: appEnvironment.appAccentColor + '88' }]}>
      <View style={styles.header}>
        <View style={styles.titleBlock}>
          <Text style={styles.eyebrow}>App Environment</Text>
          <Text style={styles.title}>{appEnvironment.appDisplayName}</Text>
        </View>
        <View
          style={[
            styles.pill,
            {
              backgroundColor: appEnvironment.appAccentColor + '22',
              borderColor: appEnvironment.appAccentColor + 'AA',
            },
          ]}
        >
          <View style={[styles.dot, { backgroundColor: appEnvironment.appAccentColor }]} />
          <Text style={[styles.pillText, { color: appEnvironment.appAccentColor }]}>
            {appEnvironment.appVariant}
          </Text>
        </View>
      </View>
      <View style={styles.grid}>
        <EnvironmentDetailRow label="Bundle" value={appEnvironment.appIdentifier} />
        <EnvironmentDetailRow label="Scheme" value={appEnvironment.appScheme} />
        <EnvironmentDetailRow label="Expo slug" value={appEnvironment.appSlug} />
        <EnvironmentDetailRow label="Version" value={appEnvironment.appVersion} />
        <EnvironmentDetailRow label="Metro" value={appEnvironment.metroPort} />
        <EnvironmentDetailRow label="Gateway" value={appEnvironment.gatewayUrl} />
        <EnvironmentDetailRow label="Remote" value={appEnvironment.remoteGatewayUrl} />
        <EnvironmentDetailRow label="Updates" value={appEnvironment.updateUrl} />
        <EnvironmentDetailRow label="Runtime" value={appEnvironment.runtimeVersion} />
      </View>
    </View>
  );
}

function EnvironmentDetailRow({ label, value }: { label: string; value: string }) {
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
    borderRadius: radii.lg,
    borderWidth: 1,
    marginBottom: spacing.lg,
    padding: spacing.lg,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
    marginBottom: spacing.lg,
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
    fontSize: fonts.sizeLg,
    fontWeight: '900',
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
  grid: {
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
});
