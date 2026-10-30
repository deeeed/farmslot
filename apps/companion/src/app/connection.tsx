import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';

import { NativeConnectionScreen } from '../features/native-connection/NativeConnectionScreen';
import { useNativeConnectionController } from '../features/native-connection/use-native-connection-controller';

/** With `payload` (a pairing QR payload, as `farmslot://pair?payload=…` sends) it asks, then pairs as if scanned. */
export default function ConnectionRoute() {
  const router = useRouter();
  const { payload } = useLocalSearchParams<{ payload?: string }>();
  const screen = useNativeConnectionController({
    pairingLink: typeof payload === 'string' && payload ? payload : undefined,
  });
  if (screen.viewModel.leaveToHome) {
    return <Redirect href={screen.viewModel.home} />;
  }
  return (
    <NativeConnectionScreen
      {...screen}
      onOpenWorkspace={() => router.replace(screen.viewModel.home)}
    />
  );
}
