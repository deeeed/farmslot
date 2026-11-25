// `enabled: false` always disables a slot, whatever `mode` says; otherwise mode, then dispatch.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { effectiveSlotMode, invalidateProjectVarsCache, loadSlotVars } from './config.js';

test('effectiveSlotMode: enabled false wins over every mode', () => {
  for (const mode of ['dispatch', 'custom', 'disabled', undefined] as const)
    assert.equal(effectiveSlotMode({ mode, enabled: false }), 'disabled', `mode ${mode}`);
});

test('effectiveSlotMode: otherwise the mode, then dispatch', () => {
  for (const enabled of [true, undefined]) {
    assert.equal(effectiveSlotMode({ mode: 'dispatch', enabled }), 'dispatch');
    assert.equal(effectiveSlotMode({ mode: 'custom', enabled }), 'custom');
    assert.equal(effectiveSlotMode({ mode: 'disabled', enabled }), 'disabled');
    assert.equal(effectiveSlotMode({ enabled }), 'dispatch');
  }
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

test('slot vars of a held custom slot and of a disabled-mode slot are disabled', async (t) => {
  for (const slot of [{ mode: 'custom', enabled: false }, { mode: 'disabled', enabled: true }]) {
    invalidateProjectVarsCache();
    pool(t, slot);
    const vars = await loadSlotVars('a');
    assert.equal(vars.slotMode, 'disabled', JSON.stringify(slot));
    assert.equal(vars.slotEnabled, false, JSON.stringify(slot));
  }
});

test('slot vars keep an explicit mode on an enabled slot', async (t) => {
  pool(t, { mode: 'custom' });
  const vars = await loadSlotVars('a');
  assert.equal(vars.slotMode, 'custom');
  assert.equal(vars.slotEnabled, true);
});
