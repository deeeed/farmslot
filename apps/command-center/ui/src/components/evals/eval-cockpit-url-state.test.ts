import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodeEvalCockpitUrlState,
  encodeEvalCockpitUrlState,
  evalCockpitUrlStateFromHash,
  evalCockpitUrlStateHash,
} from './eval-cockpit-url-state.js';

test('eval cockpit URL state encodes and decodes filter state', () => {
  const state = {
    q: 'race condition',
    kind: 'merged-pr' as const,
    profile: 'fix-bug' as const,
    sort: 'date' as const,
    dir: 'desc' as const,
    picker: true,
  };

  const encoded = encodeEvalCockpitUrlState(state);

  assert.deepEqual(decodeEvalCockpitUrlState(encoded), state);
});

test('eval cockpit hash preserves unrelated params while writing state', () => {
  const next = evalCockpitUrlStateHash(
    { q: 'needle', kind: 'all', profile: 'all', sort: 'title', dir: 'asc' },
    '#evals?projects=web&machines=m1&state=old',
  );

  assert.ok(next);
  assert.match(next.hash, /^#evals\?/);
  const parsed = evalCockpitUrlStateFromHash(next.hash);
  assert.deepEqual(parsed?.state, {
    q: 'needle',
    kind: 'all',
    profile: 'all',
    sort: 'title',
    dir: 'asc',
  });
  assert.equal(new URLSearchParams(next.hash.split('?')[1]).get('projects'), 'web');
  assert.equal(new URLSearchParams(next.hash.split('?')[1]).get('machines'), 'm1');
});

test('eval cockpit URL state ignores invalid state and non-eval routes', () => {
  assert.equal(decodeEvalCockpitUrlState('not-valid-base64!'), null);
  assert.deepEqual(evalCockpitUrlStateFromHash('#evals?state=not-valid-base64!'), {
    encoded: 'not-valid-base64!',
    state: null,
  });
  assert.equal(evalCockpitUrlStateHash({ q: 'ignored' }, '#fleet?state=old'), null);
  assert.equal(evalCockpitUrlStateFromHash('#fleet?state=old'), null);
});
