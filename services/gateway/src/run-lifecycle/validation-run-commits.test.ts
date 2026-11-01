import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import type { ParkedRunCommits, Run } from '@farmslot/protocol';

import type { SlotVars } from '../core/config.js';
import type { execOnSlot } from '../core/exec.js';
import { makeRun } from '../run-engine/test-fixtures.js';
import { makeVars } from '../runners/test-fixtures.js';
import { createRun, deleteRun, getRun, updateRun } from '../runs/store.js';

import {
  dropParkedBranch,
  parkRunBranchCommits,
  parksBranchCommits,
  recordReleasedCheckout,
  restoreParkedBranch,
} from './validation-run-commits.js';

const run = promisify(execFile);
const checks = { defaultBranch: 'main' };
/** The slot's git, run on a real repository in this process. */
const localExec: typeof execOnSlot = async (_vars, cmd) => {
  try {
    const { stdout, stderr } = await run('/bin/sh', ['-c', String(cmd)]);
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failed.stdout ?? '', stderr: failed.stderr ?? '', exitCode: failed.code ?? 1 };
  }
};

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'parked-commits-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote.git');
  const repo = path.join(root, 'slot');
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '--bare', remote]);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git('config', 'user.email', 'proof@example.com');
  git('config', 'user.name', 'Proof');
  git('config', 'commit.gpgsign', 'false');
  git('commit', '-q', '--allow-empty', '-m', 'base');
  git('remote', 'add', 'origin', remote);
  git('push', '-q', 'origin', 'main');
  const base = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', 'TAT-4146-validation');
  git('commit', '-q', '--allow-empty', '-m', 'validation one');
  git('commit', '-q', '--allow-empty', '-m', 'validation two');
  const head = git('rev-parse', 'HEAD');
  const vars: SlotVars = makeVars({ slotId: 'proof-slot', remoteRepo: repo, repo });
  const created = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  t.after(async () => {
    if (!getRun(created.id)) return;
    updateRun(created.id, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(created.id);
  });
  const validation = updateRun(created.id, {
    completionPolicy: 'artifact-only',
    branch: 'TAT-4146-validation',
    status: 'done',
    worktreeHeadAtDispatch: base,
  });
  return { git, vars, base, head, validation };
}

test("a finished artifact-only run's own commits are parked under a ref that never moves, recorded on the run", async (t) => {
  const { git, vars, base, head, validation } = await fixture(t);
  // COMPLETE names the head it leaves while the run still owns the slot.
  await recordReleasedCheckout(validation, vars, localExec);
  assert.deepEqual(
    { ...getRun(validation.id)?.releasedCheckout, at: undefined },
    { slotId: 'proof-slot', branch: 'TAT-4146-validation', headSha: head, at: undefined },
  );
  const parked = await parkRunBranchCommits(validation, vars, localExec, checks);
  assert.ok(parked);
  assert.equal(parked.ref, `refs/farmslot/parked/${validation.id}/${head}`);
  assert.equal(git('rev-parse', parked.ref), head);
  assert.equal(parked.baseSha, base);
  assert.equal(parked.commits.length, 2, 'both unpushed commits, not the published base');
  assert.deepEqual(
    getRun(validation.id)?.parkedCommits?.map((entry) => entry.ref),
    [parked.ref],
  );
  // Parking the same head again keeps one record and the same ref.
  await parkRunBranchCommits(getRun(validation.id)!, vars, localExec, checks);
  assert.equal(getRun(validation.id)?.parkedCommits?.length, 1);

  // After the idle reset the unchanged branch is dropped; the parked ref keeps its commits.
  git('checkout', '-q', 'main');
  assert.equal(await dropParkedBranch(parked, vars, localExec), null);
  assert.equal(git('branch', '--list', 'TAT-4146-validation'), '');
  assert.equal(git('rev-parse', parked.ref), head);
  // A replay's prepare recreates the dropped branch at the parked head, and never moves it.
  assert.deepEqual(
    await restoreParkedBranch(getRun(validation.id), vars, 'TAT-4146-validation', localExec),
    parked,
  );
  assert.equal(git('rev-parse', 'refs/heads/TAT-4146-validation'), head);
  assert.equal(
    await restoreParkedBranch(getRun(validation.id), vars, 'TAT-4146-validation', localExec),
    null,
    'an existing branch is left alone',
  );
});

test("a checkout that isn't the run's own is never parked", async (t) => {
  const { git, vars, validation } = await fixture(t);
  // Dirty files, another branch, and history that doesn't descend from the run's baseline.
  git('commit', '-q', '--allow-empty', '-m', 'x');
  execFileSync('sh', ['-c', `echo edit > ${path.join(vars.remoteRepo, 'note.txt')}`]);
  assert.equal(await parkRunBranchCommits(validation, vars, localExec, checks), null, 'dirty');
  execFileSync('rm', [path.join(vars.remoteRepo, 'note.txt')]);
  git('checkout', '-q', '-b', 'someone-else');
  assert.equal(
    await parkRunBranchCommits(validation, vars, localExec, checks),
    null,
    'another branch',
  );
  git('checkout', '-q', 'TAT-4146-validation');
  const foreign = updateRun(validation.id, { worktreeHeadAtDispatch: 'f'.repeat(40) });
  assert.equal(
    await parkRunBranchCommits(foreign, vars, localExec, checks),
    null,
    'not from its baseline',
  );
  // An ownerless return names the head COMPLETE left; a commit stacked on top is not the run's.
  assert.equal(
    await parkRunBranchCommits(validation, vars, localExec, { ...checks, headSha: 'e'.repeat(40) }),
    null,
    'not the released head',
  );
  // A run on the default branch never has that branch parked or dropped.
  assert.equal(
    await parkRunBranchCommits(validation, vars, localExec, {
      defaultBranch: 'TAT-4146-validation',
    }),
    null,
    'the default branch',
  );
  assert.equal(git('for-each-ref', 'refs/farmslot/'), '');
  assert.equal(getRun(validation.id)?.parkedCommits, undefined);
  // A moved branch is kept rather than deleted.
  const moved: ParkedRunCommits = {
    slotId: 'proof-slot',
    ref: 'refs/farmslot/parked/x/y',
    branch: 'TAT-4146-validation',
    baseSha: 'b'.repeat(40),
    headSha: 'a'.repeat(40),
    commits: [],
    parkedAt: '',
  };
  git('checkout', '-q', 'main');
  assert.match(
    (await dropParkedBranch(moved, vars, localExec)) ?? '',
    /kept branch TAT-4146-validation/,
  );
});

test('a named discard parks the commits of a run held at a refused COMPLETE', async (t) => {
  const { git, vars, head, validation } = await fixture(t);
  const held = updateRun(validation.id, {
    status: 'monitoring',
    steps: [{ name: 'complete', status: 'failed' }],
  });
  assert.equal(await parkRunBranchCommits(held, vars, localExec, checks), null, 'not finished');
  const parked = await parkRunBranchCommits(held, vars, localExec, { ...checks, discard: true });
  assert.equal(parked?.headSha, head);
  assert.equal(git('rev-parse', parked!.ref), head);
});

test('only a finished artifact-only dev or fix-bug run parks its branch commits', () => {
  const run = (patch: Partial<Run> = {}) =>
    makeRun({
      completionPolicy: 'artifact-only',
      flowType: 'dev',
      branch: 'b',
      worktreeHeadAtDispatch: 'a'.repeat(40),
      status: 'done',
      ...patch,
    });
  assert.equal(parksBranchCommits(run()), true);
  assert.equal(parksBranchCommits(run({ completionPolicy: 'default' })), false);
  assert.equal(parksBranchCommits(run({ flowType: 'update-branch' })), false);
  // A blind trial's release restores its isolated Git and keeps the candidate branch.
  const blind: Run = {
    ...run(),
    engineState: {
      evalExperiment: {
        experimentId: 'experiment',
        experimentKey: 'key',
        experimentManifestPath: '/eval/manifest.json',
        packagePath: '/eval/package',
        candidateStrategyFingerprint: 'fingerprint',
        trialId: 'trial',
        blind: {
          version: 1,
          baseSha: 'a'.repeat(40),
          problemDigest: 'problem',
          referenceCommits: ['c'.repeat(40)],
          referencePatchId: 'reference-patch',
          forbiddenInputs: [],
          isolation: {
            slotId: 'slot-1',
            slotEpoch: 1,
            capsulePath: '/eval/capsule',
            verifiedAt: '2026-10-30T00:00:00Z',
          },
        },
      },
    },
  };
  assert.equal(parksBranchCommits(blind), false);
  assert.equal(parksBranchCommits(run({ status: 'monitoring', steps: [] })), false);
  assert.equal(
    parksBranchCommits(
      run({ status: 'completing', steps: [{ name: 'complete', status: 'running' }] }),
    ),
    true,
  );
});
