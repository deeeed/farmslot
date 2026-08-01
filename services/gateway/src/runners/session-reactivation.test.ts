import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { SlotVars } from '../core/config.js';

import type { ObservabilityReading, RunnerSessionDeliveryState } from './observability-types.js';

const commands: string[] = [];
let paneCount = 1;
let sessionPathExists = true;
let promptAccepted = true;
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
      if (command.includes('list-panes')) {
        const panes = Array.from({ length: paneCount }, (_, index) => `%${index + 1}`).join('\n');
        return { exitCode: 0, stdout: panes ? `${panes}\n` : '', stderr: '' };
      }
      if (command.startsWith('test -e ')) {
        return {
          exitCode: sessionPathExists ? 0 : 1,
          stdout: '',
          stderr: '',
        };
      }
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
          value: promptAccepted,
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
  paneCount = 1;
  sessionPathExists = true;
  promptAccepted = true;
  sessionState = {
    value: 'idle',
    source: 'hook',
    confidence: 'high',
    observedAt: Date.now() - 300_000,
  };

  const result = await deliverPromptToRetainedRunnerSession({
    vars,
    target: 'test-1:dev',
    runnerId: 'claude',
    sessionId: 'session-123',
    sessionPath: '/sessions/session-123.jsonl',
    prompt: 'Read and execute TASK.md',
    runtimeDir: '.farmslot/runtime/test-project',
  });
  assert.deepEqual(result, { delivered: true });

  const command = commands.join('\n');
  const resumeIndex = command.indexOf('--resume');
  const sessionIndex = command.indexOf('session-123', resumeIndex);
  const promptIndex = command.indexOf('Read and execute TASK.md', sessionIndex);
  assert.ok(resumeIndex >= 0 && sessionIndex > resumeIndex && promptIndex > sessionIndex);
  assert.doesNotMatch(command, /send-keys/);
});

test('retained resume does not mutate an active session', async () => {
  commands.length = 0;
  paneCount = 1;
  sessionPathExists = true;
  sessionState = {
    value: 'active',
    source: 'hook',
    confidence: 'high',
    observedAt: Date.now(),
  };

  const result = await deliverPromptToRetainedRunnerSession({
    vars,
    target: 'test-1:dev',
    runnerId: 'claude',
    sessionId: 'session-123',
    sessionPath: '/sessions/session-123.jsonl',
    prompt: 'Read and execute TASK.md',
  });
  assert.equal(result.delivered, false);
  if (!result.delivered) {
    assert.equal(result.disposition, 'hold');
    assert.match(result.reason, /is active; refusing to replace/);
  }
  assert.equal(
    commands.some((command) => command.includes('respawn-window')),
    false,
  );
});

test('retained resume falls back cold only after idle proof when the session file is gone', async () => {
  commands.length = 0;
  paneCount = 1;
  sessionPathExists = false;
  sessionState = {
    value: 'idle',
    source: 'hook',
    confidence: 'high',
    observedAt: Date.now() - 300_000,
  };

  const result = await deliverPromptToRetainedRunnerSession({
    vars,
    target: 'test-1:dev',
    runnerId: 'claude',
    sessionId: 'session-123',
    sessionPath: '/sessions/missing.jsonl',
    prompt: 'Read and execute TASK.md',
  });
  assert.deepEqual(result, {
    delivered: false,
    disposition: 'fresh-dispatch',
    reason: 'Retained claude session path is unavailable: /sessions/missing.jsonl',
  });
  assert.equal(
    commands.some((command) => command.includes('respawn-window')),
    false,
  );
});

test('retained resume holds when exact session state is unavailable', async () => {
  commands.length = 0;
  paneCount = 1;
  sessionPathExists = true;
  sessionState = null;

  const result = await deliverPromptToRetainedRunnerSession({
    vars,
    target: 'test-1:dev',
    runnerId: 'claude',
    sessionId: 'session-123',
    sessionPath: '/sessions/session-123.jsonl',
    prompt: 'Read and execute TASK.md',
  });
  assert.equal(result.delivered, false);
  if (!result.delivered) assert.equal(result.disposition, 'hold');
  assert.equal(
    commands.some((command) => command.includes('respawn-window')),
    false,
  );
});

test('retained resume holds before inspection when the persisted session id is missing', async () => {
  commands.length = 0;

  const result = await deliverPromptToRetainedRunnerSession({
    vars,
    target: 'test-1:dev',
    runnerId: 'claude',
    sessionPath: '/sessions/session-123.jsonl',
    prompt: 'Read and execute TASK.md',
  });

  assert.deepEqual(result, {
    delivered: false,
    disposition: 'hold',
    reason: "Runner 'claude' requires a persisted session id for retained handoff",
  });
  assert.deepEqual(commands, []);
});

test('retained resume holds before session proof when the persisted session path is missing', async () => {
  commands.length = 0;

  const result = await deliverPromptToRetainedRunnerSession({
    vars,
    target: 'test-1:dev',
    runnerId: 'claude',
    sessionId: 'session-123',
    prompt: 'Read and execute TASK.md',
  });

  assert.deepEqual(result, {
    delivered: false,
    disposition: 'hold',
    reason: 'Retained claude session session-123 has no resumable session path',
  });
  assert.equal(
    commands.some((command) => command.includes('respawn-window')),
    false,
  );
});

test('retained resume refuses window-wide replacement when the target has multiple panes', async () => {
  commands.length = 0;
  paneCount = 2;
  sessionState = {
    value: 'idle',
    source: 'hook',
    confidence: 'high',
    observedAt: Date.now(),
  };

  const result = await deliverPromptToRetainedRunnerSession({
    vars,
    target: 'test-1:dev',
    runnerId: 'claude',
    sessionId: 'session-123',
    sessionPath: '/sessions/session-123.jsonl',
    prompt: 'Read and execute TASK.md',
  });

  assert.equal(result.delivered, false);
  if (!result.delivered) {
    assert.equal(result.disposition, 'hold');
    assert.match(result.reason, /has 2 panes/);
  }
  assert.equal(
    commands.some((command) => command.includes('respawn-window')),
    false,
  );
});
