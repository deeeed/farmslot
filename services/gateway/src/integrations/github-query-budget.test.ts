import assert from 'node:assert/strict';
import test from 'node:test';

import { GitHubQueryBudget } from './github-query-budget.js';

test('exhausted query budgets pause one credential until reset without blocking another', () => {
  const budget = new GitHubQueryBudget();
  const now = Date.parse('2026-09-09T12:00:00.000Z');
  budget.observe('account-a', { remaining: 20, cost: 21, resetAt: '2026-09-09T13:00:00.000Z' });
  assert.throws(() => budget.assertAvailable('account-a', now), /13:00:00/);
  budget.observe('account-a', { remaining: 300, cost: 21, resetAt: '2026-09-09T13:00:00.000Z' });
  assert.throws(() => budget.assertAvailable('account-a', now), /13:00:00/);
  assert.doesNotThrow(() => budget.assertAvailable('account-b', now));
  assert.doesNotThrow(() => budget.assertAvailable('account-a', now + 3_600_001));
  budget.observe('account-a', { remaining: 4900, cost: 21, resetAt: '2026-09-09T14:00:00.000Z' });
  assert.doesNotThrow(() => budget.assertAvailable('account-a', now + 3_600_001));
});

test('HTTP GraphQL quota headers fence subsequent reads even when the response has no data', () => {
  const budget = new GitHubQueryBudget();
  const now = Date.parse('2026-09-09T12:00:00.000Z');
  budget.observeHeaders(
    'account',
    new Map([
      ['x-ratelimit-resource', 'graphql'],
      ['x-ratelimit-remaining', '0'],
      ['x-ratelimit-reset', String((now + 60_000) / 1000)],
    ]),
  );
  assert.throws(() => budget.assertAvailable('account', now), /12:01:00/);
  budget.observe('account', { remaining: 4000, cost: 1, resetAt: '2026-09-09T12:01:00Z' });
  assert.throws(
    () => budget.assertAvailable('account', now),
    /12:01:00/,
    'Equivalent timestamp formats cannot reopen an exhausted window',
  );
  assert.doesNotThrow(() => budget.assertAvailable('account', now + 60_001));
  budget.observeHeaders(
    'other',
    new Map([
      ['x-ratelimit-resource', 'core'],
      ['x-ratelimit-remaining', '0'],
      ['x-ratelimit-reset', String((now + 60_000) / 1000)],
    ]),
  );
  assert.doesNotThrow(() => budget.assertAvailable('other', now));
  assert.doesNotThrow(() =>
    budget.observeHeaders('other', new Map([['x-ratelimit-resource', 'graphql']])),
  );
});
