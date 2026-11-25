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
const pool = (slots: Array<Record<string, unknown>>) =>
  JSON.stringify(
    { machine: 'node', host: 'node.invalid', platform: 'cli', project: 'proof', slots },
    null,
    2,
  );
const row = (slot: string, lifecycle: string, enabled: boolean) => ({
  slot,
  machine: 'node',
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
  await writeFile(
    path.join(root, 'status.json'),
    JSON.stringify({
      checked_at: new Date().toISOString(),
      slots: [
        row('open', 'ready', true),
        row('held', 'disabled', false),
        row('off', 'disabled', false),
      ],
    }),
  );
  await loadFleetStatus(true);
});

async function statusOf(slot: string) {
  const found = (await loadFleetStatus(true)).slots.find((candidate) => candidate.slot === slot);
  assert.ok(found, `${slot} has a status row`);
  return { lifecycle: found.lifecycle, enabled: found.enabled };
}

test('disabling a dispatch slot by its flag disables its status row at once', async () => {
  await configSlotUpdate({ slotId: 'open', update: { enabled: false } });
  assert.deepEqual(await statusOf('open'), { lifecycle: 'disabled', enabled: false });
});

test('setting a mode on a held slot keeps its status row disabled', async () => {
  await configSlotUpdate({ slotId: 'held', update: { mode: 'dispatch' } });
  assert.deepEqual(await statusOf('held'), { lifecycle: 'disabled', enabled: false });
  await configSlotUpdate({ slotId: 'held', update: { mode: 'custom' } });
  assert.deepEqual(await statusOf('held'), { lifecycle: 'disabled', enabled: false });
});

test('enabling a slot whose mode is disabled keeps it disabled', async () => {
  await configSlotUpdate({ slotId: 'off', update: { enabled: true } });
  assert.deepEqual(await statusOf('off'), { lifecycle: 'disabled', enabled: false });
});

test('re-enabling a held slot makes its status row ready', async () => {
  await configSlotUpdate({ slotId: 'held', update: { enabled: true } });
  assert.deepEqual(await statusOf('held'), { lifecycle: 'ready', enabled: true });
});

test('a pool edit that holds a slot with mode dispatch disables its status row', async () => {
  const edited = JSON.parse(await readFile(poolFile, 'utf8'));
  edited.slots[0].enabled = false;
  await configPoolUpdate({ machine: 'node', content: JSON.stringify(edited, null, 2) });
  assert.deepEqual(await statusOf('open'), { lifecycle: 'disabled', enabled: false });
});

test('the fleet pool snapshot reports a held slot as disabled', async () => {
  const snapshot = (await loadPoolConfigs()).find((candidate) => candidate.machine === 'node');
  assert.ok(snapshot);
  const modes = Object.fromEntries(snapshot.slots.map((slot) => [slot.id, slot.mode]));
  assert.deepEqual(modes, { open: 'dispatch', held: 'disabled', off: 'disabled' });
});
