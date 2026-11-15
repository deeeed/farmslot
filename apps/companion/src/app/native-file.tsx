import { useLocalSearchParams } from 'expo-router';

import { withViewState } from '../components/view-state';
import { NativeFileScreen } from '../features/native-files/NativeFileScreen';
import { useNativeFileController } from '../features/native-files/use-native-file-controller';
import { routeParamString } from '../features/workspace-shared/route-params';

export function NativeFileRoute() {
  const route = useLocalSearchParams();
  const screen = useNativeFileController({
    sessionId: routeParamString(route.sessionId),
    executionNodeId: routeParamString(route.executionNodeId),
    path: routeParamString(route.path),
    line: routeParamString(route.line),
    runId: routeParamString(route.runId),
    contextId: routeParamString(route.contextId),
    generation: routeParamString(route.generation),
    leaseId: routeParamString(route.leaseId),
  });
  return <NativeFileScreen {...screen} />;
}

export default withViewState(NativeFileRoute);
