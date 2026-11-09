import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { farmslotRoot, poolDirectory, projectsDirectory } from './config.js';

test('public root functions follow two selected homes and retain legacy values', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'farm-root-functions-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const keys = ['FARMSLOT_HOME', 'FARMSLOT_POOL_DIR', 'FARMSLOT_PROJECTS_DIR'] as const;
  const previous = keys.map((key) => [key, process.env[key]] as const);
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const legacyRoot = farmslotRoot();
  process.env.FARMSLOT_POOL_DIR = path.join(root, 'legacy-pool');
  process.env.FARMSLOT_PROJECTS_DIR = path.join(root, 'legacy-projects');
  process.env.FARMSLOT_HOME = path.join(root, 'legacy-home');
  assert.equal(farmslotRoot(), legacyRoot);
  assert.equal(poolDirectory(), process.env.FARMSLOT_POOL_DIR);
  assert.equal(projectsDirectory(), process.env.FARMSLOT_PROJECTS_DIR);
  for (const name of ['a', 'b', 'a']) {
    const home = path.join(root, name);
    mkdirSync(path.join(home, 'config'), { recursive: true });
    writeFileSync(path.join(home, 'config/instance.json'), '{"layout":2}');
    process.env.FARMSLOT_HOME = home;
    assert.equal(farmslotRoot(), path.join(home, 'code/node'));
    assert.equal(poolDirectory(), path.join(home, 'pool'));
    assert.equal(projectsDirectory(), path.join(home, 'projects'));
  }
});
