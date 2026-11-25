import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';

import type { Run, RunPrepareArtifact } from '@farmslot/protocol';

import type { slotPrepare } from '../methods/slot/prepare.js';
import type { SlotPrepareInternalOptions, SlotPrepareResult } from '../methods/slot/shared.js';
import { makeVars } from '../runners/test-fixtures.js';

import type { StepIO } from './dispatch-lifecycle-steps.js';
import { makeRun } from './test-fixtures.js';

// The prepare step's pinned wiring, with slot.prepare stubbed: what it passes to
// prepare, what it records on the run, and what it refuses.
const BASE = '260bd3a5b20c3f9126510b7b71d0e5527f395b5d';
const vars = makeVars({
  slotId: 'macwork-mm-2',
  platform: 'ios',
  projectName: 'mobile',
  resourceVars: { simulator: 'mm-2' },
});
let run: Run;
let prepareOptions: SlotPrepareInternalOptions | undefined;
let recordWhenPrepared: Run['prepareArtifact'];
let prepareArtifact: SlotPrepareResult['prepareArtifact'];
let provisionRead: () => { exitCode: number; stdout: string; stderr: string };
const persisted: string[] = [];

// Real project configs: the pinned helpers read them through loadProjectVarsOrNull.
const projects = mkdtempSync(path.join(tmpdir(), 'pinned-prepare-step-'));
process.env.FARMSLOT_PROJECTS_DIR = projects;
after(() => rmSync(projects, { recursive: true, force: true }));
for (const [name, json] of [
  ['mobile', { name: 'mobile', hooks: { artifact_check: 'probe' } }],
  ['extension', { name: 'extension', hooks: {} }],
] as const) {
  mkdirSync(path.join(projects, name), { recursive: true });
  writeFileSync(path.join(projects, name, 'project.json'), JSON.stringify(json));
}
const store = await import('../runs/store.js');
mock.module('../runs/store.js', {
  namedExports: {
    ...store,
    getRun: () => run,
    updateRun: (_id: string, patch: Partial<Run>) => (run = { ...run, ...patch }),
    updateRunStep: () => run,
    persistRunNow: async (_run: Run, reason: string) => {
      persisted.push(reason);
    },
  },
});
const config = await import('../core/config.js');
mock.module('../core/config.js', {
  namedExports: {
    ...config,
    loadSlotVars: async () => vars,
    resolveProjectRuntimeDir: async () => '.agent',
  },
});
const exec = await import('../core/exec.js');
mock.module('../core/exec.js', {
  namedExports: {
    ...exec,
    execOnSlot: async (_vars: unknown, command: string) =>
      command.includes('runway-provision.json')
        ? provisionRead()
        : { exitCode: 1, stdout: '', stderr: '' },
  },
});
const binding = await import('../runs/slot-binding.js');
mock.module('../runs/slot-binding.js', {
  namedExports: { ...binding, ensureRunSlotBinding: () => run },
});
const stack = await import('./stack-base.js');
mock.module('./stack-base.js', { namedExports: { ...stack, ensureRunStack: async () => run } });
const frozen = await import('../qa/frozen-source.js');
mock.module('../qa/frozen-source.js', {
  namedExports: { ...frozen, ensureFrozenQaSource: () => run },
});
mock.module('./remote-probes.js', {
  namedExports: { probeRemotePath: async () => ({ ok: true }) },
});
const sync = await import('./task-sync.js');
mock.module('./task-sync.js', {
  namedExports: { ...sync, completeRunTaskInitialization: async () => {} },
});
const launch = await import('../runners/launch-command.js');
mock.module('../runners/launch-command.js', {
  namedExports: { ...launch, assertRunnerLaunchPrerequisites: () => {} },
});
mock.module('./eval-harness-lifecycle.js', {
  namedExports: { executeEvalHarnessLifecycle: async () => ({ skipped: true }) },
});
let scrubReceipt: Awaited<ReturnType<typeof slotPrepare>>['tempScrub'];
let failAfterScrub = false;
const prepare: typeof slotPrepare = async (_params, _emit, _signal, options) => {
  prepareOptions = options;
  recordWhenPrepared = run.prepareArtifact;
  if (scrubReceipt) options?.onTempScrubbed?.(scrubReceipt);
  if (failAfterScrub) throw new Error("temp/ still holds another run's files: temp (refused)");
  return {
    ...(scrubReceipt ? { tempScrub: scrubReceipt } : {}),
    prepared: true,
    requestId: 'fixture-prepare',
    startRef: { requestedRef: BASE, resolvedSha: BASE, resolvedAt: '2026-11-25T10:00:00.000Z' },
    ...(prepareArtifact ? { prepareArtifact } : {}),
  };
};
const slots = await import('../methods/slot/index.js');
mock.module('../methods/slot.js', { namedExports: { ...slots, slotPrepare: prepare } });
const owner: string = './dispatch-lifecycle-steps.js?pinned-prepare-step-test';
const { executePrepareStep }: typeof import('./dispatch-lifecycle-steps.js') = await import(owner);

const stale: RunPrepareArtifact = {
  kind: 'runway',
  slotId: 'macwork-mm-1',
  baseSha: 'b'.repeat(40),
  runId: '1',
  revision: 'b'.repeat(40),
  platform: 'ios',
  installedAt: '2026-11-24T10:00:00.000Z',
  enforced: true,
};

beforeEach(() => {
  scrubReceipt = undefined;
  failAfterScrub = false;
  persisted.length = 0;
  prepareOptions = undefined;
  recordWhenPrepared = undefined;
  prepareArtifact = undefined;
  provisionRead = () => ({ exitCode: 1, stdout: '', stderr: '' });
  run = makeRun({
    id: 'pinned-prepare-step',
    status: 'preparing',
    mode: 'autonomous',
    completionPolicy: 'artifact-only',
    lane: 'comparison',
    flowType: 'dev',
    ticketOrPr: 'TAT-1',
    project: 'mobile',
    slotId: vars.slotId,
    branch: 'eval/pinned',
    startRef: { requestedRef: '260bd3a5' },
  });
  run.prepareArtifact = stale;
});

function prepareRun(flags?: { skipPrepare?: true }, stepPartialIO = new Map<string, StepIO>()) {
  return executePrepareStep(run.id, {
    activeMonitors: new Map(),
    broadcastFn: () => {},
    getRunFlags: () => flags,
    normalizeEvalReplayForTaskWrite: async (_id, current) => current,
    stepPartialIO,
  });
}

test('a pinned prepare clears the old record, asks for pinning, and records the build enforced', async () => {
  prepareArtifact = {
    kind: 'runway',
    baseSha: BASE,
    runId: '41900351233',
    revision: BASE,
    platform: 'ios',
    installedAt: '2026-11-25T10:00:00.000Z',
  };
  assert.equal((await prepareRun()).outputs?.success, true);
  assert.equal(prepareOptions?.pinned, true);
  assert.equal(recordWhenPrepared, null, 'the earlier record is gone before prepare runs');
  assert.deepEqual(run.prepareArtifact, {
    ...prepareArtifact,
    slotId: vars.slotId,
    enforced: true,
  });
  const cleared = persisted.indexOf('prepare artifact cleared');
  assert.ok(
    cleared >= 0 && cleared < persisted.indexOf('pinned build recorded'),
    persisted.join(', '),
  );
});

const receipt = (refusedCount = 0) => ({
  removed: [{ type: 'entry' as const, path: 'temp/probe.json', kind: 'file' }],
  removedCount: 1,
  kept: [],
  keptCount: 0,
  refused: refusedCount ? [{ path: 'temp', reason: 'refused' }] : [],
  refusedCount,
});

test("the prepare step's outputs keep the temp/ clear-out", async () => {
  scrubReceipt = receipt();
  assert.deepEqual((await prepareRun()).outputs?.tempScrub, scrubReceipt);
});

test('a prepare that fails after its clear-out leaves the record in the partial outputs', async () => {
  scrubReceipt = receipt(1);
  failAfterScrub = true;
  const stepPartialIO = new Map<string, StepIO>();
  await assert.rejects(prepareRun(undefined, stepPartialIO), /still holds another run's files/);
  assert.deepEqual(stepPartialIO.get(run.id)?.outputs?.tempScrub, scrubReceipt);
});

test('a pinned run cannot skip prepare at the prepare step', async () => {
  await assert.rejects(
    prepareRun({ skipPrepare: true }),
    /A pinned comparison run cannot skip prepare/,
  );
});

test('an unreadable project config pins the run', async () => {
  run = { ...run, project: 'pinned-prepare-step-missing' };
  await prepareRun();
  assert.equal(prepareOptions?.pinned, true);
});

test('a project that does not take part prepares as before and records nothing', async () => {
  run = { ...run, project: 'extension' };
  run.prepareArtifact = undefined;
  await prepareRun();
  assert.equal(prepareOptions?.pinned, undefined);
  assert.equal(run.prepareArtifact, undefined);
  assert.ok(!persisted.some((reason) => reason.includes('artifact') || reason.includes('build')));
});

const provision = JSON.stringify({
  appInstalled: true,
  simulator: { name: 'mm-2' },
  artifact: { runId: '41900351233', revision: 'c'.repeat(40) },
  recordedAt: '2026-11-25T09:00:00.000Z',
});

test('an excluded eval trial records the build its slot reports, unenforced', async () => {
  run = { ...run, flowType: 'qa' };
  provisionRead = () => ({ exitCode: 0, stdout: provision, stderr: '' });
  assert.equal((await prepareRun()).outputs?.success, true);
  assert.equal(prepareOptions?.pinned, undefined, 'a proof trial is not pinned');
  assert.deepEqual(run.prepareArtifact, {
    kind: 'runway',
    slotId: vars.slotId,
    baseSha: BASE,
    runId: '41900351233',
    revision: 'c'.repeat(40),
    platform: 'ios',
    installedAt: '2026-11-25T09:00:00.000Z',
    enforced: false,
  });
});

test('a failed observed read never fails the prepare and leaves no stale record', async () => {
  run = { ...run, flowType: 'qa' };
  provisionRead = () => {
    throw new Error('node went away');
  };
  assert.equal((await prepareRun()).outputs?.success, true);
  assert.equal(run.prepareArtifact, null, 'the earlier record was cleared and nothing replaced it');
});
