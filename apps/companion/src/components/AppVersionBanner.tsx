import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import {
  formatCompanionVersionSubtitle,
  getCompanionEnvironment,
} from '../lib/app-environment';
import { colors, fonts, spacing } from '../lib/theme';

export function AppVersionBanner() {
  const appEnvironment = getCompanionEnvironment();
  return (
    <View style={styles.row} accessibilityRole="header">
      <View style={[styles.dot, { backgroundColor: appEnvironment.appAccentColor }]} />
      <Text style={styles.line} numberOfLines={1}>
        <Text style={styles.name}>{appEnvironment.appDisplayName}</Text>
        <Text style={styles.meta}> · {formatCompanionVersionSubtitle(appEnvironment)}</Text>
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.md,
    paddingVertical: spacing.xs,
  },
  dot: {
    borderRadius: 3,
    flexShrink: 0,
    height: 6,
    width: 6,
  },
  line: {
    color: colors.textSecondary,
    flex: 1,
    fontFamily: fonts.mono,
    fontSize: fonts.sizeXs,
    minWidth: 0,
  },
  name: {
    color: colors.textPrimary,
    fontWeight: '700',
  },
  meta: {
    color: colors.textMuted,
  },
});
