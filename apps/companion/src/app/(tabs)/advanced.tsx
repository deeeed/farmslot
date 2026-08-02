import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BacklogCreateSheet } from '../../components/BacklogCreateSheet';
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
  const [backlogCreateOpen, setBacklogCreateOpen] = useState(false);

  return (
    <>
      <ScrollView
        testID="companion-screen-advanced"
        collapsable={false}
        style={baseStyles.container}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xxxl }]}
      >
        <View style={styles.heroCard}>
          <Text style={styles.eyebrow}>Advanced mode</Text>
          <Text style={styles.title}>Command Center parity lives here.</Text>
          <Text style={styles.subtitle}>
            Review and Terminals stay focused by default. Use these raw dashboards when you need
            broader fleet context, global filters, or diagnostics.
          </Text>
          <Pressable
            testID="companion-create-backlog"
            style={styles.primaryAction}
            onPress={() => setBacklogCreateOpen(true)}
          >
            <Ionicons name="add-circle-outline" size={20} color={colors.bgBase} />
            <Text style={styles.primaryActionText}>Create backlog item</Text>
          </Pressable>
        </View>

        <GestureProofSurface />

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
        <View
          testID="companion-screen-advanced-end"
          accessible
          collapsable={false}
          accessibilityLabel="End of Advanced"
          style={styles.captureEndMarker}
        />
      </ScrollView>
      <BacklogCreateSheet visible={backlogCreateOpen} onClose={() => setBacklogCreateOpen(false)} />
    </>
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
  eyebrow: {
    color: colors.textMuted,
    fontFamily: fonts.mono,
    fontSize: fonts.sizeSm,
    fontWeight: '700',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
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
  primaryAction: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: colors.accent,
    borderRadius: radii.md,
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  primaryActionText: {
    color: colors.bgBase,
    fontSize: fonts.sizeMd,
    fontWeight: '800',
  },
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
