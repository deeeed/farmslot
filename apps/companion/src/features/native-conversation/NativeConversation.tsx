import { Stack, useRouter } from 'expo-router';
import { Pressable, Text } from 'react-native';

import { NativeConversationScreen } from './NativeConversationScreen';
import {
  type NativeConversationParams,
  useNativeConversationController,
} from './use-native-conversation-controller';

export function NativeConversation({
  params,
  embedded = false,
}: {
  params: NativeConversationParams;
  embedded?: boolean;
}) {
  const router = useRouter();
  const screen = useNativeConversationController(params);
  return (
    <>
      {!embedded ? (
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
      ) : null}
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
