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

test('anyReserved is true when some other credential is already below the reserve', () => {
  const budget = new GitHubQueryBudget();
  const now = Date.parse('2026-09-17T12:00:00.000Z');
  budget.observe('account-hashed', {
    remaining: 0,
    cost: 1,
    resetAt: '2026-09-17T13:00:00.000Z',
  });
  assert.equal(budget.anyReserved(now), '2026-09-17T13:00:00.000Z');
  assert.equal(budget.nextEligibleAt('["ambient",[]]', now), undefined);
});

test('spend snapshot ignores remaining from a GraphQL window that already reset', () => {
  const budget = new GitHubQueryBudget();
  const now = Date.parse('2026-09-17T13:00:00.000Z');
  budget.observe('stale', { remaining: 0, cost: 1, resetAt: '2026-09-17T12:00:00.000Z' });
  budget.observe('live', { remaining: 4200, cost: 1, resetAt: '2026-09-17T14:00:00.000Z' });
  const snap = budget.spendSnapshot(now);
  assert.equal(snap.remaining, 4200);
  assert.equal(snap.resetAt, '2026-09-17T14:00:00.000Z');
});

test('resetForTests clears reserved credentials and spend', () => {
  const budget = new GitHubQueryBudget();
  const now = Date.parse('2026-09-17T12:00:00.000Z');
  budget.observe('account', { remaining: 0, cost: 1, resetAt: '2026-09-17T13:00:00.000Z' });
  budget.record('pr.list:prefetch', 12, 1, now);
  budget.resetForTests();
  assert.equal(budget.anyReserved(now), undefined);
  assert.equal(budget.spendSnapshot(now).hourCost, 0);
});

test('spend snapshot attributes GraphQL cost to callers inside a rolling hour', () => {
  const budget = new GitHubQueryBudget();
  const now = Date.parse('2026-09-17T12:00:00.000Z');
  budget.record('pr.list:prefetch', 12, 1, now);
  budget.record('pr.raw:threads', 0, 3, now + 1_000);
  budget.record('pr.list:prefetch', 8, 1, now + 2_000);
  budget.record('pr-monitor:observe', 4, 2, now - 3_600_001);
  const snap = budget.spendSnapshot(now + 3_000);
  assert.equal(snap.hourCost, 20);
  assert.equal(snap.hourQueries, 5);
  assert.deepEqual(
    snap.callers.map((row) => [row.caller, row.cost, row.queries]),
    [
      ['pr.list:prefetch', 20, 2],
      ['pr.raw:threads', 0, 3],
    ],
  );
});
