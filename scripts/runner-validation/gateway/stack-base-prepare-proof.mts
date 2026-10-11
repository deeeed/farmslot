// Manual live tier: this linked-worktree prepare case takes over five seconds.
// Run only against an existing owned-session tmux socket; never start or kill a server.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  git,
  needsTmuxSandbox,
  slotPrepare,
  stackFixture,
} from '../../../services/gateway/src/run-engine/stack-base-prepare.test-support.js';

test(
  'a reused linked worktree on the work branch still lands on the stack base',
  needsTmuxSandbox,
  async (t) => {
    const { slotId, slotRepo, upstreamHead } = await stackFixture(t, 'linked', 48834, {
      linkedWorktreeOn: 'feat/stacked',
    });
    const result = await slotPrepare(
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
    assert.equal(result.stackBase?.resolvedSha, upstreamHead);
    assert.equal(await git(slotRepo, 'branch', '--show-current'), 'feat/stacked');
    assert.equal(await git(slotRepo, 'rev-parse', 'HEAD'), upstreamHead);
  },
);
