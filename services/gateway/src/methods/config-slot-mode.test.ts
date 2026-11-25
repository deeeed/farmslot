// The slot and pool editors sync a slot's status row from the slot as written: `enabled: false`
// disables it whatever its mode says, so a follow-up dispatch can't claim a held slot before the
// next fleet refresh. The fleet pool snapshot reports the same effective mode.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

const root = await mkdtemp(path.join(os.tmpdir(), 'config-slot-mode-'));
for (const directory of ['pool', 'projects/proof', 'scripts', 'services/gateway', 'runs', 'home'])
  await mkdir(path.join(root, directory), { recursive: true });
Object.assign(process.env, {
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_ROOT: root,
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
});
after(() => rm(root, { recursive: true, force: true }));
await writeFile(path.join(root, 'CLAUDE.md'), '# Isolated slot-mode config fixture\n');
await writeFile(path.join(root, 'scripts/dev.sh'), 'exit 1\n');
await writeFile(path.join(root, 'services/gateway/package.json'), '{}');
await writeFile(
  path.join(root, 'projects/proof/project.json'),
  JSON.stringify({ name: 'proof', default_branch: 'main' }),
);

const poolFile = path.join(root, 'pool/node.json');
const missingRepo = `/Volumes/farmslot-missing-slot-mode-${process.pid}/repo`;
const pool = (slots: Array<Record<string, unknown>>) =>
  JSON.stringify(
    { machine: 'node', host: 'node.invalid', platform: 'cli', project: 'proof', slots },
    null,
    2,
  );
const row = (slot: string, lifecycle: string, enabled: boolean, machine = 'node') => ({
  slot,
  machine,
  platform: 'cli',
  project: 'proof',
  enabled,
  ssh: 'OK',
  lifecycle,
  agent: 'idle',
  dispatchable: lifecycle === 'ready',
});

const { configPoolUpdate, configSlotUpdate } = await import('./config.js');
const { loadFleetStatus, loadPoolConfigs } = await import('../fleet/state.js');

beforeEach(async () => {
  await writeFile(
    poolFile,
    pool([
      { id: 'open', repo: '/repos/open', session: 'open', mode: 'dispatch', enabled: true },
      { id: 'held', repo: '/repos/held', session: 'held', mode: 'dispatch', enabled: false },
      { id: 'off', repo: '/repos/off', session: 'off', mode: 'disabled', enabled: false },
    ]),
  );
  // A local slot whose volume is missing: the storage overlay reports it disabled whatever its row says.
  await writeFile(
    path.join(root, 'pool/local.json'),
    JSON.stringify({
      machine: os.hostname(),
      host: 'localhost',
      platform: 'cli',
      project: 'proof',
      slots: [{ id: 'unmounted', repo: missingRepo, session: 'unmounted', mode: 'dispatch' }],
    }),
  );
  await writeFile(
    path.join(root, 'status.json'),
    JSON.stringify({
      checked_at: new Date().toISOString(),
      slots: [
        row('open', 'ready', true),
        row('held', 'disabled', false),
        row('off', 'disabled', false),
        row('unmounted', 'held', true, os.hostname()),
      ],
    }),
  );
  await loadFleetStatus(true);
});

async function statusOf(slot: string) {
  const found = (await loadFleetStatus(true)).slots.find((candidate) => candidate.slot === slot);
  assert.ok(found, `${slot} has a status row`);
  return { lifecycle: found.lifecycle, enabled: found.enabled, dispatchable: found.dispatchable };
}

async function rawLifecycle(slot: string) {
  const status = JSON.parse(await readFile(path.join(root, 'status.json'), 'utf8')) as {
    slots: Array<{ slot: string; lifecycle: string }>;
  };
  return status.slots.find((candidate) => candidate.slot === slot)?.lifecycle;
}

const disabled = { lifecycle: 'disabled', enabled: false, dispatchable: false };

test('disabling a dispatch slot by its flag disables its status row at once', async () => {
  await configSlotUpdate({ slotId: 'open', update: { enabled: false } });
  assert.deepEqual(await statusOf('open'), disabled);
});

test('setting a mode on a held slot keeps its status row disabled', async () => {
  await configSlotUpdate({ slotId: 'held', update: { mode: 'dispatch' } });
  assert.deepEqual(await statusOf('held'), disabled);
  await configSlotUpdate({ slotId: 'held', update: { mode: 'custom' } });
  assert.deepEqual(await statusOf('held'), disabled);
});

test('enabling a slot whose mode is disabled keeps it disabled', async () => {
  await configSlotUpdate({ slotId: 'off', update: { enabled: true } });
  assert.deepEqual(await statusOf('off'), disabled);
});

test('re-enabling a held slot makes its status row ready', async () => {
  await configSlotUpdate({ slotId: 'held', update: { enabled: true } });
  const { lifecycle, enabled } = await statusOf('held');
  assert.deepEqual({ lifecycle, enabled }, { lifecycle: 'ready', enabled: true });
});

test('a pool edit that holds a slot with mode dispatch disables its status row', async () => {
  const edited = JSON.parse(await readFile(poolFile, 'utf8'));
  edited.slots[0].enabled = false;
  await configPoolUpdate({ machine: 'node', content: JSON.stringify(edited, null, 2) });
  assert.deepEqual(await statusOf('open'), disabled);
});

test('the fleet pool snapshot reports a held slot as disabled', async () => {
  const snapshot = (await loadPoolConfigs()).find((candidate) => candidate.machine === 'node');
  assert.ok(snapshot);
  const modes = Object.fromEntries(snapshot.slots.map((slot) => [slot.id, slot.mode]));
  assert.deepEqual(modes, { open: 'dispatch', held: 'disabled', off: 'disabled' });
});

test(
  'an enabled-only update keeps the raw lifecycle of a slot whose storage is unavailable',
  { skip: process.platform !== 'darwin' },
  async () => {
    assert.equal((await statusOf('unmounted')).lifecycle, 'disabled', 'the overlay hides the row');
    await configSlotUpdate({ slotId: 'unmounted', update: { enabled: true } });
    assert.equal(await rawLifecycle('unmounted'), 'held', 'the held row is not turned ready');
  },
);

test(
  'a pool edit keeps the raw lifecycle of a slot whose storage is unavailable',
  { skip: process.platform !== 'darwin' },
  async () => {
    const localPool = path.join(root, 'pool/local.json');
    const edited = JSON.parse(await readFile(localPool, 'utf8'));
    edited.slots[0].codex_note = 'unrelated edit';
    await configPoolUpdate({ machine: edited.machine, content: JSON.stringify(edited, null, 2) });
    assert.equal(await rawLifecycle('unmounted'), 'held', 'the held row is not turned ready');
  },
);
