import assert from 'node:assert/strict';
import test from 'node:test';

import { buildComparisonVariant, nextFreeComparisonVariant } from '../../src/contracts/index.js';

test('buildComparisonVariant sanitizes model token', () => {
  assert.equal(buildComparisonVariant('claude', 'sonnet-4.6'), 'claude-sonnet-4-6');
  assert.equal(buildComparisonVariant('codex', 'gpt-5.5'), 'codex-gpt-5-5');
});

test('buildComparisonVariant returns empty when input falsy or all-punct', () => {
  assert.equal(buildComparisonVariant(null, 'sonnet'), '');
  assert.equal(buildComparisonVariant('claude', undefined), '');
  assert.equal(buildComparisonVariant('claude', '!!!'), '');
});

test('nextFreeComparisonVariant returns base when no sibling collides', () => {
  assert.equal(nextFreeComparisonVariant([], 'claude', 'sonnet-4.6'), 'claude-sonnet-4-6');
  assert.equal(
    nextFreeComparisonVariant([{ variant: 'codex-gpt-5-5' }], 'claude', 'sonnet-4.6'),
    'claude-sonnet-4-6',
  );
});

test('nextFreeComparisonVariant skips taken variants with -v2/-v3 suffix', () => {
  assert.equal(
    nextFreeComparisonVariant([{ variant: 'claude-sonnet-4-6' }], 'claude', 'sonnet-4.6'),
    'claude-sonnet-4-6-v2',
  );
  assert.equal(
    nextFreeComparisonVariant(
      [{ variant: 'claude-sonnet-4-6' }, { variant: 'claude-sonnet-4-6-v2' }],
      'claude',
      'sonnet-4.6',
    ),
    'claude-sonnet-4-6-v3',
  );
  assert.equal(
    nextFreeComparisonVariant(
      [
        { variant: 'claude-sonnet-4-6' },
        { variant: 'claude-sonnet-4-6-v2' },
        { variant: 'claude-sonnet-4-6-v3' },
      ],
      'claude',
      'sonnet-4.6',
    ),
    'claude-sonnet-4-6-v4',
  );
});

test('nextFreeComparisonVariant ignores null/empty variants in family', () => {
  assert.equal(
    nextFreeComparisonVariant(
      [{ variant: null }, { variant: undefined }, { variant: '' }],
      'claude',
      'sonnet-4.6',
    ),
    'claude-sonnet-4-6',
  );
});

test('nextFreeComparisonVariant returns empty when build returns empty', () => {
  assert.equal(nextFreeComparisonVariant([], '', 'sonnet'), '');
  assert.equal(nextFreeComparisonVariant([], 'claude', ''), '');
});

test('nextFreeComparisonVariant gap-fills holes in the suffix sequence', () => {
  assert.equal(
    nextFreeComparisonVariant(
      [{ variant: 'claude-sonnet-4-6' }, { variant: 'claude-sonnet-4-6-v3' }],
      'claude',
      'sonnet-4.6',
    ),
    'claude-sonnet-4-6-v2',
  );
});
