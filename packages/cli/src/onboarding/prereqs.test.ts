import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseMinimumVersion,
  parseVersionOutput,
  requiredNodeRange,
  versionAtLeast,
} from './prereqs.js';

test('parseVersionOutput extracts semver from tool output', () => {
  assert.equal(parseVersionOutput('git version 2.39.5 (Apple Git-154)'), '2.39.5');
  assert.equal(parseVersionOutput('v22.15.0'), '22.15.0');
  assert.equal(parseVersionOutput('tmux 3.5a'), '3.5.0');
  assert.equal(parseVersionOutput('Python 3.13.1'), '3.13.1');
  assert.equal(parseVersionOutput('no digits here'), null);
});

test('parseMinimumVersion handles common engines ranges', () => {
  assert.deepEqual(parseMinimumVersion('>=22.12.0'), [22, 12, 0]);
  assert.deepEqual(parseMinimumVersion('^20'), [20, 0, 0]);
  assert.deepEqual(parseMinimumVersion('22.15.0'), [22, 15, 0]);
  assert.equal(parseMinimumVersion('latest'), null);
});

test('versionAtLeast compares triples', () => {
  assert.equal(versionAtLeast('22.15.0', [22, 12, 0]), true);
  assert.equal(versionAtLeast('22.12.0', [22, 12, 0]), true);
  assert.equal(versionAtLeast('22.11.9', [22, 12, 0]), false);
  assert.equal(versionAtLeast('23.0.0', [22, 12, 0]), true);
  assert.equal(versionAtLeast('21.99.99', [22, 12, 0]), false);
});

test('requiredNodeRange reads engines.node from the repo root package.json', () => {
  const range = requiredNodeRange();
  assert.ok(range, 'repo root package.json must declare engines.node');
  assert.ok(parseMinimumVersion(range!), `engines.node must parse: ${range}`);
});
