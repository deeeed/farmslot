import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveAlphaFeaturesEnabled } from './alpha-features.js';

test('an explicit stored preference overrides the dev/prod default', () => {
  assert.equal(resolveAlphaFeaturesEnabled('true', false), true);
  assert.equal(resolveAlphaFeaturesEnabled('false', true), false);
});

test('falls back to the dev/prod default when no valid preference is stored', () => {
  assert.equal(resolveAlphaFeaturesEnabled(null, true), true);
  assert.equal(resolveAlphaFeaturesEnabled(null, false), false);
  assert.equal(resolveAlphaFeaturesEnabled('garbage', true), true);
  assert.equal(resolveAlphaFeaturesEnabled('garbage', false), false);
});
