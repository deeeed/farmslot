import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  missingAnchors,
  REQUIRED_ANCHORS,
  SKILL_PATH,
} from './check-review-loop-validation-contract.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('the canonical skill preserves the intermediate/final validation split', () => {
  assert.deepEqual(missingAnchors(readFileSync(resolve(repoRoot, SKILL_PATH), 'utf8')), []);
});

test('a missing command contract fails even when the remaining anchors are present', () => {
  for (const omitted of REQUIRED_ANCHORS) {
    const markdown = REQUIRED_ANCHORS.filter((anchor) => anchor !== omitted)
      .map((anchor) => anchor.text)
      .join('\n');
    assert.deepEqual(
      missingAnchors(markdown).map((anchor) => anchor.id),
      [omitted.id],
    );
  }
});

test('soft wrapping does not change the validation contract', () => {
  const markdown = REQUIRED_ANCHORS.map((anchor) => anchor.text.replaceAll(' ', '\n')).join('\n');
  assert.deepEqual(missingAnchors(markdown), []);
});
