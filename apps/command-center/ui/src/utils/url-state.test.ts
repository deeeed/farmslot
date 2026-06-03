import assert from 'node:assert/strict';
import test from 'node:test';

import { buildHash, getHashParam, hashRoute, hashSearch, parseHashRoute } from './url-state.js';

test('hash helpers parse route and query consistently', () => {
  const hash = '#slot/demo?file=src%2Findex.ts&resource=ios%20sim';

  assert.equal(hashRoute(hash), 'slot/demo');
  assert.equal(hashSearch(hash), 'file=src%2Findex.ts&resource=ios%20sim');
  assert.equal(getHashParam('file', hash), 'src/index.ts');
  assert.equal(getHashParam('resource', hash), 'ios sim');
});

test('parseHashRoute returns an isolated URLSearchParams object', () => {
  const parsed = parseHashRoute('#runs?family=abc');

  parsed.params.set('run', 'def');

  assert.equal(parsed.route, 'runs');
  assert.equal(buildHash(parsed.route, parsed.params), '#runs?family=abc&run=def');
});
