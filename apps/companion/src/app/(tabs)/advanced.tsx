import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GestureProofSurface } from '../../components/GestureProofSurface';
import { baseStyles, colors, fonts, radii, spacing } from '../../lib/theme';

type AdvancedRoute = {
  testID: string;
  title: string;
  subtitle: string;
  icon: keyof typeof Ionicons.glyphMap;
  pathname: '/(tabs)/fleet' | '/(tabs)/prs' | '/(tabs)/inbox' | '/(tabs)/copilot';
};

const ADVANCED_ROUTES: AdvancedRoute[] = [
  {
    testID: 'companion-advanced-fleet',
    title: 'Fleet',
    subtitle: 'Raw slot grid, lifecycle state, and slot-level drilldowns.',
    icon: 'grid-outline',
    pathname: '/(tabs)/fleet',
  },
  {
    testID: 'companion-advanced-prs',
    title: 'PR dashboard',
    subtitle: 'Full pull request list, CI, reviews, and bot status.',
    icon: 'git-pull-request-outline',
    pathname: '/(tabs)/prs',
  },
  {
    testID: 'companion-advanced-inbox',
    title: 'Decision inbox',
    subtitle: 'All pending ready, review, and retrospective gates with filters.',
    icon: 'mail-outline',
    pathname: '/(tabs)/inbox',
  },
  {
    testID: 'companion-advanced-copilot',
    title: 'Co-Pilot',
    subtitle: 'Global voice/text assistant for fleet questions and suggested actions.',
    icon: 'chatbubble-ellipses-outline',
    pathname: '/(tabs)/copilot',
  },
];

export default function AdvancedScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      testID="companion-screen-advanced"
      collapsable={false}
      style={baseStyles.container}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xxxl }]}
    >
      <View style={styles.heroCard}>
        <Text style={styles.title}>Advanced</Text>
        <Text style={styles.subtitle}>Fleet, backlog, PRs, decisions, and diagnostics.</Text>
        <View style={styles.heroActions}>
          <Pressable
            testID="companion-advanced-backlog"
            style={styles.primaryAction}
            onPress={() => router.push('/(tabs)/backlog')}
          >
            <Ionicons name="list-outline" size={20} color={colors.bgBase} />
            <Text style={styles.primaryActionText}>Backlog</Text>
          </Pressable>
          <Pressable
            testID="companion-create-backlog"
            style={styles.secondaryAction}
            onPress={() => router.push('/backlog/create')}
          >
            <Ionicons name="add-circle-outline" size={20} color={colors.accent} />
            <Text style={styles.secondaryActionText}>New item</Text>
          </Pressable>
          <Pressable
            testID="companion-advanced-roadmap"
            style={styles.secondaryAction}
            onPress={() => router.push('/(tabs)/roadmap')}
          >
            <Ionicons name="map-outline" size={20} color={colors.accent} />
            <Text style={styles.secondaryActionText}>Roadmap</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.routeList}>
        {ADVANCED_ROUTES.map((route) => (
          <Pressable
            key={route.pathname}
            testID={route.testID}
            style={styles.routeCard}
            onPress={() => router.push({ pathname: route.pathname })}
          >
            <View style={styles.iconBadge}>
              <Ionicons name={route.icon} size={22} color={colors.accent} />
            </View>
            <View style={styles.routeText}>
              <Text style={styles.routeTitle}>{route.title}</Text>
              <Text style={styles.routeSubtitle}>{route.subtitle}</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
          </Pressable>
        ))}
      </View>
      <GestureProofSurface />
      <View
        testID="companion-screen-advanced-end"
        accessible
        collapsable={false}
        accessibilityLabel="End of Advanced"
        style={styles.captureEndMarker}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  captureEndMarker: { height: 1 },
  content: {
    padding: spacing.xl,
    gap: spacing.xl,
  },
  heroCard: {
    backgroundColor: colors.bgCard,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.bgCardHover,
    padding: spacing.xl,
    gap: spacing.md,
  },
  title: {
    color: colors.textPrimary,
    fontSize: 24,
    fontWeight: '800',
    lineHeight: 30,
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: fonts.sizeMd,
    lineHeight: 21,
  },
  heroActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  primaryAction: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: colors.accent,
    borderRadius: radii.md,
    flexDirection: 'row',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  primaryActionText: {
    color: colors.bgBase,
    fontSize: fonts.sizeMd,
    fontWeight: '800',
  },
  secondaryAction: {
    alignItems: 'center',
    borderColor: colors.accent,
    borderRadius: radii.md,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  secondaryActionText: { color: colors.accent, fontSize: fonts.sizeMd, fontWeight: '800' },
  routeList: {
    gap: spacing.lg,
  },
  routeCard: {
    alignItems: 'center',
    backgroundColor: colors.bgSurface,
    borderColor: colors.bgCardHover,
    borderRadius: radii.lg,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.lg,
    padding: spacing.xl,
  },
  iconBadge: {
    alignItems: 'center',
    backgroundColor: colors.bgCard,
    borderRadius: 999,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  routeText: {
    flex: 1,
    gap: spacing.sm,
  },
  routeTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeLg,
    fontWeight: '800',
  },
  routeSubtitle: {
    color: colors.textSecondary,
    fontSize: fonts.sizeSm,
    lineHeight: 18,
  },
});
