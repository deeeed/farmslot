import assert from 'node:assert/strict';
import test from 'node:test';

import type { PRStatus } from '@farmslot/protocol';

import { resetPRListCacheForTests } from './list-cache.js';
import { prEntityVersion, prPrKey } from './pr-entity-keys.js';
import { prEntityProvider } from './pr-entity-sync.js';

// Minimal valid PRStatus fixture.
function makePR(pr: number, repo = 'org/repo'): PRStatus {
  return {
    pr,
    repo,
    title: `PR ${pr}`,
    summary: null,
    project: 'example',
    slot: null,
    session: null,
    checks: [],
    checkSummary: { passed: 0, failed: 0, pending: 0, skipped: 0, total: 0 },
    allPassed: false,
    anyFailed: false,
    failedNames: [],
    botComments: [],
    actionableBotComments: [],
    prState: 'OPEN',
    merged: false,
    mergeable: 'MERGEABLE',
    mergeConflict: false,
    reviewDecision: 'REVIEW_REQUIRED',
    recommendation: 'WORKING',
    headRef: null,
  };
}

test('prPrKey formats repo/pr correctly', () => {
  const pr = makePR(42, 'acme/widget');
  assert.equal(prPrKey(pr), 'acme/widget/42');
});

test('prEntityVersion is 16 hex chars', () => {
  const pr = makePR(1);
  const v = prEntityVersion(pr);
  assert.match(v, /^[0-9a-f]{16}$/, 'version must be 16 lowercase hex chars');
});

test('prEntityVersion is stable for same content', () => {
  const pr = makePR(10);
  assert.equal(prEntityVersion(pr), prEntityVersion({ ...pr }));
});

test('prEntityVersion differs for different PR number', () => {
  assert.notEqual(prEntityVersion(makePR(1)), prEntityVersion(makePR(2)));
});

test('prEntityProvider returns undefined for collection key (no prKey)', () => {
  const provider = prEntityProvider();
  const result = provider({
    family: 'upstream',
    integration: 'github',
    queryId: 'some-query-id',
  });
  assert.equal(result, undefined);
});

test('prEntityProvider returns undefined when no snapshot loaded', () => {
  resetPRListCacheForTests();
  const provider = prEntityProvider();
  const result = provider({
    family: 'upstream',
    integration: 'github',
    queryId: 'nonexistent-query',
    prKey: 'org/repo/1',
  });
  assert.equal(result, undefined);
});

test('prEntityProvider returns undefined for non-upstream family', () => {
  const provider = prEntityProvider();
  const result = provider({ family: 'slot', slotId: 'x' });
  assert.equal(result, undefined);
});
