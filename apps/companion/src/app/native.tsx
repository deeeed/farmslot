import { Redirect, Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Pressable, Text } from 'react-native';

import { NativeConversationScreen } from '../features/native-conversation/NativeConversationScreen';
import {
  type NativeConversationParams,
  useNativeConversationController,
} from '../features/native-conversation/use-native-conversation-controller';
import { routeParamString } from '../features/workspace-shared/route-params';
import { canOpenNativeConversation, workspaceHome } from '../lib/workspace-access';
import { useConnectionStore } from '../store/connection';

function Conversation({ params }: { params: NativeConversationParams }) {
  const router = useRouter();
  const screen = useNativeConversationController(params);
  return (
    <>
      <Stack.Screen
        options={{
          title: 'Conversation',
          headerBackTitle: params.runId ? 'Run' : 'Back',
          headerRight: () => (
            <Pressable
              testID="companion-native-connection"
              accessibilityRole="button"
              onPress={() => router.push('/connection')}
            >
              <Text style={{ color: '#fff' }}>Connection</Text>
            </Pressable>
          ),
        }}
      />
      <NativeConversationScreen
        {...screen}
        selected={!!params.sessionId}
        onSelect={(session) =>
          router.push({
            pathname: '/native',
            params: {
              sessionId: session.id,
              executionNodeId: session.executionNodeId,
              ...(params.draft ? { draft: params.draft } : {}),
            },
          })
        }
      />
    </>
  );
}
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
    <Conversation
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
