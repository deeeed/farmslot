import assert from 'node:assert/strict';
import test from 'node:test';

import { isValidRunSlug } from '../src/validate/run-slug.js';

test('run-slug grammar accepts fleet slugs with and without a ticket', () => {
  assert.equal(isValidRunSlug('20260703T154211Z-fleet-dev-proj-123-a1b2c3d4'), true);
  assert.equal(isValidRunSlug('20260703T160000Z-skill-fix-bug-a1b2c3d4'), true);
  assert.equal(isValidRunSlug('20260703T160000Z-fleet-review-a1b2c3d4'), true);
});

test('run-slug grammar rejects malformed slugs', () => {
  // Missing 8-hex disambiguator.
  assert.equal(isValidRunSlug('20260703T160000Z-fleet-dev-proj-123'), false);
  // Uppercase in the hex disambiguator.
  assert.equal(isValidRunSlug('20260703T160000Z-fleet-dev-A1B2C3D4'), false);
  // Non-compact timestamp.
  assert.equal(isValidRunSlug('2026-07-03T16:00:00Z-fleet-dev-a1b2c3d4'), false);
  // Empty / junk.
  assert.equal(isValidRunSlug('nope'), false);
  assert.equal(isValidRunSlug(''), false);
});
