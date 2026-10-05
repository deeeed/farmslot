import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { NODE_CLEANUP_SCRIPT } from '../src/index.js';

function overlay(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-node-cleanup-')));
  for (const rel of [
    'temp/recipe/harness/core/runner/.runner-source',
    'temp/recipe/harness/web/keep.txt',
    'temp/recipe/runtime/core/state.json',
    'package.json',
  ]) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), '');
  }
  return root;
}

function cleanup(args: string[], env: NodeJS.ProcessEnv = {}) {
  const base = { ...process.env };
  delete base.RECIPE_HARNESS_ROOT;
  return spawnSync('bash', [NODE_CLEANUP_SCRIPT, ...args], {
    env: { ...base, ...env },
    encoding: 'utf8',
  });
}

test('removes the adapter overlay, keeps the rest, and is idempotent', () => {
  const root = overlay();
  for (let run = 0; run < 2; run += 1) {
    const result = cleanup(['--adapter', 'core', '--target', root]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `Cleaned core recipe harness from ${root}\n`);
    assert.equal(fs.existsSync(path.join(root, 'temp/recipe/harness/core')), false);
    for (const kept of [
      'temp/recipe/harness/web/keep.txt',
      'temp/recipe/runtime/core/state.json',
      'package.json',
    ]) {
      assert.ok(fs.existsSync(path.join(root, kept)), kept);
    }
  }
});

test('the target defaults to the working directory and RECIPE_HARNESS_ROOT moves the overlay', () => {
  const root = overlay();
  fs.mkdirSync(path.join(root, 'custom/overlays/core'), { recursive: true });
  const result = spawnSync('bash', [NODE_CLEANUP_SCRIPT, '--adapter', 'core'], {
    cwd: root,
    env: { ...process.env, RECIPE_HARNESS_ROOT: 'custom/overlays' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(root, 'custom/overlays/core')), false);
  assert.ok(fs.existsSync(path.join(root, 'temp/recipe/harness/core')));
});

test('refuses an unsafe RECIPE_HARNESS_ROOT without removing anything', () => {
  const root = overlay();
  for (const value of ['/tmp', '../outside', 'a/../b', 'a b']) {
    const result = cleanup(['--adapter', 'core', '--target', root], {
      RECIPE_HARNESS_ROOT: value,
    });
    assert.equal(result.status, 1, value);
    assert.match(result.stderr, /RECIPE_HARNESS_ROOT/u);
  }
  assert.ok(fs.existsSync(path.join(root, 'temp/recipe/harness/core')));
});

test('bad arguments exit 2', () => {
  const root = overlay();
  assert.equal(cleanup(['--target', root]).status, 2);
  assert.equal(cleanup(['--adapter', '..', '--target', root]).status, 2);
  assert.equal(cleanup(['--adapter', 'a/b', '--target', root]).status, 2);
  assert.equal(cleanup(['--adapter', 'core', '--bogus']).status, 2);
  for (const args of [['--adapter'], ['--adapter', 'core', '--target']]) {
    const result = cleanup(args);
    assert.equal(result.status, 2, args.join(' '));
    assert.match(result.stderr, /needs a value/u);
  }
  assert.ok(fs.existsSync(path.join(root, 'temp/recipe/harness/core')));
  assert.equal(cleanup(['--help']).status, 0);
});
