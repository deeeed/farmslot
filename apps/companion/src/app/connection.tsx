import { Redirect, useRouter } from 'expo-router';

import { NativeConnectionScreen } from '../features/native-connection/NativeConnectionScreen';
import { useNativeConnectionController } from '../features/native-connection/use-native-connection-controller';

export default function ConnectionRoute() {
  const router = useRouter();
  const screen = useNativeConnectionController();
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
