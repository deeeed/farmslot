import assert from 'node:assert/strict';
import test from 'node:test';

import {
  type RawProjectJson,
  validatePublicationReviewConfig,
  validateReviewConfig,
} from './config.js';

test('publication counts reject removed fields rather than silently reducing their minimum', () => {
  validatePublicationReviewConfig(
    { publication_review: { dev: { minimum_reviews: 2 } } },
    'project.json',
  );
  for (const field of ['minimum_independent_reviews', 'require_cross_runner']) {
    assert.throws(
      () =>
        validatePublicationReviewConfig(
          { publication_review: { dev: { [field]: 2 } } } as RawProjectJson,
          'project.json',
        ),
      /unsupported property/,
    );
  }
  assert.throws(
    () =>
      validatePublicationReviewConfig(
        { publication_review: { dev: { minimum_reviews: -1 } } },
        'project.json',
      ),
    /non-negative integer/,
  );
});

test('review defaults expose mode and reject removed session policy', () => {
  for (const mode of ['warm', 'cold'] as const)
    validateReviewConfig({ review: { mode } }, 'project.json');
  validateReviewConfig({ review: { runner: 'codex', model: 'gpt-6-astra' } }, 'project.json');
  assert.throws(
    () =>
      validateReviewConfig(
        { review: { mode: 'resume' } } as unknown as RawProjectJson,
        'project.json',
      ),
    /warm or cold/,
  );
  assert.throws(
    () =>
      validateReviewConfig(
        { review: { session_policy: 'warm-per-reviewer' } } as RawProjectJson,
        'project.json',
      ),
    /unsupported property/,
  );
  assert.throws(
    () =>
      validateReviewConfig({ self_review: { runner: 'codex' } } as RawProjectJson, 'project.json'),
    /self_review was removed/,
  );
});
