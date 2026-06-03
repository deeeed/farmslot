import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { poolDir, projectsDir } from '../core/config.js';
import { statusFile } from '../fleet/state.js';

import { farmslotRoot, resolveFarmslotRoot } from './repo-root.js';

const expectedRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

assert.equal(resolveFarmslotRoot(path.join(expectedRoot, 'services/gateway/src')), expectedRoot);
assert.equal(farmslotRoot, expectedRoot);
assert.equal(poolDir, path.join(expectedRoot, 'pool'));
assert.equal(projectsDir, path.join(expectedRoot, 'projects'));
assert.equal(statusFile, path.join(expectedRoot, '.farm-status.json'));
assert.equal(existsSync(poolDir), true, 'pool dir should resolve under repo root');
assert.equal(
  existsSync(path.join(farmslotRoot, 'scripts/dev.sh')),
  true,
  'scripts should resolve under repo root',
);
