import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

// A node process without the test runner's loader is a real consumer of the build.
test('the built package loads and exports the cleanup script by path', () => {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `const node = require('@farmslot/adapter-node');
      if (typeof node.createNodeAdapter !== 'function') throw new Error('createNodeAdapter is not exported');
      if (typeof node.nodeDependencyBlock !== 'function') throw new Error('nodeDependencyBlock is not exported');
      if (typeof node.workspaceTsconfigEnv !== 'function') throw new Error('workspaceTsconfigEnv is not exported');
      const script = require.resolve('@farmslot/adapter-node/scripts/cleanup.sh');
      if (script !== node.NODE_CLEANUP_SCRIPT) throw new Error(script + ' != ' + node.NODE_CLEANUP_SCRIPT);`,
    ],
    { cwd: packageRoot, env, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
});
