import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import 'expo-dev-client';

import { AppEnvironmentIndicator } from '../components/AppEnvironmentIndicator';
import { AppUpdatesMonitor } from '../components/AppUpdatesMonitor';
import { FallbackHeaderBack } from '../components/FallbackHeaderBack';
import { GlobalFilterCoordinator } from '../components/GlobalFilterCoordinator';
import { PRPushRegistration } from '../components/PRPushRegistration';
import { WhatsNewMonitor } from '../components/WhatsNewMonitor';
import { RecipeBridgeProvider } from '../farmslot';
import { QuickActionsProvider } from '../features/quick-actions/QuickActionsProvider';
import { QuickActionsRoot } from '../features/quick-actions/QuickActionsRoot';
import { initNotifications } from '../lib/notifications';
import { isStoreScreenshotMode, seedStoreScreenshotMode } from '../lib/store-screenshot-mode';
import { colors } from '../lib/theme';
import { useAttentionPrefsStore } from '../store/attention-prefs';
import { useConnectionStore } from '../store/connection';
import { useTerminalPrefsStore } from '../store/terminal-prefs';

export default function RootLayout() {
  const init = useConnectionStore((s) => s.init);
  const access = useConnectionStore((s) => s.workspaceAccess);
  const authorityEpoch = useConnectionStore((s) => s.authorityEpoch);
  const farm = isStoreScreenshotMode || access === 'farm';
  const initTerminalPrefs = useTerminalPrefsStore((s) => s.init);
  const initAttentionPrefs = useAttentionPrefsStore((s) => s.init);

  useEffect(() => {
    if (isStoreScreenshotMode) {
      seedStoreScreenshotMode();
    } else {
      init();
    }
    void initTerminalPrefs();
    void initAttentionPrefs();
  }, [init, initAttentionPrefs, initTerminalPrefs]);

  useEffect(() => {
    if (
      farm &&
      !isStoreScreenshotMode &&
      (!__DEV__ || process.env.EXPO_PUBLIC_FARMSLOT_RECIPE_BRIDGE !== '1')
    )
      initNotifications();
  }, [farm]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <WorkspaceProviders farm={farm} key={authorityEpoch}>
        <QuickActionsProvider>
          <StatusBar style="light" />
          {farm ? <GlobalFilterCoordinator /> : null}
          {farm && !isStoreScreenshotMode ? (
            <>
              <PRPushRegistration />
              <WhatsNewMonitor />
              <AppUpdatesMonitor />
            </>
          ) : null}
          <Stack
            screenOptions={{
              headerStyle: { backgroundColor: colors.bgSurface },
              headerTintColor: colors.textPrimary,
              contentStyle: { backgroundColor: colors.bgBase },
            }}
          >
            <Stack.Screen name="index" options={{ headerShown: false }} />
            <Stack.Screen name="connection" options={{ title: 'Gateway connection' }} />
            <Stack.Protected guard={farm || access === 'none'}>
              <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            </Stack.Protected>
            <Stack.Protected guard={farm || access === 'native'}>
              <Stack.Screen name="native" options={{ title: 'Conversations' }} />
            </Stack.Protected>
            <Stack.Protected guard={farm}>
              <Stack.Screen
                name="pr-automation"
                options={{
                  title: 'PR monitoring',
                  headerLeft: () => <FallbackHeaderBack fallbackHref="/(tabs)/prs" />,
                }}
              />
              <Stack.Screen
                name="filters"
                options={{
                  headerShown: false,
                  presentation: 'formSheet',
                  sheetAllowedDetents: [0.55, 0.9],
                  sheetGrabberVisible: true,
                  sheetInitialDetentIndex: 1,
                }}
              />
              <Stack.Screen
                name="run-filters"
                options={{
                  headerShown: false,
                  presentation: 'formSheet',
                  sheetAllowedDetents: [0.55, 0.9],
                  sheetGrabberVisible: true,
                  sheetInitialDetentIndex: 1,
                }}
              />
              <Stack.Screen
                name="backlog/create"
                options={{
                  headerShown: false,
                  presentation: 'formSheet',
                  sheetAllowedDetents: [0.65, 0.95],
                  sheetGrabberVisible: true,
                  sheetInitialDetentIndex: 1,
                }}
              />
              <Stack.Screen
                name="backlog/edit/[id]"
                options={{
                  headerShown: false,
                  presentation: 'formSheet',
                  sheetAllowedDetents: [0.65, 0.95],
                  sheetGrabberVisible: true,
                  sheetInitialDetentIndex: 1,
                }}
              />
              <Stack.Screen
                name="backlog/[id]"
                options={{
                  title: 'Backlog item',
                  headerLeft: () => <FallbackHeaderBack fallbackHref="/(tabs)/backlog" />,
                }}
              />
              <Stack.Screen
                name="roadmap/[id]"
                options={{
                  title: 'Roadmap item',
                  headerLeft: () => <FallbackHeaderBack fallbackHref="/(tabs)/roadmap" />,
                }}
              />
              <Stack.Screen
                name="slot/[id]"
                options={{
                  title: 'Slot Detail',
                  headerLeft: () => <FallbackHeaderBack fallbackHref="/(tabs)/fleet" />,
                }}
              />
              <Stack.Screen name="workspace/slot/[slotId]" options={{ headerShown: false }} />
              <Stack.Screen name="workspace/run/[runId]" options={{ headerShown: false }} />
              <Stack.Screen
                name="run/[id]"
                options={{
                  title: 'Run Detail',
                  headerLeft: () => <FallbackHeaderBack fallbackHref="/(tabs)/runs" />,
                }}
              />
              <Stack.Screen
                name="family/[familyId]"
                options={{
                  title: 'Family Workspace',
                  headerLeft: () => <FallbackHeaderBack fallbackHref="/(tabs)/runs" />,
                }}
              />
              <Stack.Screen
                name="decision/[id]"
                options={{
                  title: 'Review Gate',
                  headerLeft: () => <FallbackHeaderBack fallbackHref="/(tabs)/inbox" />,
                }}
              />
              <Stack.Screen name="terminal/[slotId]" options={{ headerShown: false }} />
              <Stack.Screen name="terminal/worker" options={{ headerShown: false }} />
              <Stack.Screen
                name="prs"
                options={{
                  title: 'Pull Requests',
                  headerLeft: () => <FallbackHeaderBack fallbackHref="/(tabs)/settings" />,
                }}
              />
              <Stack.Screen
                name="evidence/[runId]"
                options={{
                  title: 'Evidence',
                  headerLeft: () => <FallbackHeaderBack fallbackHref="/(tabs)/runs" />,
                }}
              />
              <Stack.Screen
                name="gate-review/[decisionId]"
                options={{
                  title: 'Gate review',
                  headerLeft: () => <FallbackHeaderBack fallbackHref="/(tabs)/inbox" />,
                }}
              />
              <Stack.Screen
                name="visual-review/[runId]"
                options={{
                  title: 'Visual review',
                  headerLeft: () => <FallbackHeaderBack fallbackHref="/(tabs)/runs" />,
                }}
              />
              <Stack.Screen name="artifacts/[runId]" options={{ headerShown: false }} />
              <Stack.Screen name="diff/[runId]" options={{ headerShown: false }} />
              <Stack.Screen name="diff/slot/[slotId]" options={{ headerShown: false }} />
            </Stack.Protected>
          </Stack>
          {!isStoreScreenshotMode ? <AppEnvironmentIndicator /> : null}
          {!isStoreScreenshotMode ? <QuickActionsRoot /> : null}
        </QuickActionsProvider>
      </WorkspaceProviders>
    </GestureHandlerRootView>
  );
}

function WorkspaceProviders({ farm, children }: { farm: boolean; children: React.ReactNode }) {
  return farm ? (
    <RecipeBridgeProvider bridgeName="@farmslot/companion">{children}</RecipeBridgeProvider>
  ) : (
    <>{children}</>
  );
}
