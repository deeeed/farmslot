import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import type { Run } from '@farmslot/protocol';

import { nativeStyles as styles } from '../styles/native-conversation.styles';

export function NativeWorkerLinks({ run }: { run: Run }) {
  const router = useRouter();
  return (
    <View style={styles.content}>
      <Text style={styles.heading}>Worker conversations</Text>
      {(run.agentContexts ?? []).flatMap((context) =>
        [context.nativeSession, ...(context.nativeSessionHistory ?? [])]
          .filter((binding) => !!binding)
          .map((binding) => (
            <Pressable
              accessibilityRole="button"
              key={`${context.id}:${binding.sessionId}:${binding.leaseId}`}
              testID={`companion-native-worker-${context.id}-${binding.leaseId}`}
              style={styles.button}
              onPress={() =>
                router.push({
                  pathname: '/native',
                  params: {
                    runId: run.id,
                    contextId: context.id,
                    sessionId: binding.sessionId,
                    executionNodeId: binding.executionNodeId,
                    leaseId: binding.leaseId,
                    generation: binding.generation ?? '',
                  },
                })
              }
            >
              <Text style={styles.buttonText}>
                Conversation · {context.label}
                {binding.closedAt || binding.releasedAt ? ' · History' : ''}
              </Text>
            </Pressable>
          )),
      )}
    </View>
  );
}
