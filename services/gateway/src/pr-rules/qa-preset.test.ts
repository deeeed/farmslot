import assert from 'node:assert/strict';
import test from 'node:test';

import { type ProjectQaConfig, prReviewPurpose, type PRRulePreviewItem } from '@farmslot/protocol';

import { resolvePreviewQaPreset } from './qa-preset.js';

const config: ProjectQaConfig = {
  default_profile: 'pr',
  profiles: [
    { id: 'pr', title: 'PR QA', template_id: 'validation/shared', inputs: { domain: 'payments' } },
  ],
};

function item(): PRRulePreviewItem {
  return {
    subject: {
      pr: { host: 'github.com', repo: 'example/app', number: 1 },
      title: 'Example change',
      headSha: 'head',
      observedAt: '2026-09-15T00:00:00Z',
      facts: {},
    },
    project: 'example',
    reviewProfile: 'team',
    match: { state: 'match', reasons: [] },
    configurationErrors: [],
    review: { mode: 'cold' as const, workflow: 'qa' },
  };
}

test('default and explicit farm presets resolve to the same intake purpose', () => {
  const implicit = item();
  const explicit = item();
  explicit.review = { mode: 'warm' as const, workflow: 'qa', qaProfileId: 'pr' };
  resolvePreviewQaPreset(implicit, config);
  resolvePreviewQaPreset(explicit, config);
  assert.deepEqual(implicit.review, explicit.review);
  assert.notEqual(implicit.reviewPurpose?.configured, explicit.reviewPurpose?.configured);
  assert.equal(implicit.reviewPurpose?.resolved, explicit.reviewPurpose?.resolved);
  assert.equal(prReviewPurpose(implicit.review), prReviewPurpose(explicit.review));
  assert.deepEqual(implicit.review?.qaInputs, { domain: 'payments' });
});

test('missing farm presets leave an actionable preview and static review needs none', () => {
  const qa = item();
  resolvePreviewQaPreset(qa);
  assert.match(qa.configurationErrors.join(' '), /no QA presets/);
  const review = item();
  review.review = { mode: 'warm' as const, workflow: 'review' };
  resolvePreviewQaPreset(review);
  assert.deepEqual(review.configurationErrors, []);
});
