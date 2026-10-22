import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import type { Run } from '@farmslot/protocol';
import {
  nativeWorkerTarget,
  nativeWorkerTargets,
  runTerminalView,
} from '@farmslot/review-dispatch';

import { nativeStyles as styles } from '../styles/native-conversation.styles';

export function NativeWorkerLinks({ run }: { run: Run }) {
  const router = useRouter();
  const targets = nativeWorkerTargets(run.agentContexts ?? []);
  if (!targets.length) return null;
  return (
    <View style={styles.content}>
      <Text style={styles.heading}>Worker conversations</Text>
      {targets.map((target) => {
        const { binding } = target;
        const context = run.agentContexts?.find((candidate) => candidate.id === target.contextId);
        const terminal = runTerminalView(run, target.contextId);
        return (
          <Pressable
            accessibilityRole="button"
            key={`${target.contextId}:${binding.sessionId}:${binding.leaseId}`}
            testID={`companion-native-worker-${target.contextId}-${binding.leaseId}`}
            style={styles.button}
            onPress={() => {
              if (
                context &&
                nativeWorkerTarget(run.agentContexts ?? [], context)?.binding === binding &&
                terminal.target
              ) {
                router.push({
                  pathname: terminal.target.slotId
                    ? '/workspace/slot/[slotId]/terminal'
                    : '/run-terminal/[runId]',
                  params: { ...terminal.target, contextId: target.contextId },
                });
                return;
              }
              router.push({
                pathname: '/native',
                params: {
                  runId: run.id,
                  contextId: target.contextId,
                  sessionId: binding.sessionId,
                  executionNodeId: binding.executionNodeId,
                  leaseId: binding.leaseId,
                  generation: binding.generation ?? '',
                },
              });
            }}
          >
            <Text style={styles.buttonText}>
              Conversation · {target.label}
              {target.readOnly ? ' · History' : ''}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
