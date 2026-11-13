// Opt-in real Git linked-worktree proof; exceeds the default per-test budget.
import assert from 'node:assert/strict';
import { test } from 'node:test';

// The shared fixture calls mock.module(...) and needs the module-mock test lane.
import {
  git,
  needsTmuxSandbox,
  slotPrepare,
  stackFixture,
} from './stack-base-prepare.test-support.js';

test(
  'a reused linked worktree parks unpublished work before using the stack base',
  needsTmuxSandbox,
  async (t) => {
    const { slotId, slotRepo, upstreamHead } = await stackFixture(t, 'linked', 48834, {
      linkedWorktreeOn: 'feat/stacked',
    });
    const head = await git(slotRepo, 'rev-parse', 'HEAD');
    await slotPrepare(
      {
        slotId,
        branch: 'feat/stacked',
        prepareProfile: 'core',
        flowType: 'fix-bug',
        forceNewBranch: true,
      },
      () => undefined,
      undefined,
      { stackBase: { requestedRef: 'refs/heads/feat/upstream' } },
    );
    assert.equal(await git(slotRepo, 'branch', '--show-current'), 'feat/stacked');
    assert.equal(await git(slotRepo, 'rev-parse', 'HEAD'), upstreamHead);
    const retained = await git(
      slotRepo,
      'for-each-ref',
      '--format=%(objectname)',
      'refs/farmslot/parked/',
    );
    assert.ok(
      retained.split('\n').includes(head),
      'the original unpublished head remains reachable',
    );
  },
);
