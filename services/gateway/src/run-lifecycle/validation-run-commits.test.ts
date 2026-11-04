import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import type { ParkedRunCommits, Run } from '@farmslot/protocol';

import type { SlotVars } from '../core/config.js';
import type { execOnSlot } from '../core/exec.js';
import { resetSlotRepoToIdle } from '../methods/slot/slot-tracking.js';
import { makeRun } from '../run-engine/test-fixtures.js';
import { makeVars } from '../runners/test-fixtures.js';
import { createRun, deleteRun, getRun, updateRun } from '../runs/store.js';

import {
  dropParkedBranch,
  parkRunBranchCommits,
  parksBranchCommits,
  parkSlotBranch,
  parkSlotCommits,
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
    ticketOrPr: 'deeeed/farmslot#1769',
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

test('ended runs park attributed commits; only artifact-only code work parks before its end', () => {
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
  assert.equal(parksBranchCommits(run({ completionPolicy: 'default' })), true);
  assert.equal(parksBranchCommits(run({ flowType: 'update-branch' })), true);
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

test("an ownerless slot's unpushed commits are parked under a manual ref before the idle reset", async (t) => {
  const { git, vars, base, head } = await fixture(t);
  // Ownerless work on the idle branch itself: the reset to origin/main would drop it.
  git('checkout', '-q', 'main');
  git('merge', '-q', '--ff-only', 'TAT-4146-validation');
  git('branch', '-q', '-D', 'TAT-4146-validation');
  const parked = await parkSlotCommits(vars, localExec, {
    ...checks,
    headSha: head,
    now: new Date('2026-11-02T10:00:00.000Z'),
  });
  assert.deepEqual(parked, {
    ref: `refs/farmslot/parked/manual-proof-slot-20261102T100000000Z/${head}`,
    branch: 'main',
    commits: 2,
  });
  await resetSlotRepoToIdle(vars, {}, undefined, 'main', { linkedWorktree: false });
  assert.equal(git('rev-parse', 'HEAD'), base, 'the slot is back on origin/main');
  assert.equal(git('rev-parse', parked!.ref), head, 'the parked ref keeps the work');
  assert.equal(git('rev-list', '--count', parked!.ref, '--not', '--remotes'), '2');
  assert.equal((await parkSlotCommits(vars, localExec, { ...checks, headSha: base }))?.commits, 0);
});

test('an ownerless park refuses a head that moved since the inspection', async (t) => {
  const { git, vars, base, head } = await fixture(t);
  assert.equal(await parkSlotCommits(vars, localExec, { ...checks, headSha: base }), null);
  assert.equal(git('for-each-ref', 'refs/farmslot/'), '');
  // A feature branch is parked too and keeps its own name in the report.
  const parked = await parkSlotCommits(vars, localExec, { ...checks, headSha: head });
  assert.equal(parked?.branch, 'TAT-4146-validation');
  assert.equal(parked?.commits, 2);
});

test('an ownerless park names a valid ref for any slot id and never moves an existing one', async (t) => {
  const { git, vars, base, head } = await fixture(t);
  const now = new Date('2026-11-02T10:00:00.000Z');
  const odd = { ...vars, slotId: 'team/a.b..lock' };
  const parked = await parkSlotCommits(odd, localExec, { ...checks, headSha: head, now });
  assert.equal(
    parked?.ref,
    `refs/farmslot/parked/manual-team-a-b-lock-20261102T100000000Z/${head}`,
  );
  git('check-ref-format', parked!.ref);
  // Parking the same head again keeps the same ref, as the run park does.
  assert.deepEqual(
    await parkSlotCommits(odd, localExec, { ...checks, headSha: head, now }),
    parked,
  );
  // A ref already naming another head is never moved: the park refuses before any reset.
  const taken = `refs/farmslot/parked/manual-proof-slot-20261102T100000000Z/${head}`;
  git('update-ref', taken, base);
  await assert.rejects(
    parkSlotCommits(vars, localExec, { ...checks, headSha: head, now }),
    /Cannot park/,
  );
  assert.equal(git('rev-parse', taken), base);
});

test('a detached head already reachable through another remote is still parked', async (t) => {
  const { git, vars, head } = await fixture(t);
  git('push', '-q', 'origin', 'HEAD:topic');
  git('checkout', '-q', '--detach', head);
  const parked = await parkSlotCommits(vars, localExec, { ...checks, headSha: head });
  assert.equal(parked?.commits, 2);
  assert.equal(git('rev-parse', parked!.ref), head);
});

test('a local idle branch with work absent from the current branch is parked too', async (t) => {
  const { git, vars, base, head } = await fixture(t);
  git('checkout', '-q', 'main');
  git('commit', '-qm', 'operator main work', '--allow-empty');
  const main = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'TAT-4146-validation');
  const parked = await parkSlotBranch(vars, localExec, {
    branch: 'main',
    defaultBranch: 'main',
    headSha: head,
  });
  assert.equal(parked?.commits, 1);
  assert.equal(git('rev-parse', parked!.ref), main);
  await resetSlotRepoToIdle(vars, {}, undefined, 'main', {
    linkedWorktree: false,
    expect: { headSha: head, branches: { main } },
  });
  assert.equal(git('rev-parse', 'HEAD'), base);
  assert.equal(git('rev-parse', parked!.ref), main);
});

test('cancelled publishing runs use the same immutable parking receipt', async (t) => {
  const { git, vars, head, validation } = await fixture(t);
  const cancelled = updateRun(validation.id, { status: 'cancelled', completionPolicy: 'default' });
  const parked = await parkRunBranchCommits(cancelled, vars, localExec, checks);
  assert.ok(parked, 'a cancelled publishing run must not leave its commits unparked');
  assert.equal(git('rev-parse', parked.ref), head);
  assert.equal(parked.commits.length, 2);
  assert.deepEqual(getRun(cancelled.id)?.parkedCommits, [parked]);
  await recordReleasedCheckout(cancelled, vars, localExec);
  assert.equal(getRun(cancelled.id)?.releasedCheckout?.headSha, head);
});

test('explicit retention recovers a deleted branch from its recorded review head without changing live work', async (t) => {
  const { git, vars, head, validation } = await fixture(t);
  const ended = updateRun(validation.id, {
    status: 'done',
    completionPolicy: 'default',
    steps: [{ name: 'review', status: 'done', outputs: { reviewSnapshot: { headSha: head } } }],
  });
  git('checkout', '-q', 'main');
  git('branch', '-q', '-D', ended.branch!);
  const note = path.join(vars.remoteRepo, 'unrelated-work.txt');
  await writeFile(note, 'preserve this work\n');
  const before = git('status', '--porcelain');
  const parked = await parkRunBranchCommits(ended, vars, localExec, { ...checks, dataOnly: true });
  assert.ok(parked, 'the recorded old head must remain recoverable after its branch disappears');
  assert.equal(git('rev-parse', parked.ref), head);
  assert.equal(git('branch', '--show-current'), 'main');
  assert.equal(git('status', '--porcelain'), before);
  assert.equal(await readFile(note, 'utf8'), 'preserve this work\n');
  assert.deepEqual(getRun(ended.id)?.parkedCommits, [parked]);
});

test('a later recorded review wins over an older release checkpoint during data-only recovery', async (t) => {
  const { git, vars, base, head, validation } = await fixture(t);
  const ended = updateRun(validation.id, {
    status: 'done',
    completionPolicy: 'default',
    releasedCheckout: {
      slotId: vars.slotId,
      branch: validation.branch!,
      headSha: base,
      at: '2026-10-29T00:00:00.000Z',
    },
    steps: [
      {
        name: 'review',
        status: 'done',
        outputs: { reviewSnapshot: { headSha: head, capturedAt: '2026-10-30T00:00:00.000Z' } },
      },
    ],
  });
  git('checkout', '-q', 'main');
  git('branch', '-q', '-D', ended.branch!);
  const parked = await parkRunBranchCommits(ended, vars, localExec, { ...checks, dataOnly: true });
  assert.equal(parked?.headSha, head);
});

test('data-only backfill preserves divergent review and release histories', async (t) => {
  const { git, vars, base, head, validation } = await fixture(t);
  git('checkout', '-q', '-b', 'other-work', base);
  git('commit', '-q', '--allow-empty', '-m', 'separate checkout lineage');
  const releasedHead = git('rev-parse', 'HEAD');
  const ended = updateRun(validation.id, {
    status: 'done',
    completionPolicy: 'default',
    releasedCheckout: {
      slotId: vars.slotId,
      branch: validation.branch!,
      headSha: releasedHead,
      at: '2026-10-31T00:00:00.000Z',
    },
    steps: [
      {
        name: 'review',
        status: 'done',
        outputs: { reviewSnapshot: { headSha: head, capturedAt: '2026-10-30T00:00:00.000Z' } },
      },
    ],
  });
  git('branch', '-q', '-D', ended.branch!);
  const before = git('rev-parse', 'HEAD');
  await parkRunBranchCommits(ended, vars, localExec, { ...checks, dataOnly: true });
  const records = getRun(ended.id)?.parkedCommits ?? [];
  assert.deepEqual(new Set(records.map((entry) => entry.headSha)), new Set([head, releasedHead]));
  for (const record of records) assert.equal(git('rev-parse', record.ref), record.headSha);
  assert.equal(git('rev-parse', 'HEAD'), before);
  assert.equal(git('branch', '--show-current'), 'other-work');
});

test('historical backfill cannot replace the already parked replay head', async (t) => {
  const { git, vars, base, head, validation } = await fixture(t);
  await parkRunBranchCommits(validation, vars, localExec, checks);
  const ended = updateRun(validation.id, {
    steps: [{ name: 'review', status: 'done', outputs: { reviewSnapshot: { headSha: base } } }],
  });
  git('checkout', '-q', 'main');
  git('branch', '-q', '-D', ended.branch!);
  await parkRunBranchCommits(ended, vars, localExec, { ...checks, dataOnly: true });
  const retained = getRun(ended.id)!;
  assert.equal(retained.parkedCommits?.length, 2);
  assert.equal(
    (await restoreParkedBranch(retained, vars, ended.branch!, localExec))?.headSha,
    head,
  );
});

test('historical retention never attributes an unrecorded reused branch to the old run', async (t) => {
  const { git, vars, head, validation } = await fixture(t);
  const ended = updateRun(validation.id, {
    steps: [{ name: 'review', status: 'done', outputs: { reviewSnapshot: { headSha: head } } }],
  });
  git('commit', '-q', '--allow-empty', '-m', 'new owner work on reused branch');
  const foreign = git('rev-parse', 'HEAD');
  await parkRunBranchCommits(ended, vars, localExec, { ...checks, dataOnly: true });
  assert.deepEqual(
    getRun(ended.id)?.parkedCommits?.map((entry) => entry.headSha),
    [head],
  );
  assert.equal(git('rev-parse', 'HEAD'), foreign);
  git('checkout', '-q', 'main');
  git('branch', '-q', '-D', ended.branch!);
  assert.equal(
    (await restoreParkedBranch(getRun(ended.id), vars, ended.branch!, localExec))?.headSha,
    head,
  );
});
