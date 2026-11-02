import { useFocusEffect } from 'expo-router';
import { useCallback } from 'react';

/**
 * Log `[farmslot-perf] shown <screen>` from the second animation frame after the
 * screen takes focus. The frames are vsync-driven, so by the second one the
 * frame that mounts the screen has been drawn, and a stalled mount delays them
 * too. The jank check times a tab press from its touch to this logcat line.
 */
export function useShownMarker(screen: string): void {
  useFocusEffect(
    useCallback(() => {
      let second: number | undefined;
      const first = requestAnimationFrame(() => {
        second = requestAnimationFrame(() => {
          console.info(`[farmslot-perf] shown ${screen}`);
        });
      });
      return () => {
        cancelAnimationFrame(first);
        if (second !== undefined) cancelAnimationFrame(second);
      };
    }, [screen]),
  );
}
