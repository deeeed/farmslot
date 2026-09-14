import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const root = mkdtempSync(path.join(tmpdir(), 'farmslot-config-roots-'));
for (const dir of [
  'scripts',
  'services/gateway',
  'pool',
  'projects/decoy',
  'selected-pool',
  'selected-projects/chosen',
])
  mkdirSync(path.join(root, dir), { recursive: true });
writeFileSync(path.join(root, 'CLAUDE.md'), '# Test root\n');
writeFileSync(path.join(root, 'scripts/dev.sh'), '#!/bin/sh\n');
writeFileSync(path.join(root, 'services/gateway/package.json'), '{}');
for (const [directory, id] of [
  ['pool', 'decoy'],
  ['selected-pool', 'chosen'],
])
  writeFileSync(
    path.join(root, directory, 'fixture.json'),
    JSON.stringify({
      schema_version: 2,
      machine: 'fixture',
      project: id,
      platform: 'cli',
      os: 'darwin',
      host: 'localhost',
      slots: [{ id, enabled: true, repo: root }],
    }),
  );
writeFileSync(
  path.join(root, 'projects/decoy/project.json'),
  JSON.stringify({ name: 'decoy', platform: 'cli' }),
);
writeFileSync(
  path.join(root, 'selected-projects/chosen/project.json'),
  JSON.stringify({ name: 'chosen', platform: 'cli' }),
);
process.env.FARMSLOT_ROOT = root;
process.env.FARMSLOT_POOL_DIR = path.join(root, 'selected-pool');
process.env.FARMSLOT_PROJECTS_DIR = path.join(root, 'selected-projects');

const { loadPoolConfigs, loadProjectConfigs } = await import('./state.js');
const { resolveSlot } = await import('../core/config.js');
after(() => rmSync(root, { recursive: true, force: true }));

test('fleet discovery and dispatch resolve the same configured pool and projects', async () => {
  const pools = await loadPoolConfigs();
  assert.deepEqual(
    pools.flatMap((pool) => pool.slots.map((slot) => slot.id)),
    ['chosen'],
  );
  assert.equal((await resolveSlot('chosen')).slot.id, 'chosen');
  assert.deepEqual(
    (await loadProjectConfigs()).map((project) => project.name),
    ['chosen'],
  );
});
