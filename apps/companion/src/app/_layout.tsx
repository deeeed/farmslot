import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Stack, useGlobalSearchParams, usePathname, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PanResponder, StyleSheet, useWindowDimensions, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import 'expo-dev-client';

import { AppEnvironmentIndicator } from '../components/AppEnvironmentIndicator';
import { AppUpdatesMonitor } from '../components/AppUpdatesMonitor';
import { FallbackHeaderBack } from '../components/FallbackHeaderBack';
import { GlobalFilterCoordinator } from '../components/GlobalFilterCoordinator';
import { RecipeBridgeProvider } from '../farmslot';
import { initNotifications } from '../lib/notifications';
import { isStoreScreenshotMode, seedStoreScreenshotMode } from '../lib/store-screenshot-mode';
import { colors } from '../lib/theme';
import { buildWorkspaceCopilotDraftForRoute } from '../lib/workspace-copilot';
import { useConnectionStore } from '../store/connection';
import { useTerminalPrefsStore } from '../store/terminal-prefs';

const COPILOT_FAB_SIZE = 36;
const COPILOT_FAB_MARGIN = 12;
const COPILOT_TAB_BAR_CLEARANCE = 76;
const COPILOT_STACK_BOTTOM_CLEARANCE = 96;
const COPILOT_FAB_POSITION_STORAGE_KEY = '@farmslot:copilotFabPosition';

export default function RootLayout() {
  const init = useConnectionStore((s) => s.init);
  const initTerminalPrefs = useTerminalPrefsStore((s) => s.init);

  useEffect(() => {
    if (isStoreScreenshotMode) {
      seedStoreScreenshotMode();
    } else {
      initNotifications();
      init();
    }
    void initTerminalPrefs();
  }, [init, initTerminalPrefs]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <RecipeBridgeProvider bridgeName="@farmslot/companion">
        <StatusBar style="light" />
        <GlobalFilterCoordinator />
        {!isStoreScreenshotMode ? <AppUpdatesMonitor /> : null}
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: colors.bgSurface },
            headerTintColor: colors.textPrimary,
            contentStyle: { backgroundColor: colors.bgBase },
          }}
        >
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen
            name="slot/[id]"
            options={{
              title: 'Slot Detail',
              headerLeft: () => <FallbackHeaderBack fallbackHref="/(tabs)/fleet" />,
            }}
          />
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
            name="artifacts/[runId]"
            options={{
              title: 'Artifacts',
              headerLeft: () => <FallbackHeaderBack fallbackHref="/(tabs)/runs" />,
            }}
          />
          <Stack.Screen name="diff/[runId]" options={{ headerShown: false }} />
          <Stack.Screen name="diff/slot/[slotId]" options={{ headerShown: false }} />
        </Stack>
        {!isStoreScreenshotMode ? <AppEnvironmentIndicator /> : null}
        {!isStoreScreenshotMode ? <FloatingCopilotButton /> : null}
      </RecipeBridgeProvider>
    </GestureHandlerRootView>
  );
}

function FloatingCopilotButton() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useGlobalSearchParams();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const isTabsRoute =
    pathname.startsWith('/runs') ||
    pathname.startsWith('/fleet') ||
    pathname.startsWith('/prs') ||
    pathname.startsWith('/inbox') ||
    pathname.startsWith('/settings');
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const positionRef = useRef<{ x: number; y: number } | null>(null);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const loadedStoredPositionRef = useRef(false);
  const positionPersistenceErrorRef = useRef<string | null>(null);

  const clampPosition = useCallback(
    (next: { x: number; y: number }) => {
      const minX = COPILOT_FAB_MARGIN + insets.left;
      const maxX = Math.max(minX, width - insets.right - COPILOT_FAB_MARGIN - COPILOT_FAB_SIZE);
      const minY = COPILOT_FAB_MARGIN + insets.top;
      const routeBottomClearance = isTabsRoute
        ? COPILOT_TAB_BAR_CLEARANCE
        : COPILOT_STACK_BOTTOM_CLEARANCE;
      const maxY = Math.max(
        minY,
        height - insets.bottom - COPILOT_FAB_MARGIN - routeBottomClearance - COPILOT_FAB_SIZE,
      );
      return {
        x: Math.min(maxX, Math.max(minX, next.x)),
        y: Math.min(maxY, Math.max(minY, next.y)),
      };
    },
    [height, insets.bottom, insets.left, insets.right, insets.top, isTabsRoute, width],
  );

  const defaultPosition = useMemo(
    () =>
      clampPosition({
        x: width - insets.right - COPILOT_FAB_MARGIN - COPILOT_FAB_SIZE,
        y:
          height -
          Math.max(insets.bottom, COPILOT_FAB_MARGIN) -
          (isTabsRoute ? COPILOT_TAB_BAR_CLEARANCE : COPILOT_STACK_BOTTOM_CLEARANCE) -
          COPILOT_FAB_SIZE,
      }),
    [clampPosition, height, insets.bottom, insets.right, isTabsRoute, width],
  );
  const currentPosition = position ?? defaultPosition;

  useEffect(() => {
    positionRef.current = currentPosition;
  }, [currentPosition]);

  useEffect(() => {
    setPosition((current) => (current ? clampPosition(current) : current));
  }, [clampPosition]);

  useEffect(() => {
    if (loadedStoredPositionRef.current) return;
    loadedStoredPositionRef.current = true;
    let disposed = false;
    AsyncStorage.getItem(COPILOT_FAB_POSITION_STORAGE_KEY).then(
      (raw) => {
        if (disposed || !raw) return;
        const parsed = parseStoredFabPosition(raw);
        if (parsed) setPosition(clampPosition(parsed));
      },
      (error: unknown) => {
        // Position persistence is a convenience; the button remains usable at
        // the default in-memory position when storage is temporarily unavailable.
        positionPersistenceErrorRef.current = `Failed to load Co-Pilot button position: ${getErrorMessage(error)}`;
      },
    );
    return () => {
      disposed = true;
    };
  }, [clampPosition]);

  const persistPosition = useCallback((next: { x: number; y: number }) => {
    AsyncStorage.setItem(COPILOT_FAB_POSITION_STORAGE_KEY, JSON.stringify(next)).then(
      () => {
        positionPersistenceErrorRef.current = null;
      },
      (error: unknown) => {
        // Dragging already updated the visible position; keep it in memory even
        // if AsyncStorage fails so the control remains responsive this session.
        positionPersistenceErrorRef.current = `Failed to save Co-Pilot button position: ${getErrorMessage(error)}`;
      },
    );
  }, []);

  const openCopilot = useCallback(() => {
    router.push({
      pathname: '/(tabs)/copilot',
      params: {
        draft: buildWorkspaceCopilotDraftForRoute(pathname, params),
      },
    });
  }, [params, pathname, router]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_event, gesture) =>
          Math.abs(gesture.dx) > 3 || Math.abs(gesture.dy) > 3,
        onPanResponderGrant: () => {
          dragStartRef.current = positionRef.current ?? defaultPosition;
        },
        onPanResponderMove: (_event, gesture) => {
          setPosition(
            clampPosition({
              x: dragStartRef.current.x + gesture.dx,
              y: dragStartRef.current.y + gesture.dy,
            }),
          );
        },
        onPanResponderRelease: (_event, gesture) => {
          const wasDrag = Math.abs(gesture.dx) > 5 || Math.abs(gesture.dy) > 5;
          setPosition((current) => {
            const next = clampPosition(current ?? defaultPosition);
            if (wasDrag) persistPosition(next);
            return next;
          });
          if (!wasDrag) openCopilot();
        },
        onPanResponderTerminate: () => {
          setPosition((current) => {
            const next = current ? clampPosition(current) : current;
            if (next) persistPosition(next);
            return next;
          });
        },
      }),
    [clampPosition, defaultPosition, openCopilot, persistPosition],
  );

  const shouldHide =
    // Terminal owns its own voice/input overlay; keep the global Co-Pilot
    // button out of the xterm touch surface.
    pathname.includes('/copilot') || pathname.includes('/terminal/');
  if (shouldHide) return null;
  return (
    <View
      {...panResponder.panHandlers}
      accessible
      accessibilityLabel="Open Co-Pilot"
      accessibilityRole="button"
      onAccessibilityTap={openCopilot}
      style={[styles.copilotFab, { left: currentPosition.x, top: currentPosition.y }]}
    >
      <Ionicons name="chatbubble-ellipses" size={17} color={colors.bgBase} />
    </View>
  );
}

function parseStoredFabPosition(raw: string): { x: number; y: number } | null {
  try {
    const parsed = JSON.parse(raw) as Partial<{ x: unknown; y: unknown }>;
    return typeof parsed.x === 'number' &&
      Number.isFinite(parsed.x) &&
      typeof parsed.y === 'number' &&
      Number.isFinite(parsed.y)
      ? { x: parsed.x, y: parsed.y }
      : null;
  } catch {
    // Older dev builds may have malformed local storage; falling back to the
    // default position is safe because the user can immediately drag it again.
    return null;
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const styles = StyleSheet.create({
  copilotFab: {
    position: 'absolute',
    zIndex: 50,
    elevation: 8,
    alignItems: 'center',
    justifyContent: 'center',
    width: COPILOT_FAB_SIZE,
    height: COPILOT_FAB_SIZE,
    borderRadius: 999,
    backgroundColor: colors.accent,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.28,
    shadowRadius: 12,
  },
});
