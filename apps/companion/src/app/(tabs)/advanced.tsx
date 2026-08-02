import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GestureProofSurface } from '../../components/GestureProofSurface';
import { baseStyles, colors, fonts, radii, spacing } from '../../lib/theme';

type AdvancedRoute = {
  title: string;
  subtitle: string;
  icon: keyof typeof Ionicons.glyphMap;
  pathname: '/(tabs)/fleet' | '/(tabs)/prs' | '/(tabs)/inbox' | '/(tabs)/copilot';
};

const ADVANCED_ROUTES: AdvancedRoute[] = [
  {
    title: 'Fleet',
    subtitle: 'Raw slot grid, lifecycle state, and slot-level drilldowns.',
    icon: 'grid-outline',
    pathname: '/(tabs)/fleet',
  },
  {
    title: 'PR dashboard',
    subtitle: 'Full pull request list, CI, reviews, and bot status.',
    icon: 'git-pull-request-outline',
    pathname: '/(tabs)/prs',
  },
  {
    title: 'Decision inbox',
    subtitle: 'All pending ready, review, and retrospective gates with filters.',
    icon: 'mail-outline',
    pathname: '/(tabs)/inbox',
  },
  {
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
      </View>

      <GestureProofSurface />

      <View style={styles.routeList}>
        {ADVANCED_ROUTES.map((route) => (
          <Pressable
            key={route.pathname}
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
    </ScrollView>
  );
}

const styles = StyleSheet.create({
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
