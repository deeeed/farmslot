import assert from 'node:assert/strict';
import test from 'node:test';

import {
  captureQaAfterReview,
  type ProjectQaConfig,
  validateQaConfig,
} from '../src/contracts/qa.js';

const config: ProjectQaConfig = {
  default_profile: 'pr',
  profiles: [
    { id: 'pr', title: 'PR validation', template_id: 'validation/shared', inputs: { scope: 'pr' } },
  ],
};

test('automatic QA is absent by default and snapshots one enabled profile without changing it', () => {
  assert.equal(captureQaAfterReview(undefined, {}), undefined);
  assert.equal(captureQaAfterReview(config, {}), undefined);
  assert.equal(
    captureQaAfterReview({ ...config, after_review: { enabled: false, profile_id: 'pr' } }, {}),
    undefined,
  );
  const enabled = { ...config, after_review: { enabled: true, profile_id: 'pr' } };
  const snapshot = captureQaAfterReview(enabled, {
    review: {
      workflow: 'qa',
      sessionIntent: 'reset',
      scope: 'full',
      qaInputs: { environment: 'staging' },
    },
  })!;
  assert.equal(snapshot.state, 'pending');
  assert.deepEqual(snapshot.selection.inputs, { scope: 'pr', environment: 'staging' });
  assert.equal(snapshot.review.qaProfileId, 'pr');
  snapshot.selection.profile.title = 'Changed';
  snapshot.selection.inputs.scope = 'release';
  assert.equal(config.profiles[0].title, 'PR validation');
  assert.equal(config.profiles[0].inputs!.scope, 'pr');
});

test('automatic QA config requires an explicit boolean and an existing profile', () => {
  for (const after_review of [
    null,
    {},
    { enabled: 'yes', profile_id: 'pr' },
    { enabled: true },
    { enabled: true, profile_id: 'unknown' },
    { enabled: true, profile_id: 'pr', command: 'run' },
  ])
    assert.throws(() => validateQaConfig({ ...config, after_review }));
  assert.doesNotThrow(() =>
    validateQaConfig({ ...config, after_review: { enabled: false, profile_id: 'pr' } }),
  );
});
