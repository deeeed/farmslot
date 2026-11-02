import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentContext, WorkerSignalProbeResult } from '@farmslot/protocol';

import '../runtime/mock-pty.test-support.js';

import type {
  ObservabilityReading,
  RunnerSessionDeliveryState,
} from '../runners/observability-types.js';
import { RunnerExecutionError } from '../runners/runner-execution-error.js';
import { makeVars } from '../runners/test-fixtures.js';

import { checkAgentLive } from './run-monitor.js';
import { makeRun } from './test-fixtures.js';
import { agentsWithoutExitEvidence, type WorkerExitReaders } from './worker-exit-evidence.js';

const running: WorkerSignalProbeResult = {
  ok: false,
  code: 'non_terminal',
  message: 'SIGNAL.json exists but status is "running".',
  signalFile: 'SIGNAL.json',
};

function agent(status: AgentContext['status']): AgentContext {
  return {
    id: 'fix-bug',
    role: 'fix-bug',
    label: 'Fix bug',
    runner: 'pi',
    status,
    slotId: null,
    runId: 'ce1c5583',
  };
}

function evidence(contexts: AgentContext[], readers: Partial<WorkerExitReaders>) {
  return agentsWithoutExitEvidence(
    { ...makeRun({ slotId: 'macpro-mm-5' }), agentContexts: contexts },
    readers,
  );
}

test('a live agent without a signal or an exit has no exit evidence', async () => {
  for (const status of ['working', 'unknown'] as const) {
    assert.deepEqual(
      await evidence([agent('working')], {
        signal: async () => running,
        liveness: async () => status,
      }),
      ['fix-bug'],
    );
  }
});

test('a terminal signal, a gone process or pane, or a runner-reported failure is exit evidence', async () => {
  const cases: Array<Partial<WorkerExitReaders>> = [
    {
      signal: async () => ({ ...running, ok: true, code: 'ready' }),
      liveness: async () => 'working',
    },
    { signal: async () => running, liveness: async () => 'no-tmux' },
    { signal: async () => running, liveness: async () => 'idle' },
    {
      signal: async () => running,
      liveness: async () => {
        throw new RunnerExecutionError('OAuth refresh failed for anthropic: invalid_grant');
      },
    },
  ];
  for (const readers of cases) assert.deepEqual(await evidence([agent('working')], readers), []);
});

test('a turn ended on a dropped model connection is no exit evidence', async () => {
  const pane = {
    slot: async () => makeVars(),
    target: async () => ({ target: 'fixture:dev', session: 'fixture' }),
    exec: async () => ({ exitCode: 0, stdout: '42\n', stderr: '' }),
    process: async () => ({ state: 'present' as const, pid: '99' }),
    turn: async (): Promise<ObservabilityReading<RunnerSessionDeliveryState>> => ({
      value: 'idle',
      source: 'hook',
      confidence: 'high',
      observedAt: Date.now(),
      failure: 'terminated',
    }),
  };
  assert.deepEqual(
    await evidence([agent('working')], {
      signal: async () => running,
      liveness: (slotId, runner, runId, role, contextId) =>
        checkAgentLive(slotId, runner, runId, role, contextId, pane),
    }),
    ['fix-bug'],
  );
});

test('agents recorded as finished need no evidence', async () => {
  assert.deepEqual(
    await evidence([agent('complete'), agent('failed'), agent('idle')], {
      signal: async () => assert.fail('finished agents are not probed'),
      liveness: async () => assert.fail('finished agents are not probed'),
    }),
    [],
  );
});
