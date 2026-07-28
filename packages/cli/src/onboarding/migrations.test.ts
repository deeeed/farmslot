import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { applyMigrations, loadMigrations, pendingMigrations } from './migrations.js';
import type { PoolConfig } from './pool-config.js';

function pool(schemaVersion?: number): PoolConfig {
  const p: PoolConfig = {
    machine: 'm',
    host: 'localhost',
    ssh_user: 'u',
    notes: 'user edit must survive',
    slots: [{ id: 'm-app-1', repo: '/r', session: 'app-1' }],
  };
  if (schemaVersion !== undefined) p.schema_version = schemaVersion;
  return p;
}

test('loadMigrations loads the repo pool migrations in order', async () => {
  const steps = await loadMigrations();
  assert.ok(steps.length >= 1, 'repo must ship at least migration 001');
  assert.equal(steps[0].id, '001-init-schema-version');
  for (let i = 1; i < steps.length; i++) {
    assert.ok(steps[i].toVersion > steps[i - 1].toVersion, 'toVersion must be strictly increasing');
  }
});

test('loadMigrations rejects malformed steps', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fs-mig-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '001-bad.mjs'), 'export const id = 1;');
  await assert.rejects(() => loadMigrations(dir), /must export id, toVersion, migrate/);
});

test('applyMigrations brings a version-0 pool to latest, preserving user edits', async () => {
  const steps = await loadMigrations();
  const latest = steps[steps.length - 1].toVersion;
  const { pool: migrated, applied } = applyMigrations(pool(), steps);
  assert.equal(migrated.schema_version, latest);
  assert.equal(applied.length, steps.length);
  assert.equal(migrated.notes, 'user edit must survive');
  assert.equal(migrated.slots[0].repo, '/r');
});

test('applyMigrations is a no-op at latest version', async () => {
  const steps = await loadMigrations();
  const latest = steps[steps.length - 1].toVersion;
  const current = pool(latest);
  assert.deepEqual(pendingMigrations(current, steps), []);
  const { applied } = applyMigrations(current, steps);
  assert.deepEqual(applied, []);
});

test('Metro migration allocates distinct ports and preserves explicit assignments', async () => {
  const steps = await loadMigrations();
  const legacy = pool(1);
  legacy.slots = [
    {
      id: 'm-app-1',
      repo: '/r1',
      session: 'app-1',
      resources: { 'dev-server': { port: 8808 } },
    },
    {
      id: 'm-app-2',
      repo: '/r2',
      session: 'app-2',
      resources: { 'dev-server': { port: 8809, metro_port: 8879 } },
    },
  ];

  const { pool: migrated } = applyMigrations(legacy, steps);
  assert.equal(migrated.slots[0].resources?.['dev-server'].port, 8808);
  assert.equal(migrated.slots[0].resources?.['dev-server'].metro_port, 9300);
  assert.equal(migrated.slots[1].resources?.['dev-server'].metro_port, 8879);
});

test('Metro invariant repair fixes malformed schema-v2 pools', async () => {
  const steps = await loadMigrations();
  const malformed = pool(2);
  malformed.slots[0].resources = {
    'dev-server': { port: 9300, metro_port: 70_000 },
  };

  const { pool: repaired, applied } = applyMigrations(malformed, steps);
  assert.equal(repaired.slots[0].resources?.['dev-server'].metro_port, 9301);
  assert.deepEqual(applied, ['002-add-metro-port-repair']);
});
