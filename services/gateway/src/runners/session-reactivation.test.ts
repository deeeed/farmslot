import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { SlotVars } from '../core/config.js';

import type { ObservabilityReading, RunnerSessionDeliveryState } from './observability-types.js';

const commands: string[] = [];
let sessionState: ObservabilityReading<RunnerSessionDeliveryState> | null = {
  value: 'idle',
  source: 'hook',
  confidence: 'high',
  observedAt: Date.now(),
};

mock.module('../core/exec.js', {
  namedExports: {
    execArgvOnSlot: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    execFileArgv: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    execLocal: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    execOnSlot: async (_vars: SlotVars, command: string) => {
      commands.push(command);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    isLocal: () => false,
  },
});

mock.module('./observability-sentinel.js', {
  namedExports: {
    writeRunnerPromptSentinel: async () => ({ digest: 'digest-123', sentAt: Date.now() }),
  },
});

mock.module('./claude-observability.js', {
  namedExports: {
    claudeHookObservability: {
      async getActivity() {
        return null;
      },
      async getContextPct() {
        return null;
      },
      async activeTool() {
        return null;
      },
      async lastTurnCompletedAt() {
        return null;
      },
      async promptAccepted() {
        return {
          value: true,
          source: 'hook',
          confidence: 'high',
          observedAt: Date.now(),
        };
      },
      async getSessionDeliveryState() {
        return sessionState;
      },
    },
  },
});

const { deliverPromptToRetainedRunnerSession } = await import('./session-reactivation.js');

const vars = {
  slotId: 'runner-local-test-1',
  machine: 'runner-local',
  platform: 'ios',
  host: 'remote.example',
  sshUser: 'tester',
  osType: 'darwin',
  claudePath: '/usr/local/bin/claude',
  codexPath: '/usr/local/bin/codex',
  opencodePath: '/usr/local/bin/opencode',
  cursorPath: '/usr/local/bin/cursor-agent',
  grokPath: '/usr/local/bin/grok',
  dispatchCmd: '',
  recycleCmd: '',
  repo: '/tmp/repo',
  session: 'test-1',
  slotMode: 'dispatch',
  slotEnabled: true,
  sshTarget: 'tester@remote.example',
  remoteRepo: '/tmp/repo',
  projectName: 'test-project',
  resourceVars: { platform: 'ios', slot_id: 'runner-local-test-1' },
} as SlotVars;

test('retained resume delivers the prompt through runner argv without send-keys', async () => {
  commands.length = 0;
  sessionState = {
    value: 'idle',
    source: 'hook',
    confidence: 'high',
    observedAt: Date.now() - 300_000,
  };

  await deliverPromptToRetainedRunnerSession({
    vars,
    target: 'test-1:dev',
    runnerId: 'claude',
    sessionId: 'session-123',
    prompt: 'Read and execute TASK.md',
    runtimeDir: '.farmslot/runtime/test-project',
  });

  const command = commands.join('\n');
  const resumeIndex = command.indexOf('--resume');
  const sessionIndex = command.indexOf('session-123', resumeIndex);
  const promptIndex = command.indexOf('Read and execute TASK.md', sessionIndex);
  assert.ok(resumeIndex >= 0 && sessionIndex > resumeIndex && promptIndex > sessionIndex);
  assert.doesNotMatch(command, /send-keys/);
});

test('retained resume does not mutate an active session', async () => {
  commands.length = 0;
  sessionState = {
    value: 'active',
    source: 'hook',
    confidence: 'high',
    observedAt: Date.now(),
  };

  await assert.rejects(
    deliverPromptToRetainedRunnerSession({
      vars,
      target: 'test-1:dev',
      runnerId: 'claude',
      sessionId: 'session-123',
      prompt: 'Read and execute TASK.md',
    }),
    /is active; refusing to replace/,
  );
  assert.deepEqual(commands, []);
});
