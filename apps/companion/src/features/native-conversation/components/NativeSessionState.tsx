import { useEffect, useState } from 'react';
import { Text } from 'react-native';

import type { NativeSessionInfo } from '@farmslot/protocol';
import { type NativeWork, nativeWorkLabel } from '@farmslot/protocol/client-cache';

import { nativeStyles as styles } from '../styles/native-conversation.styles';

/**
 * The session state, or how long its turn has run and its current tool, on one line.
 * It ticks on its own, so the conversation does not re-render every second.
 */
export function NativeSessionState({
  state,
  work,
}: {
  state: NativeSessionInfo['state'];
  work?: NativeWork;
}) {
  const working = state === 'running' ? work : undefined;
  const [now, setNow] = useState(Date.now);
  const ticking = working !== undefined;
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return (
    <Text testID="companion-native-session-state" style={styles.muted} numberOfLines={1}>
      {working ? nativeWorkLabel(working, now) : state}
    </Text>
  );
}
