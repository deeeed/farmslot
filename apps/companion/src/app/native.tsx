import { Redirect, useLocalSearchParams } from 'expo-router';

import { NativeConversation } from '../features/native-conversation/NativeConversation';
import { type NativeConversationParams } from '../features/native-conversation/use-native-conversation-controller';
import { routeParamString } from '../features/workspace-shared/route-params';
import { canOpenNativeConversation, workspaceHome } from '../lib/workspace-access';
import { useConnectionStore } from '../store/connection';

export default function NativeConversationRoute() {
  const route = useLocalSearchParams();
  const profile = useConnectionStore((state) => state.activeProfileId);
  const access = useConnectionStore((state) => state.workspaceAccess);
  const principalId = useConnectionStore((state) => state.principalId);
  const authorityEpoch = useConnectionStore((state) => state.authorityEpoch);
  const connection = useConnectionStore((state) => state.status);
  const client = useConnectionStore((state) => state.client);
  const gatewayUrl = useConnectionStore((state) => state.gatewayUrl);
  const params: NativeConversationParams = {
    sessionId: routeParamString(route.sessionId),
    executionNodeId: routeParamString(route.executionNodeId),
    runId: routeParamString(route.runId),
    contextId: routeParamString(route.contextId),
    leaseId: routeParamString(route.leaseId),
    generation: routeParamString(route.generation),
    draft: routeParamString(route.draft),
  };
  const selectedConversation = Boolean(
    params.sessionId || params.runId || params.contextId || params.leaseId || params.generation,
  );
  if (
    !canOpenNativeConversation(
      access,
      params.runId || params.contextId || params.leaseId || params.generation,
    )
  )
    return <Redirect href={workspaceHome(access)} />;
  return (
    <NativeConversation
      key={JSON.stringify([
        profile,
        gatewayUrl,
        principalId,
        authorityEpoch,
        ...(selectedConversation ? [connection, client?.connectionGeneration] : []),
        params,
      ])}
      params={params}
    />
  );
}
