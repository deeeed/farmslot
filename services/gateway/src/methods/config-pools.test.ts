import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// An isolated root, so config.pools reads only this fixture's pool.
const root = mkdtempSync(path.join(tmpdir(), 'farmslot-config-pools-'));
for (const dir of ['scripts', 'services/gateway', 'pool', 'projects'])
  mkdirSync(path.join(root, dir), { recursive: true });
writeFileSync(path.join(root, 'CLAUDE.md'), '# Test root\n');
writeFileSync(path.join(root, 'scripts/dev.sh'), '#!/bin/sh\n');
writeFileSync(path.join(root, 'services/gateway/package.json'), '{}');
writeFileSync(
  path.join(root, 'pool/fixture.json'),
  JSON.stringify({
    schema_version: 2,
    machine: 'fixture',
    project: 'audiolab-farm',
    platform: 'ios',
    os: 'darwin',
    host: 'localhost',
    slots: [
      { id: 'sherpa-slot', enabled: true, repo: root, session: 's1', app: 'apps/sherpa-voice' },
      { id: 'unbound-slot', enabled: true, repo: root, session: 's2' },
    ],
  }),
);
process.env.FARMSLOT_ROOT = root;
process.env.FARMSLOT_POOL_DIR = path.join(root, 'pool');
process.env.FARMSLOT_PROJECTS_DIR = path.join(root, 'projects');

const { configPools } = await import('./config.js');
after(() => rmSync(root, { recursive: true, force: true }));

test('config.pools carries each slot own app for the dispatch wizard', async () => {
  const { pools } = await configPools();
  assert.deepEqual(
    pools.flatMap((pool) => pool.slots.map((slot) => [slot.id, slot.app])),
    [
      ['sherpa-slot', 'apps/sherpa-voice'],
      ['unbound-slot', undefined],
    ],
  );
  assert.equal('app' in pools[0]!.slots[1]!, false, 'a slot without an app gets no key');
});
