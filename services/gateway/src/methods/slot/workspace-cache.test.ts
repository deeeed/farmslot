import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

import type { SlotVars } from '../../core/index.js';

import type { WorkspaceProbe } from './workspace-probe.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-observation-cache-'));
for (const name of [
  'pool',
  'projects/proof',
  'repo',
  'services/gateway',
  'scripts',
  'home',
  'runs',
])
  await mkdir(path.join(root, name), { recursive: true });
Object.assign(process.env, {
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_ROOT: root,
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
});
after(() => rm(root, { recursive: true, force: true }));
await writeFile(path.join(root, 'CLAUDE.md'), '# Owned cache fixture\n');
await writeFile(path.join(root, 'scripts/dev.sh'), 'exit 1\n');
await writeFile(path.join(root, 'services/gateway/package.json'), '{}');
await writeFile(
  path.join(root, 'projects/proof/project.json'),
  JSON.stringify({ name: 'proof', default_branch: 'main' }),
);
await writeFile(
  path.join(root, 'pool/local.json'),
  JSON.stringify({
    machine: 'fixture',
    host: 'localhost',
    ssh_user: os.userInfo().username,
    platform: 'cli',
    project: 'proof',
    slots: [{ id: 'cache-slot', repo: path.join(root, 'repo'), session: 'cache-slot' }],
  }),
);
await writeFile(
  path.join(root, 'status.json'),
  JSON.stringify({
    checked_at: new Date().toISOString(),
    slots: [
      {
        slot: 'cache-slot',
        machine: 'fixture',
        platform: 'cli',
        project: 'proof',
        ssh: 'LOCAL',
        branch: 'main',
        head_sha: 'a'.repeat(40),
        agent: 'idle',
        enabled: true,
        dispatchable: true,
        lifecycle: 'ready',
        phase: null,
        slot_epoch: 1,
        current_run_id: null,
      },
    ],
  }),
);
await import('../../runtime/mock-pty.test-support.js');
let probes = 0;
interface ProbePause {
  gate: Promise<void>;
  started(): void;
}
let pausedProbe: ProbePause | undefined;
const probe: WorkspaceProbe = {
  branch: 'main',
  headSha: 'a'.repeat(40),
  dirtyFingerprint: 'b'.repeat(64),
  dirtyCount: 1,
  localDefaultSha: 'a'.repeat(40),
  behind: 0,
  defaultFetchedAt: null,
  originKey: 'fixture',
  publicationRemote: 'origin',
  publicationRef: 'refs/heads/main',
};
const probeReads: Array<{ scope: string; timeout: number }> = [];
mock.module('../../core/read-probes.js', {
  namedExports: {
    readSlotProbe: async (_vars: SlotVars, _command: string, scope: string, timeout: number) => {
      probeReads.push({ scope, timeout });
      return {
        exitCode: 0,
        stdout:
          scope === 'workspace' || scope === 'workspace-recovery'
            ? JSON.stringify(probe)
            : `${'a'.repeat(40)}\trefs/heads/main\n`,
        stderr: '',
      };
    },
  },
});
const actualProbe = await import('./workspace-probe.js');
mock.module('./workspace-probe.js', {
  namedExports: {
    probeWorkspace: async () => {
      probes++;
      const captured = { ...probe };
      const pause = pausedProbe;
      pausedProbe = undefined;
      if (pause) {
        pause.started();
        await pause.gate;
      }
      return captured;
    },
  },
});
const { loadFleetStatus } = await import('../../fleet/state.js');
const { enrichFleetWorkspaces, inspectSlotWorkspace, invalidateSlotWorkspaceObservations } =
  await import('./workspace.js');

test('observation timestamps do not turn unchanged status reads into repeated Git inspections', async () => {
  const first = await enrichFleetWorkspaces(await loadFleetStatus(true));
  assert.equal(first.slots[0]?.workspace?.dirtyCount, 1);
  await enrichFleetWorkspaces(await loadFleetStatus(true));
  assert.equal(probes, 1);
});

test('a verified mutation invalidates cached dirt before its TTL expires', async () => {
  probe.dirtyCount = 0;
  probe.dirtyFingerprint = 'c'.repeat(64);
  invalidateSlotWorkspaceObservations('cache-slot');
  const fresh = await enrichFleetWorkspaces(await loadFleetStatus(true));
  assert.equal(fresh.slots[0]?.workspace?.dirtyCount, 0);
  assert.equal(probes, 2);
});

test('a pending inspection from an old identity settles before a new single-flight inspection', async () => {
  let resume: () => void = () => assert.fail('Probe gate missing');
  let notify: () => void = () => assert.fail('Probe start missing');
  const started = new Promise<void>((resolve) => {
    notify = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  invalidateSlotWorkspaceObservations('cache-slot');
  pausedProbe = { gate, started: notify };
  const older = enrichFleetWorkspaces(await loadFleetStatus(true));
  await started;
  const status = JSON.parse(await readFile(path.join(root, 'status.json'), 'utf8'));
  status.slots[0].branch = 'feature';
  status.slots[0].slot_epoch++;
  await writeFile(path.join(root, 'status.json'), JSON.stringify(status));
  probe.branch = 'feature';
  const freshFleet = await loadFleetStatus(true);
  const fresh = enrichFleetWorkspaces(freshFleet);
  resume();
  await older;
  const result = await fresh;
  assert.equal(result.slots[0]?.workspace?.branch, 'feature');
  assert.equal(result.slots[0]?.workspace?.epoch, status.slots[0].slot_epoch);
});

test('an unenriched broadcast after a claim cannot expose a previous saved workspace owner', async () => {
  const old = await inspectSlotWorkspace('cache-slot');
  const status = JSON.parse(await readFile(path.join(root, 'status.json'), 'utf8'));
  status.slots[0].workspace = old;
  await writeFile(path.join(root, 'status.json'), JSON.stringify(status));
  const { claimSlotStatusIf } = await import('../../core/state.js');
  const claimed = await claimSlotStatusIf('cache-slot', () => true, {
    current_run_id: 'next-owner',
    branch: 'next-branch',
    lifecycle: 'busy',
    phase: 'dispatching',
  });
  assert.equal(claimed.claimed, true);
  const fleet = await loadFleetStatus(true);
  assert.equal(fleet.slots[0]?.currentRunId, 'next-owner');
  assert.equal(fleet.slots[0]?.branch, 'next-branch');
  assert.equal(fleet.slots[0]?.workspace, undefined);
});

test('owned recovery probes have their own operation budget instead of a passive status deadline', async () => {
  const { loadSlotVars } = await import('../../core/config.js');
  const vars = await loadSlotVars('cache-slot');
  const before = probeReads.length;
  await actualProbe.probeWorkspace(vars, {}, 'main');
  await actualProbe.probeWorkspace(vars, {}, 'main', 120_000);
  assert.deepEqual(probeReads.slice(before), [
    { scope: 'workspace', timeout: 5000 },
    { scope: 'workspace-recovery', timeout: 120_000 },
  ]);
});
