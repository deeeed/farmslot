import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';

import { type SlotRefreshParams, slotWorkspaceIdentity } from '@farmslot/protocol';

import type { RawProjectJson, SlotVars } from '../../core/index.js';

import type { WorkspaceProbe } from './workspace-probe.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'f396-recovery-'));
for (const dir of [
  'pool',
  'projects/example',
  'repo',
  'home',
  'runs',
  'services/gateway',
  'scripts',
])
  await mkdir(path.join(root, dir), { recursive: true });
Object.assign(process.env, {
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_ROOT: root,
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_NATIVE_STATE_DIR: path.join(root, 'native'),
  FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
});
after(() => rm(root, { recursive: true, force: true }));
await writeFile(path.join(root, 'CLAUDE.md'), '# Example fixture\n');
await writeFile(path.join(root, 'scripts/dev.sh'), 'exit 1\n');
await writeFile(path.join(root, 'services/gateway/package.json'), '{}');
await writeFile(
  path.join(root, 'projects/example/project.json'),
  '{"name":"example","default_branch":"main"}',
);
await writeFile(
  path.join(root, 'pool/local.json'),
  JSON.stringify({
    machine: 'example',
    host: 'localhost',
    ssh_user: os.userInfo().username,
    platform: 'cli',
    project: 'example',
    slots: [{ id: 'example-slot', repo: path.join(root, 'repo'), session: 'example-slot' }],
  }),
);
await import('../../runtime/mock-pty.test-support.js');
const core = await import('../../core/index.js');
let head = 'a'.repeat(40),
  remote = head,
  branch = 'main',
  dirty = 0;
let fixtures = 'OK',
  probeError: string | undefined;
let fetchExitCode = 0;
let onFixtures = async () => {};
let moves = 0;
const calls: string[] = [];
mock.module('../../core/index.js', {
  namedExports: {
    ...core,
    execOnSlot: async (_vars: SlotVars, command: string) => {
      if (command.includes(' fetch --no-tags '))
        return { exitCode: fetchExitCode, stdout: '', stderr: '' };
      if (command.includes('refs/heads/main^{commit}'))
        return { exitCode: 3, stdout: '', stderr: '' };
      if (command.includes('update-ref')) {
        calls.push('park');
        return {
          exitCode: 0,
          stdout: `__farmslot_park__ ${head} ${branch} refs/farmslot/parked/manual-example/${head}\ncommit-1\ncommit-2\ncommit-3\n`,
          stderr: '',
        };
      }
      if (command.includes('merge-base'))
        return { exitCode: branch === 'main' ? 0 : 1, stdout: '', stderr: '' };
      if (command.includes('rev-parse'))
        return {
          exitCode: 0,
          stdout: command.includes('refs/heads/main') ? remote : head,
          stderr: '',
        };
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  },
});
mock.module('../../core/read-probes.js', {
  namedExports: {
    readSlotProbe: async () => ({
      exitCode: 0,
      stdout: `${remote}\trefs/heads/main\n`,
      stderr: '',
    }),
  },
});
mock.module('./workspace-probe.js', {
  namedExports: {
    probeWorkspace: async (
      _vars: SlotVars,
      _project: RawProjectJson,
      _branch: string,
      timeout: number,
    ): Promise<WorkspaceProbe> => {
      assert.equal(timeout, 120_000);
      if (probeError) throw new Error(probeError);
      return {
        branch,
        headSha: head,
        dirtyFingerprint: `dirty-${dirty}`,
        dirtyCount: dirty,
        localDefaultSha: remote,
        behind: 0,
        defaultFetchedAt: null,
        originKey: 'example',
        publicationRemote: 'origin',
        publicationRef: `refs/heads/${branch}`,
      };
    },
  },
});
const tracking = await import('./slot-tracking.js');
mock.module('./slot-tracking.js', {
  namedExports: {
    ...tracking,
    assertSlotNotOperatorRoot: async () => {},
    detectLinkedWorktree: async () => false,
    resetSlotRepoToIdle: async (...args: Parameters<typeof tracking.resetSlotRepoToIdle>) => {
      await args[4]?.verifyWork?.();
      calls.push('reset');
      head = remote;
      branch = 'main';
    },
  },
});
const scaffolding = await import('../../fleet/slot-scaffolding.js');
mock.module('../../fleet/slot-scaffolding.js', {
  namedExports: { ...scaffolding, excludeSlotScaffolding: async () => {} },
});
mock.module('../fleet.js', { namedExports: { checkFixtures: async () => fixtures } });
mock.module('./fixtures.js', {
  namedExports: {
    slotFixtureRefresh: async () => {
      await onFixtures();
      if (moves > 0) {
        remote = 'b'.repeat(40);
        moves--;
      }
    },
  },
});
mock.module('./release.js', {
  namedExports: {
    assertReleaseRunGuards: () => {},
    slotRelease: async () => {
      calls.push('release');
      head = remote;
      branch = 'main';
      return { released: true };
    },
  },
});
mock.module('../../run-engine/gate-held-lifecycle.js', {
  namedExports: {
    findActiveGateHeldRunForSlot: () => undefined,
    findGateParkedRunForSlot: () => undefined,
  },
});
const { inspectSlotWorkspace } = await import('./workspace.js');
const { recoverSlotWorkspace } = await import('./recover-workspace.js');
const { loadFleetStatus } = await import('../../fleet/state.js');
const store = await import('../../runs/store.js');
const recovery = {
  id: 'recovery-1',
  identity: {
    epoch: 4,
    currentRunId: null,
    cleanupRunId: null,
    handoffRunId: null,
    branch: 'main',
    headSha: head,
    dirtyFingerprint: 'dirty-0',
    recoveryId: 'recovery-1',
  },
  completed: [],
  phase: 'inspect',
};
const seed = async (fields: Record<string, unknown> = {}) =>
  writeFile(
    path.join(root, 'status.json'),
    JSON.stringify({
      slots: [
        {
          slot: 'example-slot',
          machine: 'example',
          platform: 'cli',
          project: 'example',
          ssh: 'LOCAL',
          branch: 'main',
          enabled: true,
          agent: 'idle',
          lifecycle: 'held',
          phase: 'occupied',
          slot_epoch: 4,
          current_run_id: null,
          workspace_recovery: recovery,
          held_reason: 'Recovery interrupted',
          ...fields,
        },
      ],
    }),
  );
const recover = (extra: Partial<SlotRefreshParams> = {}) =>
  recoverSlotWorkspace(
    {
      slotId: 'example-slot',
      requestId: 'example-request',
      release: true,
      recover: true,
      mode: 'safe',
      ...extra,
    },
    () => {},
    undefined,
    { parkOwnerlessCommits: true },
  );
beforeEach(async () => {
  head = 'a'.repeat(40);
  remote = head;
  branch = 'main';
  dirty = 0;
  fixtures = 'OK';
  probeError = undefined;
  fetchExitCode = 0;
  moves = 0;
  calls.length = 0;
  onFixtures = async () => {};
  await seed();
});

test('recovery inspects without a fleet identity using its own timeout', async () => {
  const result = await recover();
  assert.equal(result.refreshed, true, result.detail);
  assert.equal((await core.readSlotRow('example-slot'))?.lifecycle, 'ready');
});
test('malformed recovery is replaced after inspection instead of trapping a held slot', async () => {
  await seed({ workspace_recovery: { id: 'broken' } });
  const result = await recover();
  assert.equal(result.refreshed, true, result.detail);
});
test('malformed recovery also resumes with an explicit observed identity', async () => {
  await seed({ workspace_recovery: { id: 'broken' } });
  const expectedWorkspace = slotWorkspaceIdentity(
    await inspectSlotWorkspace('example-slot', { timeoutMs: 120_000 }),
  );
  const result = await recoverSlotWorkspace(
    { slotId: 'example-slot', release: true, expectedWorkspace, mode: 'safe' },
    () => {},
    undefined,
    { parkOwnerlessCommits: true },
  );
  assert.equal(result.refreshed, true, result.detail);
});
test('failed server inspection reports the actual probe error', async () => {
  probeError = 'Read probe did not complete (exit 124)';
  assert.equal((await recover()).detail, probeError);
  assert.deepEqual(calls, []);
});
test('a failed fetch reports its exit code and leaves recovery held', async () => {
  fetchExitCode = 130;
  const expectedWorkspace = slotWorkspaceIdentity(
    await inspectSlotWorkspace('example-slot', { timeoutMs: 120_000 }),
  );
  const result = await recover({ expectedWorkspace });
  assert.equal(result.detail, 'Cannot fetch the default branch (exit 130)');
  assert.equal((await core.readSlotRow('example-slot'))?.lifecycle, 'held');
  assert.deepEqual(calls, []);
});
test('inspection without identity requires an existing recovery marker', async () => {
  await seed({ workspace_recovery: null });
  assert.equal((await recover()).detail, 'Slot has no pending workspace recovery');
  assert.deepEqual(calls, []);
});
for (const field of ['cleanup_run_id', 'handoff_run_id']) {
  test(`inspection without identity preserves ${field}`, async () => {
    await seed({ [field]: 'other-run' });
    assert.equal((await recover()).detail, 'Slot has a cleanup or handoff owner');
    assert.deepEqual(calls, []);
  });
}
test('dirty work still requires confirmation and is never reset', async () => {
  dirty = 1;
  assert.equal((await recover()).detail, 'Confirm discarding the current local work');
  assert.deepEqual(calls, []);
});
test('force without an observed identity cannot discard dirty work', async () => {
  dirty = 1;
  assert.equal(
    (await recover({ mode: 'force' })).detail,
    'Confirm discarding the current local work',
  );
  assert.deepEqual(calls, []);
});
test('three unpushed commits on a non-default branch are parked before any reset', async () => {
  branch = 'example-feature';
  remote = 'b'.repeat(40);
  const result = await recover();
  assert.equal(result.refreshed, true, result.detail);
  assert.equal(result.parked?.[0]?.commits, 3);
  assert.deepEqual(calls, ['park', 'release']);
});
test('three unpushed commits retained by a terminal owner are parked before reset', async (t) => {
  const run = store.createRun({
    project: 'example',
    flowType: 'dev',
    ticketOrPr: 'EXAMPLE-3',
    slotId: 'example-slot',
  });
  store.updateRun(run.id, { status: 'done' });
  t.after(() => store.deleteRun(run.id));
  await seed({ current_run_id: run.id });
  branch = 'example-feature';
  remote = 'b'.repeat(40);
  const expectedWorkspace = slotWorkspaceIdentity(
    await inspectSlotWorkspace('example-slot', { timeoutMs: 120_000 }),
  );
  const result = await recover({ expectedWorkspace });
  assert.equal(result.refreshed, true, result.detail);
  assert.equal(result.parked?.[0]?.commits, 3);
  assert.deepEqual(calls, ['park', 'release']);
});
test('a terminal run pointer and stale working agent do not block recovery', async (t) => {
  const run = store.createRun({
    project: 'example',
    flowType: 'dev',
    ticketOrPr: 'EXAMPLE-1',
    slotId: 'example-slot',
  });
  store.updateRun(run.id, { status: 'failed' });
  t.after(() => store.deleteRun(run.id));
  await seed({
    current_run_id: run.id,
    lifecycle: 'busy',
    phase: 'working',
    agent: 'working',
    held_reason: null,
  });
  const fleet = await loadFleetStatus(true);
  assert.equal(
    fleet.slots[0].agent,
    'working',
    'fleet copies raw agent, so recovery must check the terminal owner',
  );
  const result = await recover();
  assert.equal(result.refreshed, true, result.detail);
});
test('a live run remains protected', async (t) => {
  const run = store.createRun({
    project: 'example',
    flowType: 'dev',
    ticketOrPr: 'EXAMPLE-2',
    slotId: 'example-slot',
  });
  store.updateRun(run.id, { status: 'monitoring' });
  t.after(() => {
    store.updateRun(run.id, { status: 'cancelled' });
    return store.deleteRun(run.id);
  });
  await seed({ current_run_id: run.id });
  assert.equal((await recover()).detail, `Run ${run.id.slice(0, 8)} still needs this checkout`);
  assert.deepEqual(calls, []);
});
test('verification names the failed condition and its value', async () => {
  fixtures = 'FAIL';
  const expectedWorkspace = slotWorkspaceIdentity(
    await inspectSlotWorkspace('example-slot', { timeoutMs: 120_000 }),
  );
  assert.equal(
    (await recover({ expectedWorkspace })).detail,
    'Recovery verification failed: fixtures=FAIL',
  );
});
test('verification retries when only the default head moved', async () => {
  moves = 1;
  const expectedWorkspace = slotWorkspaceIdentity(
    await inspectSlotWorkspace('example-slot', { timeoutMs: 120_000 }),
  );
  const result = await recover({ expectedWorkspace });
  assert.equal(result.refreshed, true, result.detail);
  assert.equal(head, remote);
  assert.equal(calls.filter((call) => call === 'reset').length, 2);
});
test('a default branch that keeps moving stops after two safe retries', async () => {
  let advances = 0;
  onFixtures = async () => {
    advances++;
    if (advances > 3) throw new Error('Recovery retried beyond its bound');
    remote = ['b', 'c', 'd'][advances - 1].repeat(40);
  };
  const result = await recover();
  assert.equal(result.refreshed, false);
  assert.equal(
    result.detail,
    `Recovery verification failed: headSha=${'c'.repeat(40)}, remoteDefaultSha=${'d'.repeat(40)}`,
  );
  assert.equal(calls.filter((call) => call === 'reset').length, 3);
  assert.equal((await core.readSlotRow('example-slot'))?.lifecycle, 'held');
});
test('dirty work appearing during verification prevents the head-movement retry', async () => {
  onFixtures = async () => {
    remote = 'b'.repeat(40);
    dirty = 1;
  };
  const result = await recover();
  assert.equal(result.refreshed, false);
  assert.equal(
    result.detail,
    `Recovery verification failed: headSha=${'a'.repeat(40)}, remoteDefaultSha=${'b'.repeat(40)}; dirtyCount=1`,
  );
  assert.equal(calls.filter((call) => call === 'reset').length, 1);
});
test('a rival owner arriving during recovery is left untouched', async (t) => {
  let rivalId = '';
  onFixtures = async () => {
    const rival = store.createRun({
      project: 'example',
      flowType: 'dev',
      ticketOrPr: 'EXAMPLE-4',
      slotId: 'example-slot',
    });
    rivalId = rival.id;
    store.updateRun(rival.id, { status: 'monitoring' });
    t.after(() => {
      store.updateRun(rival.id, { status: 'cancelled' });
      return store.deleteRun(rival.id);
    });
    await core.updateSlotStatus('example-slot', {
      slot_epoch: 5,
      current_run_id: rival.id,
      workspace_recovery: null,
      lifecycle: 'busy',
      phase: 'working',
      held_reason: null,
    });
  };
  const result = await recover();
  assert.equal(result.detail, 'Recovery ownership changed during phase');
  const row = await core.readSlotRow('example-slot');
  assert.equal(row?.current_run_id, rivalId);
  assert.equal(row?.lifecycle, 'busy');
  assert.equal(row?.phase, 'working');
});
