import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
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
let pausedRead: (ProbePause & { kind: 'default' | 'publication' }) | undefined;
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
      const kind = scope.includes('publication') ? 'publication' : 'default';
      const pause = pausedRead;
      if (pause && pause.kind === kind && timeout === 120_000) {
        pausedRead = undefined;
        pause.started();
        await pause.gate;
      }
      return {
        exitCode: 0,
        stdout:
          scope === 'workspace' || scope === 'workspace-recovery'
            ? JSON.stringify(probe)
            : `${scope.includes('publication') ? probe.headSha : 'a'.repeat(40)}\trefs/heads/main\n`,
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

test('a 37-second inspection gets its cache window after completion without changing observed time', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let resume!: () => void;
  let notify!: () => void;
  const started = new Promise<void>((resolve) => {
    notify = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  invalidateSlotWorkspaceObservations('cache-slot');
  pausedProbe = { gate, started: notify };
  const before = probes;
  const pending = enrichFleetWorkspaces(await loadFleetStatus(true));
  await started;
  now += 37_600;
  resume();
  const first = await pending;
  const next = await enrichFleetWorkspaces(await loadFleetStatus(true));
  assert.equal(probes, before + 1, 'slow reads must not be expired immediately on delivery');
  assert.equal(next.slots[0]?.workspace?.observedAt, first.slots[0]?.workspace?.observedAt);
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

for (const kind of ['default', 'publication'] as const) {
  test(`a pending recovery ${kind} read cannot extend a passive reader's deadline`, async () => {
    const status = JSON.parse(await readFile(path.join(root, 'status.json'), 'utf8'));
    Object.assign(status.slots[0], {
      branch: 'main',
      current_run_id: null,
      cleanup_run_id: null,
      handoff_run_id: null,
      lifecycle: 'ready',
      phase: null,
    });
    await writeFile(path.join(root, 'status.json'), JSON.stringify(status));
    probe.originKey = `concurrent-${kind}`;
    probe.branch = 'main';
    probe.headSha = (kind === 'default' ? 'a' : 'b').repeat(40);
    probe.localDefaultSha = kind === 'default' ? 'a'.repeat(40) : null;
    let resume: () => void = () => assert.fail('Read gate missing');
    let notify: () => void = () => assert.fail('Read start missing');
    const started = new Promise<void>((resolve) => {
      notify = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    pausedRead = { kind, gate, started: notify };
    const before = probeReads.length;
    const recovery = inspectSlotWorkspace('cache-slot', { timeoutMs: 120_000 });
    await started;
    const passive = inspectSlotWorkspace('cache-slot');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let completedBeforeRelease: boolean;
    try {
      completedBeforeRelease = await Promise.race([
        passive.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), 500);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      resume();
      await Promise.all([recovery, passive]);
    }
    assert.equal(
      completedBeforeRelease,
      true,
      'Passive readers must not join a pending recovery command',
    );
    const reads = probeReads.slice(before).filter((read) => read.scope.includes(kind));
    assert.ok(
      reads.some((read) => read.scope === `workspace-recovery-${kind}` && read.timeout === 120_000),
    );
    assert.ok(reads.some((read) => read.scope === `workspace-${kind}` && read.timeout === 5000));
  });
}

test('passive reuse is bounded, preserves observed time, and never replaces an acting inspection', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const priorProbe = { ...probe };
  t.after(() => {
    Object.assign(probe, priorProbe);
  });
  Object.assign(probe, {
    headSha: 'a'.repeat(40),
    localDefaultSha: 'a'.repeat(40),
    originKey: 'metadata-stable',
    branch: 'main',
  });
  const gitDir = path.join(root, 'repo/.git');
  await mkdir(gitDir, { recursive: true });
  t.after(() => rm(gitDir, { recursive: true, force: true }));
  await writeFile(path.join(gitDir, 'HEAD'), 'a'.repeat(40) + '\n');
  const index = path.join(gitDir, 'index');
  await writeFile(index, 'fixture index');
  await utimes(index, 1_700_000_000, 1_700_000_000);
  invalidateSlotWorkspaceObservations('cache-slot');
  const before = probes;
  const first = await enrichFleetWorkspaces(await loadFleetStatus(true));
  now += 16_000;
  const reused = await enrichFleetWorkspaces(await loadFleetStatus(true));
  assert.equal(probes, before + 1, 'unchanged metadata avoids another full Git inspection');
  assert.equal(reused.slots[0]?.workspace?.observedAt, first.slots[0]?.workspace?.observedAt);
  await inspectSlotWorkspace('cache-slot');
  assert.equal(probes, before + 2, 'acting reads always inspect actual contents');
  await utimes(index, 1_700_000_001, 1_700_000_001);
  now += 16_000;
  await enrichFleetWorkspaces(await loadFleetStatus(true));
  assert.equal(probes, before + 3, 'changed index invalidates passive reuse');
  now += 91_000;
  await enrichFleetWorkspaces(await loadFleetStatus(true));
  assert.equal(probes, before + 4, 'unstaged and untracked dirt still gets a bounded full read');
  invalidateSlotWorkspaceObservations('cache-slot');
  await enrichFleetWorkspaces(await loadFleetStatus(true));
  assert.equal(probes, before + 5, 'explicit mutation invalidation wins over unchanged metadata');
});

test('unchanged Git metadata cannot retain an active-owner refusal after the Run completes', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const gitDir = path.join(root, 'repo/.git');
  await mkdir(gitDir, { recursive: true });
  t.after(() => rm(gitDir, { recursive: true, force: true }));
  await writeFile(path.join(gitDir, 'HEAD'), 'a'.repeat(40) + '\n');
  const priorProbe = { ...probe };
  t.after(() => {
    Object.assign(probe, priorProbe);
  });
  Object.assign(probe, {
    headSha: 'a'.repeat(40),
    localDefaultSha: 'a'.repeat(40),
    originKey: 'owner-transition',
    branch: 'main',
  });
  const { createRun, updateRun, deleteRun } = await import('../../runs/store.js');
  const run = createRun({
    project: 'proof',
    flowType: 'dev',
    ticketOrPr: 'PROOF-1',
    slotId: 'cache-slot',
  });
  t.after(async () => {
    await deleteRun(run.id);
  });
  updateRun(run.id, { status: 'monitoring' });
  const statusFile = path.join(root, 'status.json');
  const original = await readFile(statusFile, 'utf8');
  t.after(() => writeFile(statusFile, original));
  const status = JSON.parse(original);
  Object.assign(status.slots[0], {
    current_run_id: run.id,
    lifecycle: 'busy',
    agent: 'idle',
    phase: null,
  });
  await writeFile(statusFile, JSON.stringify(status));
  invalidateSlotWorkspaceObservations('cache-slot');
  const active = await enrichFleetWorkspaces(await loadFleetStatus(true));
  assert.equal(active.slots[0]?.workspace?.terminalOwner, false);
  assert.match(active.slots[0]?.workspace?.protectedReason ?? '', /still active/);
  const before = probes;
  updateRun(run.id, { status: 'done' });
  now += 16_000;
  const completed = await enrichFleetWorkspaces(await loadFleetStatus(true));
  assert.equal(completed.slots[0]?.workspace?.protectedReason, undefined);
  assert.equal(completed.slots[0]?.workspace?.terminalOwner, true);
  assert.equal(probes, before + 1, 'a changed owner disposition requires a fresh inspection');
});
