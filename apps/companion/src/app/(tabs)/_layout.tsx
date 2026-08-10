import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import React from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ConnectionBanner } from '../../components/ConnectionBanner';
import { FilterBar } from '../../components/FilterBar';
import { colors } from '../../lib/theme';

export default function TabLayout() {
  const insets = useSafeAreaInsets();
  const connectedHeader = (
    <View style={{ paddingTop: insets.top, backgroundColor: colors.bgSurface }}>
      <ConnectionBanner />
    </View>
  );
  const filteredHeader = (
    <View style={{ paddingTop: insets.top, backgroundColor: colors.bgSurface }}>
      <ConnectionBanner />
      <FilterBar />
    </View>
  );

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
            title: 'Review',
            tabBarButtonTestID: 'companion-tab-review',
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="play-circle-outline" size={size} color={color} />
            ),
            header: () => connectedHeader,
          }}
        />
        <Tabs.Screen
          name="fleet"
          options={{
            title: 'Fleet',
            href: null,
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="grid-outline" size={size} color={color} />
            ),
            header: () => filteredHeader,
          }}
        />
        <Tabs.Screen
          name="workers"
          options={{
            title: 'Terminals',
            tabBarButtonTestID: 'companion-tab-terminals',
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="terminal-outline" size={size} color={color} />
            ),
            header: () => connectedHeader,
          }}
        />
        <Tabs.Screen
          name="prs"
          options={{
            title: 'PRs',
            href: null,
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="git-pull-request-outline" size={size} color={color} />
            ),
            header: () => filteredHeader,
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
            header: () => connectedHeader,
          }}
        />
        <Tabs.Screen
          name="backlog"
          options={{
            title: 'Backlog',
            href: null,
            header: () => filteredHeader,
          }}
        />
        <Tabs.Screen
          name="inbox"
          options={{
            title: 'Inbox',
            href: null,
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="mail-outline" size={size} color={color} />
            ),
            header: () => filteredHeader,
          }}
        />
        <Tabs.Screen
          name="advanced"
          options={{
            title: 'Advanced',
            tabBarButtonTestID: 'companion-tab-advanced',
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="ellipsis-horizontal-circle-outline" size={size} color={color} />
            ),
            header: () => connectedHeader,
          }}
        />
        <Tabs.Screen
          name="settings"
          options={{
            title: 'Settings',
            tabBarButtonTestID: 'companion-tab-settings',
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="settings-outline" size={size} color={color} />
            ),
          }}
        />
      </Tabs>
    </View>
  );
}
