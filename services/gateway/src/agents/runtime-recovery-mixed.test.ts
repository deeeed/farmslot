import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { Run } from '@farmslot/protocol';

import '../runtime/mock-pty.test-support.js';

import { makeRun } from '../run-engine/test-fixtures.js';

const reconciled: string[] = [];
mock.module('../runners/native/worker-runtime.js', {
  namedExports: {
    reconcileNativeRunAgentRuntime: async (run: Run) => {
      reconciled.push(...(run.agentContexts ?? []).filter((c) => c.nativeSession).map((c) => c.id));
    },
  },
});
const config = await import('../core/config.js');
mock.module('../core/config.js', {
  namedExports: {
    ...config,
    loadSlotVars: async () => {
      throw new Error('Native context must not be inspected as tmux');
    },
  },
});
const { reconcileRunAgentRuntime } = await import('./runtime-recovery.js');

test('gateway restart reconciles a native reviewer by its own transport and keeps the admitted attempt', async () => {
  const run: Run = {
    ...makeRun({ slotId: 'slot', status: 'reviewing' }),
    transport: 'tmux',
    agentContexts: [
      {
        id: 'review-native',
        role: 'review',
        label: 'Review',
        runId: 'run',
        slotId: 'slot',
        status: 'working',
        runner: 'codex',
        runnerSessionId: 'native-conversation',
        nativeSession: {
          sessionId: 'session',
          generation: 'generation',
          leaseId: 'lease',
          commandId: 'command',
          executionNodeId: 'local',
          ownerPrincipalId: 'owner',
        },
      },
    ],
  };
  const before = structuredClone(run);
  await reconcileRunAgentRuntime(run);
  assert.deepEqual(reconciled, ['review-native']);
  assert.deepEqual(run, before);
});
