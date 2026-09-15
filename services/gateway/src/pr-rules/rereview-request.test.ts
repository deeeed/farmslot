import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRereviewRequest,
  liveReviewSessionSlot,
  type RereviewRun,
  rereviewTarget,
  selectRereviewTeam,
} from './rereview-request.js';

const run: RereviewRun = {
  id: 'run-1',
  flowType: 'review-pr',
  status: 'blocked',
  project: 'mobile',
  ticketOrPr: 'MetaMask/metamask-mobile#36169',
  prNumber: 36169,
  slotId: 'mini-mm-2',
  effort: 'standard',
  metrics: { runner: 'claude', model: 'opus' },
};
const perps = {
  id: 'team-perps',
  config: {
    name: 'Perps',
    repositories: [
      { repo: 'MetaMask/metamask-mobile', project: 'mobile' },
      { repo: 'MetaMask/core', project: 'core' },
    ],
  },
};
const platform = {
  id: 'team-platform',
  config: {
    name: 'Platform',
    repositories: [{ repo: 'metamask/metamask-mobile', project: 'ext' }],
  },
};

test('the request resumes the same slot, runner and model with incremental scope', () => {
  const request = buildRereviewRequest(run, [perps], 'owner-1', { now: 5 });
  assert.equal(request.teamId, 'team-perps');
  assert.deepEqual(request.pr, {
    host: 'github.com',
    repo: 'MetaMask/metamask-mobile',
    number: 36169,
  });
  assert.equal(request.idempotencyKey, 'rereview:run-1:5');
  assert.equal(request.autoStart, true);
  assert.deepEqual(request.execution, {
    slotPolicy: { kind: 'exact', slotId: 'mini-mm-2' },
    models: [{ runner: 'claude', model: 'opus', effort: 'standard' }],
  });
  assert.deepEqual(request.review, {
    sessionIntent: 'resume',
    scope: 'incremental',
    validationDepth: 'static-code',
    busySession: 'wait',
  });
  assert.equal(request.source.reference, 'run:run-1');
});

test('without recorded runner/model the team configuration decides execution', () => {
  const request = buildRereviewRequest(
    { ...run, metrics: { runner: null, model: null } },
    [perps],
    'owner-1',
  );
  assert.equal(request.execution, undefined);
});

test('team selection covers the repo case-insensitively and prefers the run project', () => {
  assert.equal(
    selectRereviewTeam([platform, perps], 'MetaMask/metamask-mobile', 'mobile').id,
    'team-perps',
  );
  assert.equal(
    selectRereviewTeam([platform], 'MetaMask/metamask-mobile', 'mobile').id,
    'team-platform',
  );
  assert.throws(() => selectRereviewTeam([perps], 'other/repo', 'mobile'), /No review team covers/);
  assert.throws(
    () =>
      selectRereviewTeam([platform, { ...perps, id: 'p2' }], 'MetaMask/metamask-mobile', 'nope'),
    /use Request review \/ QA to choose one/,
  );
});

test('only finished or blocked review-pr runs can be re-reviewed', () => {
  assert.throws(
    () => buildRereviewRequest({ ...run, flowType: 'fix-bug' }, [perps], 'o'),
    /not a review/,
  );
  assert.throws(
    () => buildRereviewRequest({ ...run, status: 'monitoring' }, [perps], 'o'),
    /is monitoring/,
  );
  assert.deepEqual(rereviewTarget({ ticketOrPr: 'not-a-ref', prNumber: 7 }, 'org/app'), {
    repo: 'org/app',
    number: 7,
  });
  assert.throws(
    () => rereviewTarget({ ticketOrPr: 'not-a-ref', prNumber: undefined }),
    /does not identify/,
  );
});

test('the live reviewer session is the run slot whose working review context is bound to the run', () => {
  const ctx = (runId: string, role = 'review') => ({ id: role, role, runId }) as never;
  const slots = [
    { slot: 'mini-mm-2', agent: 'working', agentContexts: [ctx('run-1')] },
    { slot: 'mini-mm-3', agent: 'idle', agentContexts: [ctx('run-1')] },
    { slot: 'mini-mm-4', agent: 'working', agentContexts: [ctx('other')] },
  ] as never;
  assert.equal(
    liveReviewSessionSlot({ id: 'run-1', slotId: 'mini-mm-2' }, slots)?.slot,
    'mini-mm-2',
  );
  assert.equal(
    liveReviewSessionSlot({ id: 'run-1', slotId: 'mini-mm-3' }, slots),
    undefined,
    'worker gone',
  );
  assert.equal(
    liveReviewSessionSlot({ id: 'run-1', slotId: 'mini-mm-4' }, slots),
    undefined,
    'another run owns it',
  );
  assert.equal(liveReviewSessionSlot({ id: 'run-1', slotId: null }, slots), undefined);
});
