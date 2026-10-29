import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { AgentContext } from '@farmslot/protocol';

import { makeRun } from '../run-completion/test-fixtures.js';

import { makeVars } from './test-fixtures.js';

await import('../runtime/mock-pty.test-support.js');
const config = await import('../core/config.js');
mock.module('../core/config.js', {
  namedExports: { ...config, loadSlotVars: async () => makeVars() },
});
const execution = await import('../core/exec.js');
mock.module('../core/exec.js', {
  namedExports: {
    ...execution,
    execOnSlot: async () => ({
      stdout: '["/tmp/initial.jsonl","/tmp/fix2.jsonl"]',
      stderr: '',
      exitCode: 0,
    }),
  },
});
const { recoverClaudeUsageSessions } = await import('./claude-usage-sessions.js');

test('Claude rollup retains the initial session and each worker fix once, excluding reviewers', async () => {
  const context = (
    id: string,
    role: AgentContext['role'],
    runnerSessionPath: string,
  ): AgentContext => ({
    id,
    role,
    label: id,
    runId: 'run-1',
    slotId: 'test-slot',
    status: 'complete',
    runner: 'claude',
    runnerSessionId: id,
    runnerSessionPath,
    taskFile: 'tasks/owned/TASK.md',
    startedAt: '2026-10-29T01:00:00Z',
    completedAt: '2026-10-29T02:00:00Z',
  });
  const run = {
    ...makeRun({
      flowType: 'fix-bug',
      slotId: 'test-slot',
      metrics: {
        nudgeCount: 0,
        model: 'opus',
        runner: 'claude',
        runnerSessionPath: '/tmp/initial.jsonl',
      },
    }),
    agentContexts: [
      context('fix-bug', 'fix-bug', '/tmp/fix1.jsonl'),
      context('review-fix', 'review-fix', '/tmp/fix1.jsonl'),
      context('reviewer', 'review', '/tmp/reviewer.jsonl'),
    ],
  };
  const recovered = await recoverClaudeUsageSessions(run);
  assert.deepEqual(recovered.map((session) => session.runnerSessionPath).sort(), [
    '/tmp/fix1.jsonl',
    '/tmp/fix2.jsonl',
    '/tmp/initial.jsonl',
  ]);
});
