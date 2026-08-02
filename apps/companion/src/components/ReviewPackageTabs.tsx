import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors, fonts, radii, spacing } from '../lib/theme';

export type ReviewPackageTabId = 'diff' | 'evidence' | 'files' | 'terminal' | 'timeline';

export interface ReviewPackageTab {
  id: ReviewPackageTabId;
  label: string;
  meta?: string;
  icon: keyof typeof Ionicons.glyphMap;
  disabled?: boolean;
  onPress: () => void;
}

export function ReviewPackageTabs({
  active,
  tabs,
  summary,
}: {
  active: ReviewPackageTabId;
  tabs: ReviewPackageTab[];
  summary?: string;
}) {
  return (
    <View style={styles.wrap}>
      <View style={styles.headerRow}>
        <Text style={styles.eyebrow}>Review package</Text>
        {summary ? (
          <Text style={styles.summary} numberOfLines={1}>
            {summary}
          </Text>
        ) : null}
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.rail}
      >
        {tabs.map((tab) => {
          const selected = tab.id === active;
          return (
            <Pressable
              key={tab.id}
              testID={`companion-review-package-tab-${tab.id}`}
              disabled={tab.disabled}
              style={[styles.tab, selected && styles.tabActive, tab.disabled && styles.tabDisabled]}
              onPress={tab.onPress}
            >
              <Ionicons
                name={tab.icon}
                size={17}
                color={selected ? colors.textPrimary : colors.accentHover}
              />
              <View style={styles.tabTextBlock}>
                <Text style={[styles.tabLabel, selected && styles.tabLabelActive]}>
                  {tab.label}
                </Text>
                {tab.meta ? <Text style={styles.tabMeta}>{tab.meta}</Text> : null}
              </View>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: colors.bgSurface,
    borderColor: colors.bgCardHover,
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.lg,
  },
  headerRow: {
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
  },
  eyebrow: {
    color: colors.textMuted,
    fontFamily: fonts.mono,
    fontSize: fonts.sizeSm,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  summary: {
    color: colors.textSecondary,
    flex: 1,
    fontSize: fonts.sizeSm,
    textAlign: 'right',
  },
  rail: {
    gap: spacing.md,
  },
  tab: {
    alignItems: 'center',
    backgroundColor: colors.bgCard,
    borderColor: colors.accentDim,
    borderRadius: radii.lg,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    minWidth: 112,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  tabActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accentHover,
  },
  tabDisabled: {
    opacity: 0.45,
  },
  tabTextBlock: {
    gap: spacing.xs,
  },
  tabLabel: {
    color: colors.accentHover,
    fontSize: fonts.sizeSm,
    fontWeight: '800',
  },
  tabLabelActive: {
    color: colors.textPrimary,
  },
  tabMeta: {
    color: colors.textSecondary,
    fontSize: fonts.sizeXs,
    fontWeight: '700',
  },
});
