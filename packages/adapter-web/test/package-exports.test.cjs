'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { describe, it } = require('node:test');

const packageRoot = path.resolve(__dirname, '..');
const checker = path.resolve(packageRoot, '../../scripts/quality/check-cjs-esm-exports.mjs');

describe('package exports', () => {
  it('give ESM importers every name require() returns, for every library subpath', () => {
    const result = spawnSync(process.execPath, [checker, packageRoot], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });
});
