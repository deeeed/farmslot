import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

await import('../runtime/mock-pty.test-support.js');
const core = await import('../core/exec.js');
const contexts = await import('../agents/contexts.js');
const processes = await import('../runners/session-process.js');
let probes = 0;
let terminalAt = 3;
let windowPresent = true;
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
  namedExports: { ...processes, isRunnerAliveUnderPane: async () => false },
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
