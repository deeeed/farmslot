import { useFocusEffect } from 'expo-router';
import { useCallback } from 'react';

/**
 * Log `[farmslot-perf] shown <screen>` from the second animation frame after the
 * screen takes focus, once React has committed it and JavaScript is free. The
 * UI thread can still be drawing the mount frame then, so the jank check ends a
 * tab press at the end of the last frame that started by two vsyncs after this
 * logcat line.
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
