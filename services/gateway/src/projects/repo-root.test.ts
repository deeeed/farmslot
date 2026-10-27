import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { poolDir, projectsDir } from '../core/config.js';
import { statusFile } from '../fleet/state.js';

import { farmslotRoot, resolveFarmslotRoot, resolveStatusFilePath } from './repo-root.js';

const expectedRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

assert.equal(resolveFarmslotRoot(path.join(expectedRoot, 'services/gateway/src')), expectedRoot);
assert.equal(farmslotRoot, expectedRoot);
assert.equal(poolDir, path.join(expectedRoot, 'pool'));
assert.equal(projectsDir, path.join(expectedRoot, 'projects'));
assert.equal(
  statusFile,
  resolveStatusFilePath(expectedRoot),
);
assert.equal(
  resolveStatusFilePath(expectedRoot, {}, ['node', 'src/index.ts']),
  path.join(expectedRoot, '.farm-status.json'),
);
assert.throws(
  () =>
    resolveStatusFilePath(expectedRoot, {
      FARMSLOT_TEST_STATUS_FILE: '/tmp/forbidden-test-status.json',
    }),
  /restricted to NODE_TEST_CONTEXT=1/,
);
assert.equal(existsSync(poolDir), true, 'pool dir should resolve under repo root');
assert.equal(
  existsSync(path.join(farmslotRoot, 'scripts/dev.sh')),
  true,
  'scripts should resolve under repo root',
);

for (const [label, env, argv] of [
  ['node --test', { NODE_TEST_CONTEXT: 'child-v8' }, ['node', 'fixture.ts']],
  ['direct tsx', {}, ['node', 'tsx', 'blocked-worker-resume.test.ts']],
] as const) {
  test(`${label} status writes preserve the live review lease`, (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'fleet-status-isolation-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const live = path.join(root, '.farm-status.json');
    const prior = JSON.stringify({
      slots: [{ slot: 'owned-review', current_run_id: 'review-run', slot_epoch: 76 }],
    });
    writeFileSync(live, prior);
    const target = resolveStatusFilePath(root, env, argv);
    writeFileSync(target, JSON.stringify({ slots: [{ slot: 'slot-terminal-overlap' }] }));
    assert.equal(readFileSync(live, 'utf8'), prior);
    assert.notEqual(target, live);
  });
}
