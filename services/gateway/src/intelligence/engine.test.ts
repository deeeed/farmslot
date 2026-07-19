import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSmartBranch, coerceStrategyToken, generateTaskContent } from './engine.js';

test('generateTaskContent expands supplied vars', async () => {
  assert.equal(
    await generateTaskContent('cd {{REPO}} && cat {{TASK_DIR}}/TASK.md', {
      REPO: '/tmp/r',
      TASK_DIR: '.task/t1',
    }),
    'cd /tmp/r && cat .task/t1/TASK.md',
  );
});

test('generateTaskContent fails hard on placeholders outside the var set', async () => {
  await assert.rejects(
    () =>
      generateTaskContent(
        'read {{ORIGINAL_TICKET}}',
        { TICKET: 'X-1' },
        'Worker template pr-complete.md',
      ),
    /Worker template pr-complete\.md.*\{\{ORIGINAL_TICKET\}\}/,
  );
});

test('buildSmartBranch appends variant suffix for comparison runs', () => {
  assert.equal(
    buildSmartBranch('fix-bug', 'PROJ-1234', 'payment-sheet-ordering', undefined, 'codex'),
    'fix/proj-1234-payment-sheet-ordering-codex',
  );
});

test('buildSmartBranch remains unchanged without variant', () => {
  assert.equal(
    buildSmartBranch('fix-bug', 'PROJ-1234', 'payment-sheet-ordering'),
    'fix/proj-1234-payment-sheet-ordering',
  );
});

test('buildSmartBranch preserves variant suffix under truncation for comparison runs', () => {
  const claude = buildSmartBranch(
    'fix-bug',
    'PROJ-1234',
    'this-is-an-extremely-long-branch-slug-that-would-otherwise-eat-the-suffix',
    undefined,
    'claude',
  );
  const codex = buildSmartBranch(
    'fix-bug',
    'PROJ-1234',
    'this-is-an-extremely-long-branch-slug-that-would-otherwise-eat-the-suffix',
    undefined,
    'codex',
  );
  assert.notEqual(claude, codex);
  assert.match(claude, /-claude$/);
  assert.match(codex, /-codex$/);
});

test('buildSmartBranch uses branch_format template when provided', () => {
  const fmt = '{{ticket}}-{{type}}-{{slug}}{{variant_suffix}}';
  assert.equal(
    buildSmartBranch('fix-bug', 'PROJ-3178', 'limit-price-decimals', undefined, undefined, fmt),
    'PROJ-3178-fix-limit-price-decimals',
  );
});

test('buildSmartBranch branch_format with variant', () => {
  const fmt = '{{ticket}}-{{type}}-{{slug}}{{variant_suffix}}';
  assert.equal(
    buildSmartBranch('fix-bug', 'PROJ-3178', 'limit-price-decimals', undefined, 'codex', fmt),
    'PROJ-3178-fix-limit-price-decimals-codex',
  );
});

test('buildSmartBranch branch_format without slug', () => {
  const fmt = '{{ticket}}-{{type}}-{{slug}}{{variant_suffix}}';
  assert.equal(
    buildSmartBranch('fix-bug', 'PROJ-3178', undefined, undefined, undefined, fmt),
    'PROJ-3178-fix',
  );
});

test('coerceStrategyToken returns valid tokens unchanged', () => {
  assert.equal(coerceStrategyToken('full-qa'), 'full-qa');
  assert.equal(coerceStrategyToken('smoke'), 'smoke');
  assert.equal(coerceStrategyToken('targeted'), 'targeted');
});

test('coerceStrategyToken falls back to full-qa for empty / non-string input', () => {
  assert.equal(coerceStrategyToken(undefined), 'full-qa');
  assert.equal(coerceStrategyToken(null), 'full-qa');
  assert.equal(coerceStrategyToken(''), 'full-qa');
  assert.equal(coerceStrategyToken(42 as unknown), 'full-qa');
});

test('coerceStrategyToken warns and falls back for unrecognised tokens', () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (msg: string) => warnings.push(msg);
  try {
    // Legacy tokens are rejected outright, not silently mapped — surfaces stale data.
    assert.equal(coerceStrategyToken('full-evidence'), 'full-qa');
    assert.equal(coerceStrategyToken('lifecycle-regression'), 'full-qa');
    assert.equal(coerceStrategyToken('hybrid'), 'full-qa');
    assert.equal(coerceStrategyToken('garbage'), 'full-qa');
    assert.equal(warnings.length, 4);
    for (const msg of warnings) {
      assert.match(msg, /unrecognised recipe-strategy token/);
    }
  } finally {
    console.warn = originalWarn;
  }
});
