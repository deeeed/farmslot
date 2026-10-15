import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

await import('../runtime/mock-pty.test-support.js');
const core = await import('../core/exec.js');
const contexts = await import('../agents/contexts.js');
const processes = await import('../runners/session-process.js');
const store = await import('../runs/store.js');
const { makeRun } = await import('../run-engine/test-fixtures.js');
const registry = await import('../runners/registry.js');
let currentRun: ReturnType<typeof makeRun> | undefined;
let probes = 0;
let terminalAt = 3;
let windowPresent = true;
let processStates: Array<'present' | 'absent' | 'unknown'> = [];
const statuses: string[] = [];
mock.module('../core/exec.js', {
  namedExports: {
    ...core,
    execOnSlot: async (_vars: unknown, command: string) => {
      if (command.startsWith('cat ')) {
        probes++;
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            status: probes >= terminalAt ? 'complete' : 'running',
            outcome: probes >= terminalAt ? 'success' : undefined,
          }),
          stderr: '',
        };
      }
      if (command.includes('list-panes'))
        return {
          exitCode: windowPresent ? 0 : 1,
          stdout: command.includes('pane_pid') ? '123' : '%1',
          stderr: '',
        };
      return { exitCode: 0, stdout: 'yes', stderr: '' };
    },
  },
});
mock.module('../agents/contexts.js', {
  namedExports: {
    ...contexts,
    markAgentContextStatus: async (_id: string, _role: string, status: string) => {
      statuses.push(status);
    },
  },
});
mock.module('../runners/session-process.js', {
  namedExports: {
    ...processes,
    probeRunnerDescendantPid: async () => ({
      state: processStates.shift() ?? 'absent',
      pid: '456',
    }),
  },
});
mock.module('../runs/store.js', {
  namedExports: { ...store, getRun: () => currentRun },
});
const { waitForReviewCompletion } = await import('./review-agent.js');
const { makeVars } = await import('../runners/test-fixtures.js');
const vars = makeVars();

test('written feedback and an inactive runner still wait for their own terminal mark', async () => {
  probes = 0;
  terminalAt = 3;
  windowPresent = true;
  statuses.length = 0;
  const result = await waitForReviewCompletion(
    vars,
    '%1',
    'tasks/review',
    500,
    'run',
    'claude',
    'reviewer',
    'REVIEW-SIGNAL.json',
    'artifacts/feedback.md',
    null,
    0,
  );
  assert.equal(result, true);
  assert.equal(probes, 3);
  assert.deepEqual(statuses, ['complete']);
});

test('a closed window with feedback but no own terminal mark fails closed', async () => {
  probes = 0;
  terminalAt = Number.POSITIVE_INFINITY;
  windowPresent = false;
  statuses.length = 0;
  await assert.rejects(
    waitForReviewCompletion(
      vars,
      '%1',
      'tasks/review',
      500,
      'run',
      'claude',
      'reviewer',
      'REVIEW-SIGNAL.json',
      'artifacts/feedback.md',
      null,
      0,
    ),
    /REVIEW-SIGNAL.json is missing/,
  );
  assert.deepEqual(statuses, ['blocked']);
});

test('an observed runner exit without its terminal mark fails promptly', async () => {
  probes = 0;
  terminalAt = Number.POSITIVE_INFINITY;
  windowPresent = true;
  processStates = ['present', 'absent'];
  statuses.length = 0;
  await assert.rejects(
    waitForReviewCompletion(
      vars,
      '%1',
      'tasks/review',
      500,
      'run',
      'claude',
      'reviewer',
      'REVIEW-SIGNAL.json',
      'artifacts/feedback.md',
      null,
      0,
    ),
    /REVIEW-SIGNAL.json is missing after the reviewer runner exited/,
  );
  assert.equal(probes, 3, 'two polls and a terminal reread, without waiting for timeout');
  assert.deepEqual(statuses, ['blocked']);
});

test('an unknown process probe keeps waiting for the reviewer terminal mark', async () => {
  probes = 0;
  terminalAt = 3;
  windowPresent = true;
  processStates = ['present', 'unknown'];
  statuses.length = 0;
  assert.equal(
    await waitForReviewCompletion(
      vars,
      '%1',
      'tasks/review',
      500,
      'run',
      'claude',
      'reviewer',
      'REVIEW-SIGNAL.json',
      'artifacts/feedback.md',
      null,
      0,
    ),
    true,
  );
  assert.deepEqual(statuses, ['complete']);
});

test('a terminal mark arriving during the exit probe still completes', async () => {
  probes = 0;
  terminalAt = 3;
  windowPresent = true;
  processStates = ['present', 'absent'];
  statuses.length = 0;
  assert.equal(
    await waitForReviewCompletion(
      vars,
      '%1',
      'tasks/review',
      500,
      'run',
      'claude',
      'reviewer',
      'REVIEW-SIGNAL.json',
      'artifacts/feedback.md',
      null,
      0,
    ),
    true,
  );
  assert.equal(probes, 3);
  assert.deepEqual(statuses, ['complete']);
});

test('native launch failure is visible on the first poll while its runner stays alive', async (t) => {
  probes = 0;
  terminalAt = Number.POSITIVE_INFINITY;
  windowPresent = true;
  processStates = ['present'];
  statuses.length = 0;
  const at = Date.now();
  currentRun = {
    ...makeRun(),
    agentContexts: [
      {
        id: 'reviewer',
        role: 'review',
        label: 'Review',
        status: 'working',
        slotId: 'slot',
        runId: 'run',
        runner: 'codex',
        model: 'opus',
        runnerSessionId: 'exact-session',
        runnerSessionPath: '/session.jsonl',
        attemptStartedAt: new Date(at - 100).toISOString(),
      },
    ],
  };
  t.after(() => {
    currentRun = undefined;
    processStates = [];
  });
  const observability = registry.getRunnerObservability('codex');
  assert.ok(observability);
  t.mock.method(observability, 'getSessionDeliveryState', async () => ({
    value: 'idle',
    source: 'signal',
    confidence: 'high',
    observedAt: at,
    sessionId: 'exact-session',
    failure: "The 'opus' model is not supported",
  }));
  await assert.rejects(
    waitForReviewCompletion(
      vars,
      '%1',
      'tasks/review',
      500,
      'run',
      'codex',
      'reviewer',
      'REVIEW-SIGNAL.json',
      'artifacts/feedback.md',
      null,
      0,
    ),
    /Reviewer reviewer failed: The 'opus' model is not supported/,
  );
  assert.equal(probes, 1);
  assert.deepEqual(statuses, ['failed']);
});

test('an accepted reviewer that exits before the first poll fails promptly', async (t) => {
  probes = 0;
  terminalAt = Number.POSITIVE_INFINITY;
  windowPresent = true;
  processStates = ['absent'];
  statuses.length = 0;
  currentRun = {
    ...makeRun(),
    agentContexts: [
      {
        id: 'reviewer',
        role: 'review',
        label: 'Review',
        status: 'working',
        slotId: 'slot',
        runId: 'run',
        runner: 'claude',
        model: 'opus',
      },
    ],
  };
  t.after(() => {
    currentRun = undefined;
    processStates = [];
  });
  await assert.rejects(
    waitForReviewCompletion(
      vars,
      '%1',
      'tasks/review',
      500,
      'run',
      'claude',
      'reviewer',
      'REVIEW-SIGNAL.json',
      'artifacts/feedback.md',
      null,
      0,
    ),
    /REVIEW-SIGNAL.json is missing after the reviewer runner exited/,
  );
  assert.equal(probes, 2, 'one poll and a final terminal reread');
});
