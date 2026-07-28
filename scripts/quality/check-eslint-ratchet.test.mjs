import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { buildEslintArgs, eslintCacheFingerprint } from './eslint-cache.mjs';

const requireFromCommandCenter = createRequire(
  new URL('../../apps/command-center/package.json', import.meta.url),
);
const eslintPackagePath = requireFromCommandCenter.resolve('eslint/package.json');
const eslintBin = join(dirname(eslintPackagePath), 'bin/eslint.js');

test('ESLint cache arguments use an explicit content-strategy cache and preserve --fix', () => {
  assert.deepEqual(
    buildEslintArgs({
      cacheLocation: '/repo/.cache/eslint/ratchet.cache',
      fix: true,
    }),
    [
      '.',
      '--format',
      'json',
      '--cache',
      '--cache-location',
      '/repo/.cache/eslint/ratchet.cache',
      '--cache-strategy',
      'content',
      '--fix',
    ],
  );
});

test('ESLint cache fingerprint changes with config, lockfile, or tool version', () => {
  const base = {
    eslintVersion: '10.0.0',
    runtimeVersion: 'v22.0.0',
    configContent: 'config-a',
    lockfileContent: 'lock-a',
  };
  const fingerprint = eslintCacheFingerprint(base);

  assert.notEqual(fingerprint, eslintCacheFingerprint({ ...base, eslintVersion: '10.0.1' }));
  assert.notEqual(fingerprint, eslintCacheFingerprint({ ...base, runtimeVersion: 'v24.0.0' }));
  assert.notEqual(fingerprint, eslintCacheFingerprint({ ...base, configContent: 'config-b' }));
  assert.notEqual(fingerprint, eslintCacheFingerprint({ ...base, lockfileContent: 'lock-b' }));
});

test('cached violations remain visible and a cached --fix run still edits the file', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'farmslot-eslint-cache-'));
  const cacheLocation = join(fixture, '.eslintcache');
  const sourcePath = join(fixture, 'input.js');
  writeFileSync(
    join(fixture, 'eslint.config.mjs'),
    `export default [{ rules: { "no-unused-vars": "error", semi: ["error", "always"] } }];\n`,
  );
  writeFileSync(sourcePath, 'const unused = 1\n');

  const first = runFixtureEslint(fixture, cacheLocation, false);
  assert.equal(first.status, 1);
  assert.deepEqual(messageRules(first.stdout), ['no-unused-vars', 'semi']);
  assert.equal(existsSync(cacheLocation), true);

  const fixed = runFixtureEslint(fixture, cacheLocation, true);
  assert.equal(fixed.status, 1);
  assert.equal(readFileSync(sourcePath, 'utf8'), 'const unused = 1;\n');
  assert.deepEqual(messageRules(fixed.stdout), ['no-unused-vars']);

  const cached = runFixtureEslint(fixture, cacheLocation, false);
  assert.equal(cached.status, 1);
  assert.deepEqual(messageRules(cached.stdout), ['no-unused-vars']);
});

function runFixtureEslint(cwd, cacheLocation, fix) {
  return spawnSync(process.execPath, [eslintBin, ...buildEslintArgs({ cacheLocation, fix })], {
    cwd,
    encoding: 'utf8',
  });
}

function messageRules(stdout) {
  const results = JSON.parse(stdout);
  return results.flatMap((result) => result.messages.map((message) => message.ruleId)).sort();
}
