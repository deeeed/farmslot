import { Stack } from 'expo-router';

import TerminalScreen from '../../features/terminal/SlotTerminalScreen';

export default function RunTerminalRoute() {
  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <TerminalScreen />
    </>
  );
}
