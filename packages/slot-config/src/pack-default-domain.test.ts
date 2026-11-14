// A pack's `default_domain` is the last fallback for the task domain: run (or task)
// domain, then slot, then pool, then pack. Without it, packs whose work is one
// domain (the MetaMask perps farms) froze `domain: ''` for every run.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { invalidateProjectVarsCache, loadProjectVars, loadSlotVars } from './config.js';

function farm(
  t: test.TestContext,
  { pool = {}, slot = {}, project }: { pool?: object; slot?: object; project?: object },
): void {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'slot-config-default-domain-')));
  const pools = path.join(root, 'pool');
  const projects = path.join(root, 'projects');
  mkdirSync(pools);
  mkdirSync(projects);
  const previous = {
    pool: process.env.FARMSLOT_POOL_DIR,
    projects: process.env.FARMSLOT_PROJECTS_DIR,
  };
  process.env.FARMSLOT_POOL_DIR = pools;
  process.env.FARMSLOT_PROJECTS_DIR = projects;
  invalidateProjectVarsCache();
  t.after(() => {
    for (const [key, value] of [
      ['FARMSLOT_POOL_DIR', previous.pool],
      ['FARMSLOT_PROJECTS_DIR', previous.projects],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    invalidateProjectVarsCache();
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(
    path.join(pools, 'm.json'),
    JSON.stringify({
      machine: 'm',
      host: 'localhost',
      ssh_user: 'u',
      platform: 'cli',
      project: 'pack',
      ...pool,
      slots: [{ id: 'a', repo: '/tmp/a', session: 'a', ...slot }],
    }),
  );
  if (project) {
    mkdirSync(path.join(projects, 'pack'));
    writeFileSync(
      path.join(projects, 'pack', 'project.json'),
      JSON.stringify({ name: 'pack', task_dir: 'temp/tasks', ...project }),
    );
  }
}

test('the pack default domain applies when neither the slot nor the pool names one', async (t) => {
  farm(t, { project: { default_domain: 'perps' } });
  assert.equal((await loadSlotVars('a')).domain, 'perps');
});

test('a slot or pool domain still wins over the pack default', async (t) => {
  farm(t, { pool: { domain: 'pool-domain' }, project: { default_domain: 'perps' } });
  assert.equal((await loadSlotVars('a')).domain, 'pool-domain');
});

test('a slot domain wins over both the pool and the pack', async (t) => {
  farm(t, {
    pool: { domain: 'pool-domain' },
    slot: { domain: 'slot-domain' },
    project: { default_domain: 'perps' },
  });
  assert.equal((await loadSlotVars('a')).domain, 'slot-domain');
});

test('no pack default and no project config leave the domain unset', async (t) => {
  farm(t, { project: {} });
  assert.equal((await loadSlotVars('a')).domain, undefined);
  invalidateProjectVarsCache();
  farm(t, {});
  assert.equal((await loadSlotVars('a')).domain, undefined);
});

test('an invalid pack default domain is refused at load', async (t) => {
  farm(t, { project: { default_domain: 'Perps Team' } });
  await assert.rejects(loadProjectVars('pack'), /default_domain must be a domain name/);
});
