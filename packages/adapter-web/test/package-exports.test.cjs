'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const { pathToFileURL } = require('node:url');

const packageRoot = path.resolve(__dirname, '..');
const checker = path.resolve(packageRoot, '../../scripts/quality/check-cjs-esm-exports.mjs');

describe('package exports', () => {
  it('ships web-dapp as ESM with matching declarations, and every leaf script resolves', async () => {
    const manifest = require('../package.json');
    const entry = manifest.exports['./web-dapp'];
    assert.match(entry.default, /\.mjs$/u);
    assert.match(entry.types, /\.d\.mts$/u);
    assert.ok(manifest.files.includes('src/**/*.mjs'));
    assert.ok(manifest.files.includes('dist/**/*.d.mts'));
    const loaded = await import(pathToFileURL(path.resolve(packageRoot, entry.default)).href);
    assert.equal(typeof loaded.createWebDappAdapter, 'function');
    for (const leaf of ['launch', 'wallet-host', 'inject', 'verify', 'stop', 'cleanup']) {
      assert.ok(fs.existsSync(loaded.webDappLeafPath(leaf)), leaf);
    }
  });

  it('give ESM importers every name require() returns, for every library subpath', () => {
    const result = spawnSync(process.execPath, [checker, packageRoot], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });
});
