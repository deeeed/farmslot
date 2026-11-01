import { Stack } from 'expo-router';

import { OfflineShown } from '../../components/offline-shown';
import TerminalScreen from '../../features/terminal/SlotTerminalScreen';

export default function RunTerminalRoute() {
  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      {/* The terminal shows the connection banner, so its read-status slot need not. */}
      <OfflineShown.Provider value={true}>
        <TerminalScreen />
      </OfflineShown.Provider>
    </>
  );
}
