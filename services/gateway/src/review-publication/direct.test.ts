import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProjectConfig, PRTeamProfile } from '@farmslot/protocol';

import { selectDirectReviewPublication } from './direct.js';
const request = { flowType: 'review-pr' as const, project: 'farm', ticketOrPr: 'example/app#42' };
const project = {
  workflowDefaults: {
    'review-pr': { review: { sessionIntent: 'reset', scope: 'full', publishReview: true } },
  },
} as ProjectConfig;
const team = {
  id: 'team',
  ownerId: 'owner',
  config: {
    account: { host: 'github.com', login: 'reviewer' },
    repositories: [{ repo: 'example/app', project: 'farm' }],
  },
} as PRTeamProfile;
test('direct publication infers a unique owned team and retains explicit opt-out', () => {
  const result = selectDirectReviewPublication(request, project, 'owner', [team])!;
  assert.equal(result.policy.enabled, true);
  assert.equal(result.policy.source, 'farm');
  assert.equal(result.policy.teamId, 'team');
  const off = selectDirectReviewPublication(
    { ...request, publishReview: false },
    project,
    'owner',
    [],
  )!;
  assert.deepEqual(off.policy, { enabled: false, source: 'request' });
  assert.equal(selectDirectReviewPublication(request, null, 'owner', [])?.policy.enabled, false);
});
test('missing, ambiguous and foreign publication bindings fail before run creation', () => {
  assert.throws(
    () => selectDirectReviewPublication(request, project, 'owner', []),
    /needs an owned PR team/,
  );
  assert.throws(
    () =>
      selectDirectReviewPublication(request, project, 'owner', [team, { ...team, id: 'second' }]),
    /Several PR teams/,
  );
  assert.equal(
    selectDirectReviewPublication({ ...request, reviewTeamId: 'second' }, project, 'owner', [
      team,
      { ...team, id: 'second' },
    ])?.policy.teamId,
    'second',
  );
  assert.throws(
    () =>
      selectDirectReviewPublication({ ...request, reviewTeamId: 'team' }, project, 'other', [team]),
    /does not belong/,
  );
  assert.throws(
    () =>
      selectDirectReviewPublication(
        { ...request, flowType: 'qa', publishReview: true },
        project,
        'owner',
        [team],
      ),
    /static review/,
  );
});
