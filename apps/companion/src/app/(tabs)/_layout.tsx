import { Ionicons } from '@expo/vector-icons';
import { Redirect, Tabs } from 'expo-router';
import React from 'react';
import { type ColorValue, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ConnectionBanner } from '../../components/ConnectionBanner';
import { FilterBar } from '../../components/FilterBar';
import { OfflineShown } from '../../components/offline-shown';
import { isStoreScreenshotMode } from '../../lib/store-screenshot-mode';
import { colors } from '../../lib/theme';
import { useWorkspaceRenderAccess } from '../../lib/use-workspace-render-access';
import { workspaceHome } from '../../lib/workspace-access';

// React Navigation passes tab icons a string; RN 0.88 widened ColorValue to null and numbers.
const tabIconColor = (color: ColorValue) => (typeof color === 'string' ? color : undefined);

export default function TabLayout() {
  const insets = useSafeAreaInsets();
  const access = useWorkspaceRenderAccess();
  if (!isStoreScreenshotMode && access === 'native') {
    return <Redirect href={workspaceHome(access)} />;
  }
  const farmTabs = isStoreScreenshotMode || access === 'farm';
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
      {/* Every tab but Settings shows the banner, and Settings has no read-status slot. */}
      <OfflineShown.Provider value={true}>
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
              href: farmTabs ? undefined : null,
              tabBarButtonTestID: 'companion-tab-review',
              tabBarIcon: ({ color, size }) => (
                <Ionicons name="play-circle-outline" size={size} color={tabIconColor(color)} />
              ),
              header: () => filteredHeader,
            }}
          />
          <Tabs.Screen
            name="fleet"
            options={{
              title: 'Fleet',
              href: null,
              tabBarIcon: ({ color, size }) => (
                <Ionicons name="grid-outline" size={size} color={tabIconColor(color)} />
              ),
              header: () => filteredHeader,
            }}
          />
          <Tabs.Screen
            name="workers"
            options={{
              title: 'Terminals',
              href: farmTabs ? undefined : null,
              tabBarButtonTestID: 'companion-tab-terminals',
              tabBarIcon: ({ color, size }) => (
                <Ionicons name="terminal-outline" size={size} color={tabIconColor(color)} />
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
                <Ionicons name="git-pull-request-outline" size={size} color={tabIconColor(color)} />
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
                <Ionicons
                  name="chatbubble-ellipses-outline"
                  size={size}
                  color={tabIconColor(color)}
                />
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
            name="roadmap"
            options={{
              title: 'Roadmap',
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
                <Ionicons name="mail-outline" size={size} color={tabIconColor(color)} />
              ),
              header: () => filteredHeader,
            }}
          />
          <Tabs.Screen
            name="advanced"
            options={{
              title: 'Advanced',
              href: farmTabs ? undefined : null,
              tabBarButtonTestID: 'companion-tab-advanced',
              tabBarIcon: ({ color, size }) => (
                <Ionicons
                  name="ellipsis-horizontal-circle-outline"
                  size={size}
                  color={tabIconColor(color)}
                />
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
                <Ionicons name="settings-outline" size={size} color={tabIconColor(color)} />
              ),
            }}
          />
        </Tabs>
      </OfflineShown.Provider>
    </View>
  );
}
