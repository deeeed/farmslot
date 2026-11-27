import assert from 'node:assert/strict';
import test from 'node:test';

import { NATIVE_WORKER_ENSURE, NATIVE_WORKER_TRANSFER } from '@farmslot/agent-runtime/native';
import { type AgentContext, Methods, type Run } from '@farmslot/protocol';

import { makeRun } from '../../run-engine/test-fixtures.js';

import { nodeLaunchRelease, nodeReleasedSessions, sessionsNeedingAPerson } from './host-refresh.js';

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
        context('primary', 'primary-worker'),
        context('fix-bug', 'fix-bug-worker'),
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
        [
          'worker',
          'primary-worker',
          'fix-bug-worker',
          'reviewer',
          'review-fixer',
          'ci-fixer',
          'workspace',
          'copilot',
        ],
      ),
    ],
    [
      ['worker', 'dev worker of run 2137ec52'],
      ['primary-worker', 'primary worker of run 2137ec52'],
      ['fix-bug-worker', 'fix-bug worker of run 2137ec52'],
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

test('a node launch may stop its owner’s bound sessions there that no active run keeps', () => {
  const active = run(
    { id: '2137ec52-6d2f-4cad-80f9-a60766346929', status: 'blocked' },
    {
      agentContexts: [
        context('dev', 'worker', 'macpro'),
        context('review', 'reviewer', 'macpro'),
        context('review', 'local-reviewer'),
      ],
    },
  );
  const done = run({ status: 'done' }, { agentContexts: [context('dev', 'old-worker', 'macpro')] });
  const otherOwner = context('review', 'foreign', 'macpro');
  otherOwner.nativeSession!.ownerPrincipalId = 'someone-else';
  const foreign = run({ status: 'blocked' }, { agentContexts: [otherOwner] });

  assert.deepEqual(nodeReleasedSessions([active, done, foreign], 'macpro', 'farm-automation'), [
    'reviewer',
    'old-worker',
  ]);
  // A session an active run keeps is kept even when a finished run also bound it.
  const reused = run(
    { status: 'done' },
    { agentContexts: [context('review', 'worker', 'macpro')] },
  );
  assert.deepEqual(nodeReleasedSessions([reused, active], 'macpro', 'farm-automation'), [
    'reviewer',
  ]);
});

test('an ensure’s own session is never on its release list; a transfer’s is', () => {
  const finished = run(
    { status: 'done' },
    {
      agentContexts: [context('review', 'target', 'macpro'), context('review', 'other', 'macpro')],
    },
  );
  const release = (method: string) =>
    nodeLaunchRelease([finished], 'macpro', 'farm-automation', method, { sessionId: 'target' });
  assert.deepEqual(release(Methods.NATIVE_SESSION_ENSURE), ['other']);
  assert.deepEqual(release(NATIVE_WORKER_ENSURE), ['other']);
  assert.deepEqual(release(NATIVE_WORKER_TRANSFER), ['target', 'other']);
});
