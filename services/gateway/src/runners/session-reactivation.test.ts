import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { SlotVars } from '../core/config.js';

import type { ObservabilityReading, RunnerSessionDeliveryState } from './observability-types.js';

const commands: string[] = [];
let paneCount = 1;
let sessionPathExists = true;
let promptAccepted = true;
let promptAcceptedSequence: boolean[] | null = null;
let promptAcceptedAt: number | null = null;
let promptAcceptanceBaselineMs: number | null = 1_000;
let capturedPane = '';
let trustSendCount = 0;
let advanceTaskSignalOnRespawn = false;
let runnerAlive = true;
let runnerDiesOnRespawn = false;
let runnerRevivesAfterProbes = 0;
let runnerLivenessProbes = 0;
let runnerProbeFails = false;
let respawnFails = false;
let namedWindowCount = 1;
let replacementSignalOutput =
  '1000000000\n{"status":"complete","timestamp":"2026-08-01T00:00:00.000Z"}\n';
let taskSignalOutput = '2000000000\n{"status":"running","timestamp":"2026-08-02T00:00:00.000Z"}\n';
let sessionState: ObservabilityReading<RunnerSessionDeliveryState> | null = {
  value: 'idle',
  source: 'hook',
  confidence: 'high',
  observedAt: Date.now(),
};

mock.module('../core/exec.js', {
  namedExports: {
    // Mirrors the real module: callers classify a probe timeout by this exit
    // status, so the mocked module has to export it too.
    EXEC_TIMEOUT_EXIT_CODE: 124,
    execArgvOnSlot: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    execFileArgv: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    execLocal: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    execOnSlot: async (_vars: SlotVars, command: string) => {
      commands.push(command);
      if (command.includes('respawn-window') && respawnFails) {
        throw new Error('transport lost after respawn');
      }
      if (command.includes('respawn-window') && advanceTaskSignalOnRespawn) {
        taskSignalOutput =
          '3000000000\n{"status":"running","timestamp":"2026-08-02T00:00:01.000Z"}\n';
      }
      if (command.includes('respawn-window') && runnerDiesOnRespawn) runnerAlive = false;
      if (command.includes('respawn-window') && runnerRevivesAfterProbes > 0) {
        runnerAlive = false;
        runnerLivenessProbes = 0;
      }
      if (command.includes("'#{window_id}'")) {
        return { exitCode: 0, stdout: '@1\n', stderr: '' };
      }
      if (command.includes('display-message -p -t')) {
        return { exitCode: 0, stdout: '%1\t123\n', stderr: '' };
      }
      if (command.includes("list-panes -a -F '#{session_name}")) {
        const rows = Array.from(
          { length: namedWindowCount },
          (_, index) => `test-1\tdev\t@${index + 1}\t${index + 1}\t100\t%${index + 1}\t123`,
        );
        return { exitCode: 0, stdout: rows.join('\n'), stderr: '' };
      }
      if (command.includes('#{pane_pid}')) {
        return { exitCode: 0, stdout: '%1\t123\n', stderr: '' };
      }
      if (command.includes('list-panes')) {
        const panes = Array.from({ length: paneCount }, (_, index) => `%${index + 1}`).join('\n');
        return { exitCode: 0, stdout: panes ? `${panes}\n` : '', stderr: '' };
      }
      if (command.includes('capture-pane')) {
        return { exitCode: 0, stdout: capturedPane, stderr: '' };
      }
      if (command.includes('send-keys')) {
        trustSendCount += 1;
        promptAccepted = true;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (command.includes('PRIOR-TASK-SIGNAL.json')) {
        return { exitCode: 0, stdout: replacementSignalOutput, stderr: '' };
      }
      if (command.includes('SELF-REVIEW-FIX-SIGNAL.json')) {
        return {
          exitCode: 0,
          stdout: taskSignalOutput,
          stderr: '',
        };
      }
      // The pane-tree liveness probe, matched on the env var the walk exports
      // rather than on the shape of the `ps` invocation it happens to use.
      if (command.includes('FARMSLOT_RUNNER_PATTERN=')) {
        if (runnerProbeFails) {
          return { exitCode: 124, stdout: '', stderr: 'command timed out after 10000ms' };
        }
        runnerLivenessProbes += 1;
        if (runnerRevivesAfterProbes > 0 && runnerLivenessProbes > runnerRevivesAfterProbes) {
          runnerAlive = true;
        }
        return { exitCode: runnerAlive ? 0 : 1, stdout: runnerAlive ? '456\n' : '', stderr: '' };
      }
      if (command.includes('expected_prompt =') && command.includes('session_path = Path(')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify(
            promptAccepted
              ? {
                  status: 'matched',
                  observedAt: promptAcceptedAt ?? Date.now(),
                  turnId: 'test-turn',
                }
              : { status: 'not-found' },
          ),
          stderr: '',
        };
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
    writeRunnerPromptSentinel: async () => ({ digest: 'digest-123', sentAt: 1_000 }),
  },
});

mock.module('./claude-observability.js', {
  namedExports: {
    claudeHookObservability: {
      promptAcceptanceMode: 'hook-digest',
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
      async capturePromptAcceptanceBaseline() {
        return promptAcceptanceBaselineMs;
      },
      async promptAccepted(_vars: SlotVars, _target: string, _digest: string, sinceMs: number) {
        const accepted = promptAcceptedSequence?.shift() ?? promptAccepted;
        return {
          // Simulate acceptance emitted while respawn-window is still returning.
          value: accepted && (promptAcceptedAt === null || sinceMs <= promptAcceptedAt),
          source: 'hook',
          confidence: 'high',
          observedAt: Date.now(),
          exactPromptMatch: true,
          ...(accepted ? { sessionId: 'session-123', turnToken: 'session-123:test-turn' } : {}),
        };
      },
      async getTurnState() {
        return sessionState
          ? {
              ...sessionState,
              sessionId: 'session-123',
              turnToken: 'session-123:test-turn',
            }
          : null;
      },
      async getSessionDeliveryState() {
        return sessionState;
      },
    },
  },
});

const {
  deliverPromptToLiveRunner,
  deliverPromptToRetainedRunnerSession,
  deliverPromptWithRetainedFallback,
} = await import('./session-reactivation.js');

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

test('Cursor retained handoff relaunches with argv and waits for the scoped task signal', async (t) => {
  commands.length = 0;
  paneCount = 1;
  advanceTaskSignalOnRespawn = true;
  taskSignalOutput = '2000000000\n{"status":"complete","timestamp":"2026-08-02T00:00:00.000Z"}\n';
  t.after(() => {
    advanceTaskSignalOnRespawn = false;
    taskSignalOutput = '2000000000\n{"status":"running","timestamp":"2026-08-02T00:00:00.000Z"}\n';
  });

  const result = await deliverPromptToLiveRunner({
    vars,
    target: '%1',
    runnerId: 'cursor',
    model: 'cursor-grok-4.6-high-fast',
    prompt: 'Read and execute SELF-REVIEW-FIX.md',
    promptMarker: 'SELF-REVIEW-FIX.md',
    replacementReadySignalPath: '/tmp/PRIOR-TASK-SIGNAL.json',
    launchAckSignalPath: '/tmp/SELF-REVIEW-FIX-SIGNAL.json',
    timeoutMs: 1_000,
  });

  assert.deepEqual(result, { delivered: true, acknowledgement: 'structured' });
  const command = commands.find((candidate) => candidate.includes('respawn-window')) ?? '';
  assert.match(command, /cursor-agent/);
  assert.match(command, /Read and execute SELF-REVIEW-FIX[.]md/);
  assert.equal(
    commands.some((candidate) => candidate.includes('send-keys')),
    false,
  );
});

test('Cursor argv relaunch preserves dispatch templates that require task_file', async (t) => {
  commands.length = 0;
  advanceTaskSignalOnRespawn = true;
  taskSignalOutput = '2000000000\n{"status":"complete","timestamp":"2026-08-02T00:00:00.000Z"}\n';
  t.after(() => {
    advanceTaskSignalOnRespawn = false;
    taskSignalOutput = '2000000000\n{"status":"running","timestamp":"2026-08-02T00:00:00.000Z"}\n';
  });

  const result = await deliverPromptToLiveRunner({
    vars: {
      ...vars,
      dispatchCmd:
        'cd {repo} && {cursor_path} {safety_flags} --model {model} {task_file} {task_prompt}',
    },
    target: '%1',
    runnerId: 'cursor',
    prompt: 'Read and execute SELF-REVIEW-FIX.md',
    promptMarker: 'SELF-REVIEW-FIX.md',
    taskFile: 'tasks/run-1/SELF-REVIEW-FIX.md',
    replacementReadySignalPath: '/tmp/PRIOR-TASK-SIGNAL.json',
    launchAckSignalPath: '/tmp/SELF-REVIEW-FIX-SIGNAL.json',
  });

  assert.deepEqual(result, { delivered: true, acknowledgement: 'structured' });
  const command = commands.find((candidate) => candidate.includes('respawn-window')) ?? '';
  assert.match(command, /tasks\/run-1\/SELF-REVIEW-FIX[.]md/);
});

test('Cursor recovery accepts only prior structured evidence and never relaunches', async (t) => {
  commands.length = 0;
  paneCount = 1;
  advanceTaskSignalOnRespawn = false;
  const existingSignal = {
    raw: '{"status":"running","timestamp":"2026-08-02T00:00:00.000Z"}',
    status: 'running' as const,
    mtimeNs: '2000000000',
  };
  taskSignalOutput = `${existingSignal.mtimeNs}\n${existingSignal.raw}\n`;
  t.after(() => {
    taskSignalOutput = '2000000000\n{"status":"running","timestamp":"2026-08-02T00:00:00.000Z"}\n';
  });

  const result = await deliverPromptToLiveRunner({
    vars,
    target: '%1',
    runnerId: 'cursor',
    prompt: 'Read and execute SELF-REVIEW-FIX.md',
    promptMarker: 'SELF-REVIEW-FIX.md',
    launchAckSignalPath: '/tmp/SELF-REVIEW-FIX-SIGNAL.json',
    launchAckBaseline: existingSignal,
    priorPromptSendAttempted: true,
  });

  assert.equal(result.delivered, false);
  if (!result.delivered) {
    assert.equal(result.disposition, 'hold');
    assert.equal(result.retryable, false);
    assert.match(result.reason, /refusing duplicate delivery/);
  }
  assert.equal(
    commands.some((candidate) => candidate.includes('respawn-window')),
    false,
  );
});

test('Cursor argv handoff refuses delivery without a task signal contract', async () => {
  commands.length = 0;
  paneCount = 1;
  advanceTaskSignalOnRespawn = false;

  const result = await deliverPromptToLiveRunner({
    vars,
    target: '%1',
    runnerId: 'cursor',
    model: 'cursor-grok-4.6-high-fast',
    prompt: 'Read and execute CI-FIX.md',
    promptMarker: 'CI-FIX.md',
  });

  assert.equal(result.delivered, false);
  if (!result.delivered) assert.match(result.reason, /task-scoped acknowledgement signal/);
  assert.equal(
    commands.some((candidate) => candidate.includes('respawn-window')),
    false,
  );
});

test('Cursor argv handoff waits for a terminal prior task before replacement', async (t) => {
  commands.length = 0;
  paneCount = 1;
  replacementSignalOutput =
    '1000000000\n{"status":"running","timestamp":"2026-08-01T00:00:00.000Z"}\n';
  t.after(() => {
    replacementSignalOutput =
      '1000000000\n{"status":"complete","timestamp":"2026-08-01T00:00:00.000Z"}\n';
  });

  const result = await deliverPromptToLiveRunner({
    vars,
    target: '%1',
    runnerId: 'cursor',
    prompt: 'Read and execute SELF-REVIEW-FIX.md',
    promptMarker: 'SELF-REVIEW-FIX.md',
    replacementReadySignalPath: '/tmp/PRIOR-TASK-SIGNAL.json',
    launchAckSignalPath: '/tmp/SELF-REVIEW-FIX-SIGNAL.json',
    timeoutMs: 1_000,
  });

  assert.equal(result.delivered, false);
  if (!result.delivered) {
    assert.equal(result.retryable, true);
    assert.equal(result.sendAttempted, false);
    assert.match(result.reason, /prior task is not terminal/);
  }
  assert.equal(
    commands.some((candidate) => candidate.includes('respawn-window')),
    false,
  );
});

test('Cursor argv handoff holds before mutation when process liveness is unknown', async (t) => {
  commands.length = 0;
  runnerProbeFails = true;
  t.after(() => {
    runnerProbeFails = false;
  });

  const result = await deliverPromptToLiveRunner({
    vars,
    target: '%1',
    runnerId: 'cursor',
    prompt: 'Read and execute SELF-REVIEW-FIX.md',
    promptMarker: 'SELF-REVIEW-FIX.md',
    replacementReadySignalPath: '/tmp/PRIOR-TASK-SIGNAL.json',
    launchAckSignalPath: '/tmp/SELF-REVIEW-FIX-SIGNAL.json',
  });

  assert.equal(result.delivered, false);
  if (!result.delivered) {
    assert.equal(result.retryable, true);
    assert.equal(result.sendAttempted, false);
    assert.match(result.reason, /Cannot establish whether cursor still owns/);
  }
  assert.equal(
    commands.some((candidate) => candidate.includes('respawn-window')),
    false,
  );
});

test('Cursor argv handoff records a possible send when respawn confirmation fails', async (t) => {
  commands.length = 0;
  respawnFails = true;
  t.after(() => {
    respawnFails = false;
  });

  const result = await deliverPromptToLiveRunner({
    vars,
    target: '%1',
    runnerId: 'cursor',
    prompt: 'Read and execute SELF-REVIEW-FIX.md',
    promptMarker: 'SELF-REVIEW-FIX.md',
    replacementReadySignalPath: '/tmp/PRIOR-TASK-SIGNAL.json',
    launchAckSignalPath: '/tmp/SELF-REVIEW-FIX-SIGNAL.json',
  });

  assert.equal(result.delivered, false);
  if (!result.delivered) {
    assert.equal(result.retryable, false);
    assert.equal(result.sendAttempted, true);
  }
});

test('Cursor argv handoff refreshes a nonterminal prior-task snapshot on retry', async (t) => {
  commands.length = 0;
  advanceTaskSignalOnRespawn = true;
  replacementSignalOutput =
    '2000000000\n{"status":"complete","timestamp":"2026-08-01T00:00:01.000Z"}\n';
  const staleSnapshot = {
    raw: '{"status":"running","timestamp":"2026-08-01T00:00:00.000Z"}',
    status: 'running' as const,
    mtimeNs: '1000000000',
  };
  t.after(() => {
    advanceTaskSignalOnRespawn = false;
    replacementSignalOutput =
      '1000000000\n{"status":"complete","timestamp":"2026-08-01T00:00:00.000Z"}\n';
    taskSignalOutput = '2000000000\n{"status":"running","timestamp":"2026-08-02T00:00:00.000Z"}\n';
  });

  const result = await deliverPromptToLiveRunner({
    vars,
    target: '%1',
    runnerId: 'cursor',
    prompt: 'Read and execute SELF-REVIEW-FIX.md',
    promptMarker: 'SELF-REVIEW-FIX.md',
    replacementReadySignalPath: '/tmp/PRIOR-TASK-SIGNAL.json',
    replacementReadySignal: staleSnapshot,
    launchAckSignalPath: '/tmp/SELF-REVIEW-FIX-SIGNAL.json',
    timeoutMs: 2_000,
  });

  assert.deepEqual(result, { delivered: true, acknowledgement: 'structured' });
  assert.equal(
    commands.some((candidate) => candidate.includes('PRIOR-TASK-SIGNAL.json')),
    true,
  );
  assert.equal(
    commands.some((candidate) => candidate.includes('respawn-window')),
    true,
  );
});

test('Cursor argv handoff rejects a terminal signal from another attempt', async () => {
  commands.length = 0;

  const result = await deliverPromptToLiveRunner({
    vars,
    target: '%1',
    runnerId: 'cursor',
    prompt: 'Read and execute SELF-REVIEW-FIX.md',
    promptMarker: 'SELF-REVIEW-FIX.md',
    replacementReadySignalPath: '/tmp/PRIOR-TASK-SIGNAL.json',
    replacementReadySignalAttemptId: 'expected-attempt',
    launchAckSignalPath: '/tmp/SELF-REVIEW-FIX-SIGNAL.json',
  });

  assert.equal(result.delivered, false);
  if (!result.delivered) assert.equal(result.sendAttempted, false);
  assert.equal(
    commands.some((candidate) => candidate.includes('respawn-window')),
    false,
  );
});

test('Cursor argv handoff retries a transient baseline read before mutation', async (t) => {
  commands.length = 0;
  taskSignalOutput = '__FARMSLOT_SIGNAL_UNREADABLE__\n';
  t.after(() => {
    taskSignalOutput = '2000000000\n{"status":"running","timestamp":"2026-08-02T00:00:00.000Z"}\n';
  });

  const result = await deliverPromptToLiveRunner({
    vars,
    target: '%1',
    runnerId: 'cursor',
    prompt: 'Read and execute SELF-REVIEW-FIX.md',
    promptMarker: 'SELF-REVIEW-FIX.md',
    replacementReadySignalPath: '/tmp/PRIOR-TASK-SIGNAL.json',
    launchAckSignalPath: '/tmp/SELF-REVIEW-FIX-SIGNAL.json',
  });

  assert.equal(result.delivered, false);
  if (!result.delivered) {
    assert.equal(result.retryable, true);
    assert.equal(result.sendAttempted, false);
  }
  assert.equal(
    commands.some((candidate) => candidate.includes('respawn-window')),
    false,
  );
});

test('Cursor argv handoff permits a delayed acknowledgement after liveness races', async (t) => {
  commands.length = 0;
  runnerAlive = true;
  runnerDiesOnRespawn = true;
  t.after(() => {
    runnerAlive = true;
    runnerDiesOnRespawn = false;
  });

  const result = await deliverPromptToLiveRunner({
    vars,
    target: '%1',
    runnerId: 'cursor',
    prompt: 'Read and execute SELF-REVIEW-FIX.md',
    promptMarker: 'SELF-REVIEW-FIX.md',
    replacementReadySignalPath: '/tmp/PRIOR-TASK-SIGNAL.json',
    launchAckSignalPath: '/tmp/SELF-REVIEW-FIX-SIGNAL.json',
    timeoutMs: 1_000,
  });

  assert.equal(result.delivered, false);
  if (!result.delivered) {
    assert.equal(result.retryable, true);
    assert.equal(result.sendAttempted, true);
  }
  assert.equal(
    commands.some((candidate) => candidate.includes('respawn-window')),
    true,
  );
});

test('Cursor argv handoff waits for a delayed replacement process', async (t) => {
  commands.length = 0;
  advanceTaskSignalOnRespawn = true;
  runnerAlive = true;
  runnerRevivesAfterProbes = 2;
  t.after(() => {
    advanceTaskSignalOnRespawn = false;
    runnerAlive = true;
    runnerRevivesAfterProbes = 0;
    runnerLivenessProbes = 0;
    taskSignalOutput = '2000000000\n{"status":"running","timestamp":"2026-08-02T00:00:00.000Z"}\n';
  });

  const result = await deliverPromptToLiveRunner({
    vars,
    target: '%1',
    runnerId: 'cursor',
    prompt: 'Read and execute SELF-REVIEW-FIX.md',
    promptMarker: 'SELF-REVIEW-FIX.md',
    replacementReadySignalPath: '/tmp/PRIOR-TASK-SIGNAL.json',
    launchAckSignalPath: '/tmp/SELF-REVIEW-FIX-SIGNAL.json',
    timeoutMs: 3_000,
  });

  assert.deepEqual(result, { delivered: true, acknowledgement: 'structured' });
  assert.ok(runnerLivenessProbes >= 3);
});

test('Cursor argv handoff refuses a bare session before replacing any window', async () => {
  commands.length = 0;

  const result = await deliverPromptToLiveRunner({
    vars,
    target: 'test-1',
    runnerId: 'cursor',
    prompt: 'Read and execute SELF-REVIEW-FIX.md',
    promptMarker: 'SELF-REVIEW-FIX.md',
  });

  assert.equal(result.delivered, false);
  if (!result.delivered) {
    assert.equal(result.disposition, 'hold');
    assert.match(result.reason, /exact pane or named role window/);
  }
  assert.equal(
    commands.some((candidate) => candidate.includes('respawn-window')),
    false,
  );
});

test('Cursor argv handoff refuses an ambiguous named window', async (t) => {
  commands.length = 0;
  namedWindowCount = 2;
  t.after(() => {
    namedWindowCount = 1;
  });

  const result = await deliverPromptToLiveRunner({
    vars,
    target: 'test-1:dev',
    runnerId: 'cursor',
    prompt: 'Read and execute SELF-REVIEW-FIX.md',
    promptMarker: 'SELF-REVIEW-FIX.md',
    replacementReadySignalPath: '/tmp/PRIOR-TASK-SIGNAL.json',
    launchAckSignalPath: '/tmp/SELF-REVIEW-FIX-SIGNAL.json',
  });

  assert.equal(result.delivered, false);
  if (!result.delivered) assert.match(result.reason, /2 exact named windows/);
  assert.equal(
    commands.some((candidate) => candidate.includes('respawn-window')),
    false,
  );
});

test('Cursor argv handoff refuses a split window before replacing any pane', async (t) => {
  commands.length = 0;
  paneCount = 2;
  t.after(() => {
    paneCount = 1;
  });

  const result = await deliverPromptToLiveRunner({
    vars,
    target: '%1',
    runnerId: 'cursor',
    prompt: 'Read and execute SELF-REVIEW-FIX.md',
    promptMarker: 'SELF-REVIEW-FIX.md',
  });

  assert.equal(result.delivered, false);
  if (!result.delivered) {
    assert.equal(result.disposition, 'hold');
    assert.match(result.reason, /has 2 panes/);
  }
  assert.equal(
    commands.some((candidate) => candidate.includes('respawn-window')),
    false,
  );
});

test('retained resume accepts a slot-clock prompt hook emitted before respawn-window returns', async (t) => {
  commands.length = 0;
  paneCount = 1;
  sessionPathExists = true;
  promptAccepted = true;
  // The slot clock lags the gateway sentinel clock (1_000). Acceptance must be
  // compared with the provider's slot-clock baseline, not the gateway clock.
  promptAcceptanceBaselineMs = 400;
  promptAcceptedAt = 500;
  capturedPane = '';
  trustSendCount = 0;
  sessionState = {
    value: 'idle',
    source: 'hook',
    confidence: 'high',
    observedAt: Date.now() - 300_000,
  };
  t.after(() => {
    promptAcceptanceBaselineMs = 1_000;
    promptAcceptedAt = null;
  });

  const result = await deliverPromptToRetainedRunnerSession({
    vars,
    target: 'test-1:dev',
    runnerId: 'claude',
    sessionId: 'session-123',
    sessionPath: '/sessions/session-123.jsonl',
    prompt: 'Read and execute TASK.md',
    runtimeDir: '.farmslot/runtime/test-project',
  });
  assert.deepEqual(result, {
    delivered: true,
    acknowledgement: 'structured',
    turnToken: 'session-123:test-turn',
  });

  const command = commands.join('\n');
  const resumeIndex = command.indexOf('--resume');
  const sessionIndex = command.indexOf('session-123', resumeIndex);
  const promptIndex = command.indexOf('Read and execute TASK.md', sessionIndex);
  assert.ok(resumeIndex >= 0 && sessionIndex > resumeIndex && promptIndex > sessionIndex);
  assert.doesNotMatch(command, /send-keys/);
});

test('retained resume confirms a Codex hooks-review prompt only once', async (t) => {
  commands.length = 0;
  paneCount = 1;
  sessionPathExists = true;
  promptAccepted = false;
  capturedPane = `
Hooks need review
1. Review hooks
2. Trust all and continue
3. Continue without trusting (hooks won't run)
Press enter to confirm or esc to go back
`;
  trustSendCount = 0;
  sessionState = {
    value: 'idle',
    source: 'hook',
    confidence: 'high',
    observedAt: Date.now() - 300_000,
  };
  t.after(() => {
    promptAccepted = true;
    capturedPane = '';
    trustSendCount = 0;
  });

  const result = await deliverPromptToRetainedRunnerSession({
    vars,
    target: 'test-1:dev',
    runnerId: 'codex',
    sessionId: 'session-123',
    sessionPath: '/sessions/session-123.jsonl',
    prompt: 'Read and execute TASK.md',
    runtimeDir: '.farmslot/runtime/test-project',
  });

  assert.deepEqual(result, {
    delivered: true,
    acknowledgement: 'structured',
    turnToken: 'session-123:test-turn',
  });
  assert.equal(trustSendCount, 1);
});

test('retained resume does not consult a generic task signal for exact prompt acknowledgement', async () => {
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
    prompt: 'Read and execute SELF-REVIEW-FIX.md',
    launchAckSignalPath: '/tmp/SELF-REVIEW-FIX-SIGNAL.json',
  });

  assert.deepEqual(result, {
    delivered: true,
    acknowledgement: 'structured',
    turnToken: 'session-123:test-turn',
  });
  assert.equal(
    commands.some((command) => command.includes('SELF-REVIEW-FIX-SIGNAL.json')),
    false,
  );
});

test('retained resume defers an active session to the safe in-place delivery contract', async () => {
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
    assert.equal(result.disposition, 'safe-send');
    assert.match(result.reason, /is active; refusing to replace/);
  }
  assert.equal(
    commands.some((command) => command.includes('respawn-window')),
    false,
  );
});

test('retained fallback delivers in place when a live session cannot be respawned', async () => {
  commands.length = 0;
  paneCount = 1;
  sessionPathExists = true;
  promptAccepted = true;
  sessionState = {
    value: 'active',
    source: 'hook',
    confidence: 'high',
    observedAt: Date.now(),
  };

  const result = await deliverPromptWithRetainedFallback({
    vars,
    target: 'test-1:dev',
    runnerId: 'claude',
    sessionId: 'session-123',
    sessionPath: '/sessions/session-123.jsonl',
    prompt: 'Read and execute TASK.md',
  });

  assert.deepEqual(result, { delivered: true, acknowledgement: 'safe-send' });
  assert.equal(
    commands.some((command) => command.includes('respawn-window')),
    false,
  );
});

test('retained fallback accepts a fresh task signal after the original send verifier misses', async () => {
  commands.length = 0;
  paneCount = 1;
  sessionPathExists = true;
  promptAccepted = false;
  sessionState = {
    value: 'active',
    source: 'hook',
    confidence: 'high',
    observedAt: Date.now(),
  };

  const result = await deliverPromptWithRetainedFallback({
    vars,
    target: 'test-1:dev',
    runnerId: 'grok',
    prompt: 'Read and execute SELF-REVIEW-FIX.md',
    launchAckSignalPath: '/tmp/SELF-REVIEW-FIX-SIGNAL.json',
    launchAckBaseline: { raw: null, status: null, mtimeNs: '0' },
    priorPromptSendAttempted: true,
  });

  assert.deepEqual(result, {
    delivered: true,
    acknowledgement: 'structured',
  });
  assert.equal(
    commands.some((command) => command.includes('capture-pane')),
    false,
  );
});

test('retained fallback accepts delayed acknowledgement before replacing an idle session', async (t) => {
  commands.length = 0;
  paneCount = 1;
  sessionPathExists = true;
  promptAccepted = false;
  sessionState = {
    value: 'idle',
    source: 'hook',
    confidence: 'high',
    observedAt: Date.now(),
  };
  t.after(() => {
    promptAccepted = true;
  });

  const result = await deliverPromptWithRetainedFallback({
    vars,
    target: 'test-1:dev',
    runnerId: 'claude',
    sessionId: 'session-123',
    sessionPath: '/sessions/session-123.jsonl',
    prompt: 'Read and execute SELF-REVIEW-FIX.md',
    launchAckSignalPath: '/tmp/SELF-REVIEW-FIX-SIGNAL.json',
    launchAckBaseline: { raw: null, status: null, mtimeNs: '0' },
    priorPromptSendAttempted: true,
  });

  assert.deepEqual(result, {
    delivered: true,
    acknowledgement: 'structured',
  });
  assert.equal(
    commands.some((command) => command.includes('respawn-window')),
    false,
  );
});

test('retained fallback refuses a stale task signal during explicit recovery', async (t) => {
  commands.length = 0;
  paneCount = 1;
  promptAccepted = false;
  const existingSignal = {
    raw: '{"status":"running","timestamp":"2026-08-02T00:00:00.000Z"}',
    status: 'running',
    mtimeNs: '2000000000',
  };
  taskSignalOutput = `${existingSignal.mtimeNs}\n${existingSignal.raw}\n`;
  sessionState = {
    value: 'active',
    source: 'hook',
    confidence: 'high',
    observedAt: Date.now(),
  };
  t.after(() => {
    promptAccepted = true;
  });

  const result = await deliverPromptWithRetainedFallback({
    vars,
    target: 'test-1:dev',
    runnerId: 'grok',
    prompt: 'Read and execute SELF-REVIEW-FIX.md',
    launchAckSignalPath: '/tmp/SELF-REVIEW-FIX-SIGNAL.json',
    launchAckBaseline: existingSignal,
    priorPromptSendAttempted: true,
  });

  assert.equal(result.delivered, false);
  if (!result.delivered) {
    assert.equal(result.disposition, 'hold');
    assert.equal(result.retryable, false);
    assert.match(result.reason, /refusing duplicate delivery/);
  }
  assert.equal(
    commands.some((command) => command.includes('send-keys') || command.includes('respawn-window')),
    false,
  );
});

test('retained recovery prefers the exact prompt digest despite an unchanged task signal', async () => {
  commands.length = 0;
  paneCount = 1;
  promptAccepted = true;
  const existingSignal = {
    raw: '{"status":"running","timestamp":"2026-08-02T00:00:00.000Z"}',
    status: 'running',
    mtimeNs: '2000000000',
  };
  taskSignalOutput = `${existingSignal.mtimeNs}\n${existingSignal.raw}\n`;
  sessionState = {
    value: 'active',
    source: 'hook',
    confidence: 'high',
    observedAt: Date.now(),
  };

  const result = await deliverPromptWithRetainedFallback({
    vars,
    target: 'test-1:dev',
    runnerId: 'claude',
    prompt: 'Read and execute SELF-REVIEW-FIX.md',
    launchAckSignalPath: '/tmp/SELF-REVIEW-FIX-SIGNAL.json',
    launchAckBaseline: existingSignal,
    priorPromptSendAttempted: true,
  });

  assert.deepEqual(result, {
    delivered: true,
    acknowledgement: 'structured',
    turnToken: 'session-123:test-turn',
  });
  assert.equal(
    commands.some((command) => command.includes('send-keys') || command.includes('respawn-window')),
    false,
  );
});

test('retained fallback holds when safe-send leaves the task signal unchanged', async (t) => {
  commands.length = 0;
  paneCount = 1;
  promptAccepted = false;
  promptAcceptedSequence = [true];
  const unchangedSignal = {
    raw: '{"status":"running","timestamp":"2026-08-02T00:00:00.000Z"}',
    status: 'running',
    mtimeNs: '2000000000',
  };
  taskSignalOutput = `${unchangedSignal.mtimeNs}\n${unchangedSignal.raw}\n`;
  sessionState = {
    value: 'active',
    source: 'hook',
    confidence: 'high',
    observedAt: Date.now(),
  };
  t.after(() => {
    promptAcceptedSequence = null;
    taskSignalOutput = '2000000000\n{"status":"running","timestamp":"2026-08-02T00:00:00.000Z"}\n';
  });

  const result = await deliverPromptWithRetainedFallback({
    vars,
    target: 'test-1:dev',
    runnerId: 'claude',
    prompt: 'Read and execute SELF-REVIEW-FIX.md',
    launchAckSignalPath: '/tmp/SELF-REVIEW-FIX-SIGNAL.json',
    launchAckBaseline: unchangedSignal,
    timeoutMs: 5,
  });

  assert.equal(result.delivered, false);
  if (!result.delivered) {
    assert.equal(result.disposition, 'hold');
    assert.equal(result.retryable, false);
    assert.match(result.reason, /was sent, but .* did not acknowledge it/);
  }
});

test('retained fallback uses an exact runner hook when the task signal baseline is unavailable', async () => {
  commands.length = 0;
  paneCount = 1;
  promptAccepted = true;
  sessionState = {
    value: 'active',
    source: 'hook',
    confidence: 'high',
    observedAt: Date.now(),
  };

  const result = await deliverPromptWithRetainedFallback({
    vars,
    target: 'test-1:dev',
    runnerId: 'claude',
    prompt: 'Read and execute SELF-REVIEW-FIX.md',
    launchAckSignalPath: '/tmp/SELF-REVIEW-FIX-SIGNAL.json',
    launchAckBaseline: null,
  });

  assert.deepEqual(result, {
    delivered: true,
    acknowledgement: 'structured',
    turnToken: 'session-123:test-turn',
  });
});

test('warm Cursor retained handoff uses argv relaunch and requires a fresh task signal', async (t) => {
  commands.length = 0;
  paneCount = 1;
  advanceTaskSignalOnRespawn = true;
  taskSignalOutput = '0\n\n';
  t.after(() => {
    advanceTaskSignalOnRespawn = false;
    taskSignalOutput = '2000000000\n{"status":"running","timestamp":"2026-08-02T00:00:00.000Z"}\n';
  });
  const result = await deliverPromptWithRetainedFallback({
    vars,
    target: '%1',
    runnerId: 'cursor',
    prompt: 'Read and execute SELF-REVIEW-FIX.md',
    replacementReadySignalPath: '/tmp/PRIOR-TASK-SIGNAL.json',
    launchAckSignalPath: '/tmp/SELF-REVIEW-FIX-SIGNAL.json',
    launchAckBaseline: { raw: null, status: null, mtimeNs: '0' },
    timeoutMs: 5,
  });

  assert.deepEqual(result, { delivered: true, acknowledgement: 'structured' });
  assert.equal(
    commands.some((command) => command.includes('respawn-window')),
    true,
  );
  assert.equal(
    commands.some((command) => command.includes('send-keys')),
    false,
  );
});

test('retained fallback disables hook proof when the slot-clock baseline is unavailable', async (t) => {
  commands.length = 0;
  paneCount = 1;
  promptAccepted = true;
  promptAcceptanceBaselineMs = null;
  sessionState = {
    value: 'active',
    source: 'hook',
    confidence: 'high',
    observedAt: Date.now(),
  };
  t.after(() => {
    promptAcceptanceBaselineMs = 1_000;
  });

  const result = await deliverPromptWithRetainedFallback({
    vars,
    target: 'test-1:dev',
    runnerId: 'claude',
    prompt: 'Read and execute SELF-REVIEW-FIX.md',
    launchAckSignalPath: '/tmp/SELF-REVIEW-FIX-SIGNAL.json',
    launchAckBaseline: null,
    timeoutMs: 5,
  });

  assert.equal(result.delivered, false);
  if (!result.delivered) assert.equal(result.disposition, 'hold');
});

test('retained resume defers to safe-send when the session file is gone', async () => {
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
    disposition: 'safe-send',
    reason: 'Retained claude session path is unavailable: /sessions/missing.jsonl',
  });
  assert.equal(
    commands.some((command) => command.includes('respawn-window')),
    false,
  );
});

test('retained resume defers to safe-send when exact session state is unavailable', async () => {
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
  if (!result.delivered) assert.equal(result.disposition, 'safe-send');
  assert.equal(
    commands.some((command) => command.includes('respawn-window')),
    false,
  );
});

test('retained resume defers to safe-send when the persisted session id is missing', async () => {
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
    disposition: 'safe-send',
    reason: "Runner 'claude' requires a persisted session id for retained handoff",
  });
  assert.deepEqual(commands, []);
});

test('retained resume defers to safe-send when the persisted session path is missing', async () => {
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
    disposition: 'safe-send',
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
    assert.equal(result.disposition, 'safe-send');
    assert.match(result.reason, /has 2 panes/);
  }
  assert.equal(
    commands.some((command) => command.includes('respawn-window')),
    false,
  );
});
