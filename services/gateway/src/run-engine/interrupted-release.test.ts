import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { makeRun } from '../methods/run/test-fixtures.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'interrupted-release-'));
for (const dir of ['scripts', 'services/gateway', 'pool', 'projects', 'runs', 'home'])
  await mkdir(path.join(root, dir), { recursive: true });
await writeFile(path.join(root, 'CLAUDE.md'), '# Private release fixture\n');
await writeFile(path.join(root, 'scripts/dev.sh'), 'exit 1\n');
await writeFile(path.join(root, 'services/gateway/package.json'), '{}');
Object.assign(process.env, {
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_ROOT: root,
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
});
after(() => rm(root, { recursive: true, force: true }));
const state = await import('../core/state.js');
const { reconcileOrphanedSlots, STALE_RELEASE_RECLAIM_MS } = await import('./recovery.js');
type Deps = Parameters<typeof reconcileOrphanedSlots>[0];

test('expired release fence keeps a dirty eval checkout held until owner retry completes Git cleanup', async (t) => {
  const repo = path.join(root, 'repo');
  await mkdir(repo);
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-C',
        repo,
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        ...args,
      ],
      { encoding: 'utf8' },
    ).trim();
  git('init', '-q', '-b', 'main');
  for (const file of ['one.ts', 'two.ts', 'three.ts'])
    await writeFile(path.join(repo, file), 'base\n');
  git('add', '.');
  git('commit', '-qm', 'test: release fixture');
  git('checkout', '-qb', 'fix/eval-interrupted');
  for (const file of ['one.ts', 'two.ts', 'three.ts'])
    await writeFile(path.join(repo, file), 'retained work\n');
  const before = createHash('sha256')
    .update(git('diff', 'HEAD', '--binary'))
    .digest('hex');
  const now = Date.parse('2026-11-16T00:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  t.after(() => t.mock.timers.reset());
  const owner = makeRun({ id: 'cancelled-release', status: 'cancelled', slotId: 'fixture-slot' });
  await writeFile(
    state.statusFile,
    JSON.stringify({
      slots: [
        {
          slot: 'fixture-slot',
          lifecycle: 'busy',
          phase: 'releasing',
          slot_epoch: 4,
          current_run_id: owner.id,
          releasing_since: new Date(now - STALE_RELEASE_RECLAIM_MS - 1).toISOString(),
          release_gateway_instance: 'previous-gateway',
          branch: 'fix/eval-interrupted',
        },
      ],
    }),
  );
  const deps: Deps = {
    listRuns: () => ({ runs: [owner] }),
    loadFleetStatus: async () => ({
      slots: [
        {
          slot: 'fixture-slot',
          lifecycle: 'busy',
          phase: 'releasing',
          slotEpoch: 4,
          currentRunId: owner.id,
        },
      ],
    }),
    isTerminalTeardownInFlight: () => false,
    readSlotField: state.readSlotField,
    getRun: (id) => (id === owner.id ? owner : undefined),
    updateRun: (_id, fields) => {
      Object.assign(owner, fields);
    },
    resetSlot: state.resetSlot,
    resetSlotIf: state.resetSlotIf,
    updateSlotStatusIf: state.updateSlotStatusIf,
    broadcast: () => {},
    retryOccupiedRunSlot: async () => false,
    resumeInterruptedRecovery: () => {
      throw new Error('Ordinary release has no workspace recovery journal');
    },
    absentExecutionNode: async () => null,
  };
  await reconcileOrphanedSlots(deps);
  const row = await state.readSlotRow('fixture-slot');
  assert.ok(row);
  assert.equal(row.lifecycle, 'held', 'A clock cannot attest checkout cleanup');
  assert.equal(row.phase, 'occupied');
  assert.equal(row.current_run_id, owner.id, 'Retry retains its exact terminal owner');
  assert.equal(row.slot_epoch, 4);
  assert.equal(row.cleanup_stop_unconfirmed, true);
  assert.match(String(row.held_reason), /interrupted|retry/i);
  assert.equal(git('branch', '--show-current'), 'fix/eval-interrupted');
  assert.equal(git('status', '--porcelain').split('\n').length, 3);
  assert.equal(
    createHash('sha256')
      .update(git('diff', 'HEAD', '--binary'))
      .digest('hex'),
    before,
  );
  assert.equal(JSON.parse(await readFile(state.statusFile, 'utf8')).slots[0].lifecycle, 'held');
});
