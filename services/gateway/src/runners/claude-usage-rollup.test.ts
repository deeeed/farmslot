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
mock.module('./review-workspace-context.js', {
  namedExports: {
    reviewWorkspaceRunnerVars: async () => makeVars({ remoteRepo: '/owned/workspace/source' }),
  },
});
const commands: string[] = [];
const execution = await import('../core/exec.js');
mock.module('../core/exec.js', {
  namedExports: {
    ...execution,
    execOnSlot: async (_vars: unknown, command: string) => {
      commands.push(command);
      return { stdout: '["/tmp/initial.jsonl","/tmp/fix2.jsonl"]', stderr: '', exitCode: 0 };
    },
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

test('slotless Claude recovery uses the admitted workspace task instead of the gateway mirror', async () => {
  const run = {
    ...makeRun({ flowType: 'review-pr', slotId: null }),
    reviewWorkspace: {
      workspaceId: 'owned',
      machine: 'owned',
      executionNodeId: 'owned',
      checkoutPath: '/owned/workspace/source',
      taskPath: '/owned/workspace/task',
      artifactPath: '/owned/workspace/task/artifacts',
    },
    agentContexts: [
      {
        id: 'review',
        role: 'review' as const,
        label: 'Review',
        runId: 'run-1',
        slotId: null,
        status: 'failed' as const,
        runner: 'claude',
        taskFile: '/gateway/view/TASK.md',
        startedAt: '2026-10-29T01:00:00Z',
        completedAt: '2026-10-29T02:00:00Z',
      },
    ],
  };
  const recovered = await recoverClaudeUsageSessions(run);
  assert.equal(recovered.length, 2);
  assert(recovered.every((session) => session.contextId === 'review'));
  assert(commands.at(-1)?.includes('/owned/workspace/task'));
  assert(!commands.at(-1)?.includes('/gateway/view'));
});
