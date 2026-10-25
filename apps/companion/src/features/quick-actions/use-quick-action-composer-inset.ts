import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import type { LayoutChangeEvent } from 'react-native';

import { useQuickActions } from './quick-actions-context';

/** Reserve the actual bottom composer height, including keyboard-driven reflow. */
export function useQuickActionComposerInset(active: boolean) {
  const { scope, routeKey, registerComposerInset } = useQuickActions();
  const [height, setHeight] = useState(0);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    setHeight(event.nativeEvent.layout.height);
  }, []);
  useFocusEffect(
    useCallback(() => {
      if (!active || !Number.isFinite(height) || height <= 0) return;
      return registerComposerInset({ scope, routeKey, height });
    }, [active, height, registerComposerInset, routeKey, scope]),
  );
  return onLayout;
}
