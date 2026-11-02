import { useFocusEffect } from 'expo-router';
import { useCallback } from 'react';

/**
 * Log `[farmslot-perf] shown <screen>` each time the screen takes focus. The jank
 * check times a tab press from its touch to the frame after this logcat line.
 */
export function useShownMarker(screen: string): void {
  useFocusEffect(
    useCallback(() => {
      console.info(`[farmslot-perf] shown ${screen}`);
    }, [screen]),
  );
}
