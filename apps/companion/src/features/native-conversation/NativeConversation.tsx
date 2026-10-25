import { Stack, useRouter } from 'expo-router';
import { useMemo } from 'react';
import { Pressable, Text } from 'react-native';

import { useSharedViewSelection } from '../quick-actions/QuickActionsProvider';

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
  const selected = screen.viewModel.session;
  useSharedViewSelection(
    useMemo(
      () => ({
        pathname: '/native',
        params: {
          sessionId: selected?.id,
          executionNodeId: selected?.executionNodeId,
          sessionObserved: selected ? '1' : '0',
          workerManaged: selected?.workerManaged ? '1' : '0',
        },
      }),
      [selected?.id, selected?.executionNodeId, selected?.workerManaged],
    ),
  );
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
