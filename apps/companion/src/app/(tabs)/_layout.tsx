import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import React, { useMemo } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ConnectionBanner } from '../../components/ConnectionBanner';
import { FilterBar } from '../../components/FilterBar';
import { colors } from '../../lib/theme';
import { useDecisionStore } from '../../store/decisions';
import { filterDecisions, useFilterStore } from '../../store/filters';
import { useFleetStore } from '../../store/fleet';

export default function TabLayout() {
  const insets = useSafeAreaInsets();
  const decisions = useDecisionStore((s) => s.decisions);
  const fleet = useFleetStore((s) => s.fleet);
  const filters = useFilterStore((s) => s.filters);
  const filteredDecisionCount = useMemo(() => {
    const slotById = new Map(
      (fleet?.slots ?? []).map(
        (slot) => [slot.slot, { project: slot.project, machine: slot.machine }] as const,
      ),
    );
    return filterDecisions(decisions, filters, slotById).length;
  }, [decisions, filters, fleet]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bgBase }}>
      <Tabs
        screenOptions={{
          tabBarActiveTintColor: colors.accent,
          tabBarInactiveTintColor: colors.textMuted,
          tabBarStyle: {
            backgroundColor: colors.bgSurface,
            borderTopColor: colors.bgCard,
          },
          headerStyle: {
            backgroundColor: colors.bgSurface,
          },
          headerTintColor: colors.textPrimary,
          sceneStyle: { backgroundColor: colors.bgBase },
        }}
      >
        <Tabs.Screen
          name="runs"
          options={{
            title: 'Active',
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="play-circle-outline" size={size} color={color} />
            ),
            header: () => (
              <View style={{ paddingTop: insets.top, backgroundColor: colors.bgSurface }}>
                <ConnectionBanner />
                <FilterBar />
              </View>
            ),
          }}
        />
        <Tabs.Screen
          name="fleet"
          options={{
            title: 'Fleet',
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="grid-outline" size={size} color={color} />
            ),
            header: () => (
              <View style={{ paddingTop: insets.top, backgroundColor: colors.bgSurface }}>
                <ConnectionBanner />
                <FilterBar />
              </View>
            ),
          }}
        />
        <Tabs.Screen
          name="workers"
          options={{
            title: 'Terminals',
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="terminal-outline" size={size} color={color} />
            ),
            header: () => (
              <View style={{ paddingTop: insets.top, backgroundColor: colors.bgSurface }}>
                <ConnectionBanner />
                <FilterBar />
              </View>
            ),
          }}
        />
        <Tabs.Screen
          name="prs"
          options={{
            title: 'PRs',
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="git-pull-request-outline" size={size} color={color} />
            ),
            header: () => (
              <View style={{ paddingTop: insets.top, backgroundColor: colors.bgSurface }}>
                <ConnectionBanner />
                <FilterBar />
              </View>
            ),
          }}
        />
        <Tabs.Screen
          name="copilot"
          options={{
            title: 'Co-Pilot',
            href: null,
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="chatbubble-ellipses-outline" size={size} color={color} />
            ),
            header: () => (
              <View style={{ paddingTop: insets.top, backgroundColor: colors.bgSurface }}>
                <ConnectionBanner />
              </View>
            ),
          }}
        />
        <Tabs.Screen
          name="inbox"
          options={{
            title: 'Inbox',
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="mail-outline" size={size} color={color} />
            ),
            tabBarBadge: filteredDecisionCount > 0 ? filteredDecisionCount : undefined,
            header: () => (
              <View style={{ paddingTop: insets.top, backgroundColor: colors.bgSurface }}>
                <ConnectionBanner />
                <FilterBar />
              </View>
            ),
          }}
        />
        <Tabs.Screen
          name="settings"
          options={{
            title: 'Settings',
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="settings-outline" size={size} color={color} />
            ),
          }}
        />
      </Tabs>
    </View>
  );
}
