import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

// A node process without the test runner's loader is a real CommonJS consumer.
test('the package and the harness entries it loads require() from CommonJS', () => {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `const cli = require('@farmslot/recipe-cli');
      if (typeof cli.assessRecipe !== 'function') throw new Error('assessRecipe is not exported');
      require('@farmslot/recipe-harness');
      require('@farmslot/recipe-harness/cli');`,
    ],
    { cwd: packageRoot, env, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
});
