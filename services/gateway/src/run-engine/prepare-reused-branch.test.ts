import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import '../core/private-pool.test-support.js';

// The shared fixture calls mock.module(...) and needs the module-mock test lane.
import {
  git,
  needsTmuxSandbox,
  slotPrepare,
  stackFixture,
} from './stack-base-prepare.test-support.js';

/** A commit on `branch` that no remote has, left by an earlier run; the slot is back on main. */
async function leaveUnpushedCommit(
  slotRepo: string,
  branch: string,
  { pushFirst = false, stay = false } = {},
) {
  await git(slotRepo, 'checkout', '-b', branch);
  if (pushFirst) {
    await writeFile(path.join(slotRepo, 'pushed.txt'), 'pushed\n');
    await git(slotRepo, 'add', 'pushed.txt');
    await git(slotRepo, 'commit', '-m', 'pushed work');
    await git(slotRepo, 'push', 'origin', branch);
  }
  await writeFile(path.join(slotRepo, 'fix.txt'), 'the only copy of a fix\n');
  await git(slotRepo, 'add', 'fix.txt');
  await git(slotRepo, 'commit', '-m', 'unpushed fix');
  const sha = await git(slotRepo, 'rev-parse', 'HEAD');
  if (!stay) await git(slotRepo, 'checkout', 'main');
  return sha;
}

/** The local branches holding `sha`. */
async function branchesWith(slotRepo: string, sha: string) {
  return (await git(slotRepo, 'branch', '--format=%(refname:short)', '--contains', sha))
    .split('\n')
    .filter(Boolean);
}

test(
  'a new run reusing a local-only branch name keeps its unpushed commits on a branch',
  needsTmuxSandbox,
  async (t) => {
    const { slotId, slotRepo, mainHead } = await stackFixture(t, 'reuse-local', 48840);
    const branch = 'TAT-1-fix-reused';
    const fix = await leaveUnpushedCommit(slotRepo, branch);
    const events: unknown[] = [];
    await slotPrepare(
      { slotId, branch, prepareProfile: 'core', flowType: 'fix-bug', forceNewBranch: true },
      (_event, payload) => events.push(payload),
    );
    assert.equal(await git(slotRepo, 'branch', '--show-current'), branch);
    assert.equal(await git(slotRepo, 'rev-parse', 'HEAD'), mainHead, 'the new run starts fresh');
    const kept = `${branch}-kept-${fix.slice(0, 12)}`;
    assert.deepEqual(await branchesWith(slotRepo, fix), [kept]);
    assert.match(
      JSON.stringify(events),
      new RegExp(`Kept unpushed commits of ${branch} on ${kept}`),
    );
  },
);

test(
  'a new run resetting a published branch keeps the local commits ahead of origin',
  needsTmuxSandbox,
  async (t) => {
    const { slotId, slotRepo } = await stackFixture(t, 'reuse-ahead', 48842);
    const branch = 'TAT-2-feat-ahead';
    const fix = await leaveUnpushedCommit(slotRepo, branch, { pushFirst: true });
    const published = await git(slotRepo, 'rev-parse', `origin/${branch}`);
    await slotPrepare(
      { slotId, branch, prepareProfile: 'core', flowType: 'dev', forceNewBranch: false },
      () => undefined,
    );
    assert.equal(await git(slotRepo, 'rev-parse', 'HEAD'), published, 'reset to origin as before');
    assert.deepEqual(await branchesWith(slotRepo, fix), [`${branch}-kept-${fix.slice(0, 12)}`]);
  },
);

test(
  'a prepare already on a published branch keeps the local commits ahead of origin',
  needsTmuxSandbox,
  async (t) => {
    const { slotId, slotRepo } = await stackFixture(t, 'reuse-current', 48844);
    const branch = 'TAT-3-feat-current';
    const fix = await leaveUnpushedCommit(slotRepo, branch, { pushFirst: true, stay: true });
    const published = await git(slotRepo, 'rev-parse', `origin/${branch}`);
    await slotPrepare(
      { slotId, branch, prepareProfile: 'core', flowType: 'dev', forceNewBranch: false },
      () => undefined,
    );
    assert.equal(await git(slotRepo, 'rev-parse', 'HEAD'), published, 'reset to origin as before');
    assert.deepEqual(await branchesWith(slotRepo, fix), [`${branch}-kept-${fix.slice(0, 12)}`]);
  },
);

test(
  'a prepare resetting a local branch to its start ref keeps the commits beyond it',
  needsTmuxSandbox,
  async (t) => {
    const { slotId, slotRepo, mainHead } = await stackFixture(t, 'reuse-start', 48846);
    const branch = 'TAT-4-fix-start';
    const fix = await leaveUnpushedCommit(slotRepo, branch);
    await slotPrepare(
      { slotId, branch, prepareProfile: 'core', flowType: 'fix-bug', forceNewBranch: false },
      () => undefined,
      undefined,
      { startRef: { requestedRef: mainHead } },
    );
    assert.equal(await git(slotRepo, 'rev-parse', 'HEAD'), mainHead, 'reset to the start ref');
    assert.deepEqual(await branchesWith(slotRepo, fix), [`${branch}-kept-${fix.slice(0, 12)}`]);
  },
);

test(
  'a reused branch with nothing unpushed is recreated without keeping a copy',
  needsTmuxSandbox,
  async (t) => {
    const { slotId, slotRepo, mainHead } = await stackFixture(t, 'reuse-clean', 48848);
    const branch = 'TAT-5-fix-clean';
    await git(slotRepo, 'branch', branch, 'origin/main');
    await slotPrepare(
      { slotId, branch, prepareProfile: 'core', flowType: 'fix-bug', forceNewBranch: true },
      () => undefined,
    );
    assert.equal(await git(slotRepo, 'rev-parse', 'HEAD'), mainHead);
    assert.deepEqual((await branchesWith(slotRepo, mainHead)).sort(), [branch, 'main'].sort());
  },
);
