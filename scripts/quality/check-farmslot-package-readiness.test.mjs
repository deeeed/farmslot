import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(repoRoot, 'scripts/quality/check-farmslot-package-readiness.mjs');

function runStrictCheck(userAgent) {
  return spawnSync(
    process.execPath,
    [script, '--publish', '--packages', '@farmslot/recipe-harness'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        NPM_FARMSLOT_TOKEN: 'test-token',
        npm_config_user_agent: userAgent,
      },
    },
  );
}

test('strict publish rejects direct npm because it preserves workspace dependencies', () => {
  const result = runStrictCheck('npm/11.7.0 node/v24.0.0 darwin arm64');

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Direct npm publish preserves workspace:\* dependencies/);
  assert.match(result.stderr, /Use yarn npm publish/);
});

test('strict publish accepts the supported Yarn publisher', () => {
  const result = runStrictCheck('yarn/4.9.2 npm/? node/v24.0.0 darwin arm64');

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Farmslot package readiness passed \(strict publish mode\)/);
});
