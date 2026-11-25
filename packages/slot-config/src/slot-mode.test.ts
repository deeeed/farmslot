// `enabled: false` always disables a slot, whatever `mode` says; otherwise mode, then dispatch.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { effectiveSlotMode, invalidateProjectVarsCache, loadSlotVars } from './config.js';

test('effectiveSlotMode: enabled false wins over every mode', () => {
  assert.equal(effectiveSlotMode({ mode: 'dispatch', enabled: false }), 'disabled');
  assert.equal(effectiveSlotMode({ mode: 'custom', enabled: false }), 'disabled');
  assert.equal(effectiveSlotMode({ enabled: false }), 'disabled');
  assert.equal(effectiveSlotMode({ mode: 'custom', enabled: true }), 'custom');
  assert.equal(effectiveSlotMode({ mode: 'custom' }), 'custom');
  assert.equal(effectiveSlotMode({ enabled: true }), 'dispatch');
  assert.equal(effectiveSlotMode({}), 'dispatch');
});

function pool(t: test.TestContext, slot: object): void {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'slot-config-slot-mode-')));
  const pools = path.join(root, 'pool');
  mkdirSync(pools);
  mkdirSync(path.join(root, 'projects'));
  const previous = {
    pool: process.env.FARMSLOT_POOL_DIR,
    projects: process.env.FARMSLOT_PROJECTS_DIR,
  };
  process.env.FARMSLOT_POOL_DIR = pools;
  process.env.FARMSLOT_PROJECTS_DIR = path.join(root, 'projects');
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
      slots: [{ id: 'a', repo: '/tmp/a', session: 'a', ...slot }],
    }),
  );
}

test('slot vars of a held slot written as mode dispatch, enabled false are disabled', async (t) => {
  pool(t, { mode: 'dispatch', enabled: false });
  const vars = await loadSlotVars('a');
  assert.equal(vars.slotMode, 'disabled');
  assert.equal(vars.slotEnabled, false);
});

test('slot vars keep an explicit mode on an enabled slot', async (t) => {
  pool(t, { mode: 'custom' });
  const vars = await loadSlotVars('a');
  assert.equal(vars.slotMode, 'custom');
  assert.equal(vars.slotEnabled, true);
});
