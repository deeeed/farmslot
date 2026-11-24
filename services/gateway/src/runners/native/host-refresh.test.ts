import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentContext, Run } from '@farmslot/protocol';

import { makeRun } from '../../run-engine/test-fixtures.js';

import { sessionsNeedingAPerson } from './host-refresh.js';

const context = (
  role: AgentContext['role'],
  sessionId: string,
  executionNodeId = 'local',
): AgentContext => ({
  id: `${role}-${sessionId}`,
  role,
  label: role,
  status: 'idle',
  slotId: 'macwork-mmt-2',
  runId: 'run',
  nativeSession: {
    sessionId,
    executionNodeId,
    ownerPrincipalId: 'farm-automation',
    leaseId: 'lease',
    commandId: 'command',
  },
});

/** makeRun keeps only its own fields; contexts and the workspace target are set after. */
function run(overrides: Partial<Run>, extra: Pick<Run, 'agentContexts'> & Partial<Run>): Run {
  return Object.assign(makeRun(overrides), extra);
}

function needingAPerson(runs: Run[], ids: string[]) {
  return sessionsNeedingAPerson(
    runs,
    ids.map((id) => ({ id })),
  );
}

test('an active run’s own worker, CI fix and static review workspace keep the host; reviewers and review fixes do not', () => {
  const pipeline = run(
    { id: '2137ec52-6d2f-4cad-80f9-a60766346929', status: 'blocked' },
    {
      agentContexts: [
        context('dev', 'worker'),
        context('review', 'reviewer'),
        context('review-fix', 'review-fixer'),
        context('ci-fix', 'ci-fixer'),
      ],
    },
  );
  const workspace = run(
    { id: 'aaaabbbb-0000-0000-0000-000000000000', status: 'reviewing' },
    {
      agentContexts: [context('review', 'workspace')],
      reviewWorkspaceTarget: { machine: 'macwork' },
    },
  );

  assert.deepEqual(
    [
      ...needingAPerson(
        [pipeline, workspace],
        ['worker', 'reviewer', 'review-fixer', 'ci-fixer', 'workspace', 'copilot'],
      ),
    ],
    [
      ['worker', 'dev worker of run 2137ec52'],
      ['ci-fixer', 'ci-fix worker of run 2137ec52'],
      ['workspace', 'static review workspace of run aaaabbbb'],
    ],
  );
});

test('finished runs, other nodes and sessions not live on the host keep nothing', () => {
  const done = run({ status: 'done' }, { agentContexts: [context('dev', 'old-worker')] });
  const remote = run(
    { status: 'blocked' },
    { agentContexts: [context('dev', 'remote-worker', 'macpro')] },
  );
  const gone = run({ status: 'blocked' }, { agentContexts: [context('dev', 'stopped')] });

  assert.equal(needingAPerson([done, remote, gone], ['old-worker', 'remote-worker']).size, 0);
});
